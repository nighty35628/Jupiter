import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { HostFileRef, WorkspaceRegistry } from "./workspaces.js";

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_FILES = 100;

export interface UploadStoreOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}

export interface UploadResult {
  file: HostFileRef;
  sha256: string;
}

/** Process-lifetime upload quarantine. Files are never interpreted or executed here. */
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
  ) {}

  static async create(
    workspaces: WorkspaceRegistry,
    opts: UploadStoreOptions = {},
  ): Promise<UploadStore> {
    const root = await mkdtemp(join(tmpdir(), "jupiter-web-uploads-"));
    return new UploadStore(
      root,
      workspaces,
      opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      opts.maxFiles ?? DEFAULT_MAX_FILES,
    );
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
    const absolutePath = join(this.root, randomUUID());
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const hash = createHash("sha256");
    let size = 0;
    try {
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
      await handle.close();
      this.assertOpen();

      const metadata = await stat(absolutePath);
      const file = this.workspaces.registerRuntimeFile(absolutePath, {
        source: "upload",
        name,
        mime: normalizeMime(mime),
        size: metadata.size,
        modifiedMs: metadata.mtimeMs,
        lifecycle: "runtime",
      });
      this.fileCount += 1;
      this.totalBytes += metadata.size;
      return { file, sha256: hash.digest("hex") };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(absolutePath).catch(() => undefined);
      throw error;
    } finally {
      this.reservedBytes -= reserved;
      this.reservedFiles--;
    }
  }

  async remove(fileId: string): Promise<boolean> {
    const record = this.workspaces.forgetFile(fileId);
    if (!record || record.ref.source !== "upload") return false;
    await unlink(record.absolutePath).catch(() => undefined);
    this.fileCount = Math.max(0, this.fileCount - 1);
    this.totalBytes = Math.max(0, this.totalBytes - record.ref.size);
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await rm(this.root, { recursive: true, force: true });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("upload store is closed");
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
