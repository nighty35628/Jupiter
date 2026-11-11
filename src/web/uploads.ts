import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { HostFileRef, WorkspaceRegistry } from "./workspaces.js";

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_FILES = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_METADATA_BYTES = 4096;
const storedUpload = z
  .object({
    version: z.literal(1),
    id: z.string().regex(UUID),
    name: z.string().min(1).max(240),
    mime: z.string().max(1024).optional(),
    size: z.number().int().nonnegative(),
    modifiedMs: z.number().finite().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
type StoredUpload = z.infer<typeof storedUpload>;

export interface UploadStoreOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  /** Internal host option, never supplied by HTTP clients. One host owns this directory. */
  persistentRoot?: string;
}

export interface UploadResult {
  file: HostFileRef;
  sha256: string;
}

/** Quarantine: 100 files / 500 MiB total / 100 MiB each, including Android-restored uploads. */
export class UploadStore {
  private totalBytes = 0;
  private fileCount = 0;
  private reservedBytes = 0;
  private reservedFiles = 0;
  private closed = false;

  private constructor(
    private readonly root: string,
    private readonly workspaces: WorkspaceRegistry,
    private readonly maxFileBytes: number,
    private readonly maxTotalBytes: number,
    private readonly maxFiles: number,
    private readonly persistent: boolean,
    private readonly identity: { dev: number; ino: number },
  ) {}

  static async create(
    workspaces: WorkspaceRegistry,
    opts: UploadStoreOptions = {},
  ): Promise<UploadStore> {
    if (opts.persistentRoot !== undefined && !isAbsolute(opts.persistentRoot))
      throw new Error("persistent upload root must be absolute");
    const root = opts.persistentRoot
      ? resolve(opts.persistentRoot)
      : await realpath(await mkdtemp(join(tmpdir(), "jupiter-web-uploads-")));
    const identity = await safeDirectory(root, opts.persistentRoot !== undefined);
    const store = new UploadStore(
      root,
      workspaces,
      opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      opts.maxFiles ?? DEFAULT_MAX_FILES,
      opts.persistentRoot !== undefined,
      identity,
    );
    if (store.persistent) await store.restore();
    return store;
  }

  async receive(
    originalName: string,
    mime: string | undefined,
    body: AsyncIterable<unknown>,
    declaredBytes?: number,
  ): Promise<UploadResult> {
    this.assertOpen();
    if (this.fileCount + this.reservedFiles >= this.maxFiles)
      throw new Error("upload file limit reached");
    if (declaredBytes !== undefined) {
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
        throw new Error("invalid Content-Length");
      }
      if (declaredBytes > this.maxFileBytes) throw new Error("upload is too large");
      if (this.totalBytes + this.reservedBytes + declaredBytes > this.maxTotalBytes) {
        throw new Error("upload quota exceeded");
      }
    }
    const reserved = declaredBytes ?? this.maxFileBytes;
    if (this.totalBytes + this.reservedBytes + reserved > this.maxTotalBytes)
      throw new Error("upload quota exceeded");
    this.reservedBytes += reserved;
    this.reservedFiles++;
    const name = safeDisplayName(originalName);
    const id = randomUUID();
    const staging = join(this.root, `.staging-${id}`);
    const committed = join(this.root, id);
    const absolutePath = this.persistent ? join(staging, "blob") : join(this.root, id);
    let didCommit = false;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const hash = createHash("sha256");
    let size = 0;
    try {
      await this.assertRoot();
      if (this.persistent) await mkdir(staging, { mode: 0o700 });
      handle = await open(absolutePath, "wx", 0o600);
      for await (const raw of body) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        size += chunk.length;
        if (size > this.maxFileBytes || size > reserved) {
          throw new Error(
            size > this.maxFileBytes ? "upload is too large" : "upload quota exceeded",
          );
        }
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
      if (declaredBytes !== undefined && size !== declaredBytes)
        throw new Error("upload ended before Content-Length");
      if (this.persistent) await handle.sync();
      const metadata = await handle.stat();
      await handle.close();
      handle = undefined;
      this.assertOpen();
      const sha256 = hash.digest("hex");
      const record = storedUpload.parse({
        version: 1,
        id,
        name,
        mime: normalizeMime(mime),
        size,
        modifiedMs: metadata.mtimeMs,
        sha256,
      });
      if (this.persistent) {
        const bytes = Buffer.from(JSON.stringify(record));
        if (bytes.length > MAX_METADATA_BYTES) throw new Error("upload metadata is too large");
        const manifest = await open(join(staging, "meta.json"), "wx", 0o600);
        try {
          await manifest.writeFile(bytes);
          await manifest.sync();
        } finally {
          await manifest.close();
        }
        await syncDirectory(staging);
        await this.assertRoot();
        this.assertOpen();
        await rename(staging, committed);
        didCommit = true;
        await syncDirectory(this.root);
        this.assertOpen();
      }
      const file = this.workspaces.registerRuntimeFile(
        this.persistent ? join(committed, "blob") : absolutePath,
        {
          source: "upload",
          name,
          mime: normalizeMime(mime),
          size: metadata.size,
          modifiedMs: metadata.mtimeMs,
          lifecycle: this.persistent ? "session" : "runtime",
        },
        id,
      );
      this.fileCount += 1;
      this.totalBytes += metadata.size;
      return { file, sha256 };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (this.persistent) {
        await this.cleanup(didCommit ? committed : staging);
      } else await unlink(absolutePath).catch(() => undefined);
      throw error;
    } finally {
      this.reservedBytes -= reserved;
      this.reservedFiles--;
    }
  }

  async remove(fileId: string): Promise<boolean> {
    let record: ReturnType<WorkspaceRegistry["resolveFile"]>;
    try {
      record = this.workspaces.resolveFile(fileId);
    } catch {
      return false;
    }
    if (record.ref.source !== "upload") return false;
    await this.assertRoot();
    if (this.persistent) {
      if (!UUID.test(fileId) || record.absolutePath !== join(this.root, fileId, "blob"))
        return false;
      await safeDirectory(join(this.root, fileId), false);
      const staging = join(this.root, `.staging-${fileId}`);
      await rename(join(this.root, fileId), staging);
      await syncDirectory(this.root);
      await this.cleanup(staging);
    } else {
      if (dirname(record.absolutePath) !== this.root) return false;
      await unlink(record.absolutePath);
    }
    this.workspaces.forgetFile(fileId);
    this.fileCount = Math.max(0, this.fileCount - 1);
    this.totalBytes = Math.max(0, this.totalBytes - record.ref.size);
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.persistent) await rm(this.root, { recursive: true, force: true });
  }

  private async assertRoot(): Promise<void> {
    const current = await safeDirectory(this.root, false);
    if (current.dev !== this.identity.dev || current.ino !== this.identity.ino)
      throw new Error("upload directory changed");
  }

  private async cleanup(path: string): Promise<void> {
    try {
      await this.assertRoot();
      await rm(path, { recursive: true, force: true });
    } catch {
      /* Never traverse an unsafe parent to clean up an upload. */
    }
  }

  private async restore(): Promise<void> {
    const records: StoredUpload[] = [];
    let totalBytes = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.name.startsWith(".staging-") && UUID.test(entry.name.slice(9))) {
        await this.cleanup(join(this.root, entry.name));
        continue;
      }
      if (!UUID.test(entry.name) || !entry.isDirectory())
        throw new Error("Invalid persistent upload entry");
      await this.assertRoot();
      const directory = join(this.root, entry.name);
      await safeDirectory(directory, false);
      const manifest = await openRegular(join(directory, "meta.json"));
      let record: StoredUpload;
      try {
        const bytes = Buffer.alloc(MAX_METADATA_BYTES + 1);
        let count = 0;
        while (count < bytes.length) {
          const { bytesRead } = await manifest.read(bytes, count, bytes.length - count, null);
          if (!bytesRead) break;
          count += bytesRead;
        }
        if (count > MAX_METADATA_BYTES) throw new Error("upload metadata is too large");
        record = storedUpload.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count))),
        );
      } finally {
        await manifest.close();
      }
      if (
        record.id !== entry.name ||
        record.name !== safeDisplayName(record.name) ||
        record.mime !== normalizeMime(record.mime) ||
        record.size > this.maxFileBytes
      )
        throw new Error("Invalid persistent upload metadata");
      totalBytes += record.size;
      if (records.length >= this.maxFiles || totalBytes > this.maxTotalBytes)
        throw new Error("persistent upload quota exceeded");
      const blob = await openRegular(join(directory, "blob"));
      try {
        if ((await blob.stat()).size !== record.size)
          throw new Error("persistent upload size changed");
        const hash = createHash("sha256");
        let size = 0;
        for await (const chunk of blob.createReadStream({ autoClose: false })) {
          size += chunk.length;
          if (size > record.size) throw new Error("persistent upload size changed");
          hash.update(chunk);
        }
        if (size !== record.size || hash.digest("hex") !== record.sha256)
          throw new Error("persistent upload content changed");
      } finally {
        await blob.close();
      }
      records.push(record);
    }
    const registered: string[] = [];
    try {
      for (const record of records) {
        this.workspaces.registerRuntimeFile(
          join(this.root, record.id, "blob"),
          {
            source: "upload",
            name: record.name,
            mime: record.mime,
            size: record.size,
            modifiedMs: record.modifiedMs,
            lifecycle: "session",
          },
          record.id,
        );
        registered.push(record.id);
      }
    } catch (error) {
      for (const id of registered) this.workspaces.forgetFile(id);
      throw error;
    }
    this.totalBytes = totalBytes;
    this.fileCount = records.length;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("upload store is closed");
  }
}

async function safeDirectory(path: string, create: boolean) {
  const root = parse(path).root;
  let current = root;
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (create) {
      try {
        await mkdir(current, { mode: 0o700 });
        await syncDirectory(dirname(current));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (!(await lstat(current)).isDirectory()) throw new Error("unsafe upload directory");
  }
  if ((await realpath(path)) !== path) throw new Error("unsafe upload parent");
  return lstat(path);
}

async function openRegular(path: string) {
  await safeDirectory(dirname(path), false);
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1) throw new Error("unsafe upload file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      (await realpath(path)) !== path
    )
      throw new Error("upload file changed while opening");
    await safeDirectory(dirname(path), false);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function safeDisplayName(value: string): string {
  let cleaned = "";
  for (const character of basename(value.trim())) {
    const code = character.charCodeAt(0);
    if (code > 0x1f && code !== 0x7f) cleaned += character;
  }
  const name = cleaned.slice(0, 240);
  return name || "upload";
}

function normalizeMime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const mime = value.split(";", 1)[0]?.trim().toLowerCase();
  return mime && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : undefined;
}
