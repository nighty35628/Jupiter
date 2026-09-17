import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type EncodedImage, encodeImage } from "./codec.js";
import {
  IMAGE_ID_PATTERN,
  type ImageAttachment,
  MAX_IMAGE_INPUT_BYTES,
  MAX_MESSAGE_IMAGES,
  imageIdFromToken,
  isImageAttachment,
} from "./types.js";

export const DEFAULT_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;
const OBJECT_VERSION = 1;
const ORPHAN_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredImage {
  version: number;
  attachment: ImageAttachment;
  thumbnailMime: string;
  thumbnailBytes: number;
}

export function attachmentRoot(): string {
  return join(homedir(), ".jupiter", "attachments", "v1");
}

export function safeImageName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip control characters from untrusted filenames.
  const controls = /[\x00-\x1f\x7f]/g;
  return basename(name.replace(/\\/g, "/")).replace(controls, "").slice(0, 240) || "image";
}

/** Verify and read one inode; callers must only supply roots already authorized by their surface. */
export async function readImageSnapshot(
  path: string,
  roots?: readonly string[],
): Promise<Uint8Array> {
  const actual = await realpath(path);
  if (roots?.length) {
    const allowed = await Promise.all(roots.map((root) => realpath(root)));
    if (
      !allowed.some((root) => {
        const rel = relative(root, actual);
        return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
      })
    )
      throw new Error("Image is outside the authorized workspace");
  }
  const before = await stat(actual);
  const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Image changed while opening");
    if (opened.size <= 0 || opened.size > MAX_IMAGE_INPUT_BYTES)
      throw new Error("Image must be between 1 byte and 20 MiB");
    if ((await realpath(path)) !== actual) throw new Error("Image path changed while opening");
    // A bounded read also protects against a file growing after fstat.
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
      throw new Error("Image changed while reading");
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export class AttachmentStore {
  constructor(
    readonly root = attachmentRoot(),
    readonly maxBytes = DEFAULT_ATTACHMENT_BYTES,
  ) {}

  private objectPath(id: string): string {
    if (!IMAGE_ID_PATTERN.test(id)) throw new Error("Invalid image attachment id");
    return join(this.root, "objects", id);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = join(this.root, "write.lock");
    for (let attempt = 0; ; attempt++) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt >= 100) throw new Error("Image storage is busy; retry shortly");
        const info = await stat(lock).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 120_000)
          await rm(lock, { recursive: true, force: true });
        await delay(50);
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async importBytes(
    bytes: Uint8Array,
    name: string,
    signal?: AbortSignal,
  ): Promise<ImageAttachment> {
    if (!bytes.length || bytes.length > MAX_IMAGE_INPUT_BYTES)
      throw new Error("Image exceeds the 20 MiB limit");
    const encoded = await encodeImage(bytes, "canonical", signal);
    signal?.throwIfAborted();
    const id = createHash("sha256").update(encoded.image.data).digest("hex");
    const attachment: ImageAttachment = {
      kind: "image",
      id,
      name: safeImageName(name),
      mime: encoded.image.mime,
      bytes: encoded.image.data.length,
      width: encoded.image.width,
      height: encoded.image.height,
      originalWidth: encoded.originalWidth,
      originalHeight: encoded.originalHeight,
      ...(encoded.staticFrame ? { staticFrame: true } : {}),
    };
    await this.withLock(async () => {
      signal?.throwIfAborted();
      if (await this.metadata(id).catch(() => null)) {
        await this.touch(id);
        return;
      }
      const objects = join(this.root, "objects");
      await mkdir(objects, { recursive: true, mode: 0o700 });
      let used = 0;
      for (const entry of await readdir(objects)) {
        if (!IMAGE_ID_PATTERN.test(entry)) continue;
        const info = await this.metadata(entry);
        used += info.attachment.bytes + info.thumbnailBytes + 1_500_000;
      }
      if (used + attachment.bytes + encoded.thumbnail!.data.length + 1_500_000 > this.maxBytes)
        throw new Error("Image storage quota exceeded; remove unused attachments before retrying");
      const temporary = join(this.root, `pending-${randomUUID()}`);
      await mkdir(temporary, { mode: 0o700 });
      try {
        await durableWrite(join(temporary, "image"), encoded.image.data);
        await durableWrite(join(temporary, "thumbnail"), encoded.thumbnail!.data);
        const metadata: StoredImage = {
          version: OBJECT_VERSION,
          attachment,
          thumbnailMime: encoded.thumbnail!.mime,
          thumbnailBytes: encoded.thumbnail!.data.length,
        };
        await durableWrite(join(temporary, "meta.json"), JSON.stringify(metadata));
        await rename(temporary, this.objectPath(id));
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
    return attachment;
  }

  async importPath(
    path: string,
    roots?: readonly string[],
    signal?: AbortSignal,
  ): Promise<ImageAttachment> {
    const id = imageIdFromToken(path);
    if (id) return this.get(id);
    return this.importBytes(await readImageSnapshot(path, roots), basename(path), signal);
  }

  private async metadata(id: string): Promise<StoredImage> {
    const object = this.objectPath(id);
    if ((await realpath(object)) !== join(await realpath(this.root), "objects", id))
      throw new Error("Image object path is not immutable");
    const path = join(this.objectPath(id), "meta.json");
    const info = await stat(path);
    if (!info.isFile() || info.size > 4096) throw new Error("Invalid image metadata");
    const data: StoredImage = JSON.parse(await readFile(path, "utf8"));
    if (
      data.version !== OBJECT_VERSION ||
      !isImageAttachment(data.attachment) ||
      data.attachment.id !== id ||
      !Number.isSafeInteger(data.thumbnailBytes) ||
      data.thumbnailBytes <= 0 ||
      data.thumbnailBytes > 128 * 1024 ||
      !["image/jpeg", "image/webp", "image/png"].includes(data.thumbnailMime)
    )
      throw new Error("Invalid image metadata");
    return data;
  }

  async get(id: string): Promise<ImageAttachment> {
    const image = (await this.metadata(id)).attachment;
    await this.read(id);
    await this.touch(id);
    return { ...image };
  }

  private async touch(id: string): Promise<void> {
    const now = new Date();
    await utimes(this.objectPath(id), now, now);
  }

  async read(
    id: string,
    thumbnail = false,
  ): Promise<{ bytes: Uint8Array; mime: string; name: string }> {
    const metadata = await this.metadata(id);
    const expected = thumbnail ? metadata.thumbnailBytes : metadata.attachment.bytes;
    const file = join(this.objectPath(id), thumbnail ? "thumbnail" : "image");
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== expected)
        throw new Error("Image attachment is missing or corrupted");
      const bytes = Buffer.alloc(expected + 1);
      let length = 0;
      while (length < bytes.length) {
        const part = await handle.read(bytes, length, bytes.length - length, length);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      if (length !== expected) throw new Error("Image attachment changed while reading");
      const result = bytes.subarray(0, length);
      if (!thumbnail && createHash("sha256").update(result).digest("hex") !== id)
        throw new Error("Image attachment failed integrity verification");
      return {
        bytes: result,
        mime: thumbnail ? metadata.thumbnailMime : metadata.attachment.mime,
        name: metadata.attachment.name,
      };
    } finally {
      await handle.close();
    }
  }

  async requestImage(id: string, signal?: AbortSignal): Promise<EncodedImage> {
    const original = await this.read(id);
    const variantPath = join(this.objectPath(id), "request-v1.json");
    // Request pixels are cached on disk, not in the session or an unbounded memory map.
    const variantSize = await stat(variantPath)
      .then((value) => value.size)
      .catch(() => 0);
    const cached =
      variantSize > 0 && variantSize < 1_500_000
        ? await readFile(variantPath, "utf8").catch(() => null)
        : null;
    if (cached && cached.length < 1_500_000) {
      try {
        const value = JSON.parse(cached);
        const data = Buffer.from(value.data, "base64");
        if (
          typeof value.digest === "string" &&
          createHash("sha256").update(data).digest("hex") === value.digest &&
          data.length > 0 &&
          data.length <= 1024 * 1024 &&
          ["image/jpeg", "image/webp"].includes(value.mime) &&
          Number.isInteger(value.width) &&
          Number.isInteger(value.height) &&
          value.width > 0 &&
          value.height > 0 &&
          value.width * value.height <= 640000 &&
          value.width <= 4096 &&
          value.height <= 4096
        )
          return { ...value, data };
      } catch {
        /* Regenerate a stale or interrupted cache entry. */
      }
    }
    const image = (await encodeImage(original.bytes, "request", signal)).image;
    const temporary = `${variantPath}.${randomUUID()}.tmp`;
    try {
      await durableWrite(
        temporary,
        JSON.stringify({
          ...image,
          data: Buffer.from(image.data).toString("base64"),
          digest: createHash("sha256").update(image.data).digest("hex"),
        }),
      );
      await rename(temporary, variantPath);
    } finally {
      await rm(temporary, { force: true });
    }
    return image;
  }

  async resolveAll(
    paths: readonly string[],
    rootDir: string,
    signal?: AbortSignal,
  ): Promise<ImageAttachment[]> {
    if (
      !Array.isArray(paths) ||
      paths.some((path) => typeof path !== "string" || path.length > 4096)
    )
      throw new Error("Invalid image attachment references");
    if (paths.length > MAX_MESSAGE_IMAGES)
      throw new Error(`At most ${MAX_MESSAGE_IMAGES} images can be sent at once`);
    const images: ImageAttachment[] = [];
    for (const path of paths) {
      signal?.throwIfAborted();
      images.push(
        await this.importPath(
          imageIdFromToken(path) ? path : resolve(rootDir, path),
          undefined,
          signal,
        ),
      );
    }
    return images;
  }

  /** Only proven orphans are removed. Any unreadable recovery record disables deletion. */
  async collectGarbage(
    sessionsRoot: string,
    extraRetained: ReadonlySet<string> = new Set(),
  ): Promise<number> {
    return (await this.inspectGarbage(sessionsRoot, extraRetained, true)).count;
  }

  async saveDraftReferences(owner: string, revision: number, ids: string[]): Promise<void> {
    if (
      !/^[a-f0-9-]{36}$/.test(owner) ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      !Array.isArray(ids) ||
      ids.length > 8192 ||
      ids.some((id) => !IMAGE_ID_PATTERN.test(id))
    )
      throw new Error("Invalid image draft references");
    await this.withLock(async () => {
      const directory = join(this.root, "drafts");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${owner}.json`);
      const previous = await readFile(path, "utf8")
        .then((text) => JSON.parse(text))
        .catch(() => null);
      if (previous && previous.revision >= revision) return;
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await durableWrite(
          temporary,
          JSON.stringify({
            revision,
            images: [...new Set(ids)].map((id) => `jupiter-image:${id}`),
          }),
        );
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  async inspectGarbage(
    sessionsRoot: string,
    extraRetained: ReadonlySet<string> = new Set(),
    remove = false,
  ): Promise<{ count: number; bytes: number }> {
    return this.withLock(async () => {
      const retained = new Set(extraRetained);
      const scan = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isSymbolicLink()) throw new Error("Unknown session recovery reference");
          if (entry.isDirectory()) {
            await scan(path);
            continue;
          }
          if (!/\.(jsonl|json)(\.bak)?$/.test(entry.name)) continue;
          const info = await stat(path);
          if (info.size > 128 * 1024 * 1024)
            throw new Error("Session too large to safely collect attachment references");
          const text = await readFile(path, "utf8");
          const visit = (value: unknown): void => {
            if (typeof value === "string") {
              const id = imageIdFromToken(value);
              if (id) retained.add(id);
              return;
            }
            if (isImageAttachment(value)) retained.add(value.id);
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === "object") Object.values(value).forEach(visit);
          };
          if (/\.jsonl(\.bak)?$/.test(entry.name)) {
            for (const line of text.split("\n")) if (line.trim()) visit(JSON.parse(line));
          } else visit(JSON.parse(text));
        }
      };
      try {
        await scan(sessionsRoot);
        if (await stat(join(this.root, "drafts")).catch(() => null))
          await scan(join(this.root, "drafts"));
      } catch {
        return { count: 0, bytes: 0 };
      }
      let removed = 0;
      let bytes = 0;
      for (const id of await readdir(join(this.root, "objects")).catch(() => [])) {
        if (!IMAGE_ID_PATTERN.test(id) || retained.has(id)) continue;
        const path = this.objectPath(id);
        if (Date.now() - (await stat(path)).mtimeMs < ORPHAN_GRACE_MS) continue;
        const info = await this.metadata(id);
        const variant = await stat(join(path, "request-v1.json")).catch(() => null);
        bytes += info.attachment.bytes + info.thumbnailBytes + (variant?.size ?? 0);
        if (remove) await rm(path, { recursive: true });
        removed++;
      }
      return { count: removed, bytes };
    });
  }
}

async function durableWrite(path: string, bytes: string | Uint8Array): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

export const attachments = new AttachmentStore();
