import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachmentRoot } from "./store.js";

export class FilesUnavailable extends Error {}
interface FileEntry {
  id: string;
  expiresAt: number;
  bytes: number;
}
interface UploadFlight {
  controller: AbortController;
  users: number;
  promise: Promise<FileEntry>;
}
const flights = new Map<string, UploadFlight>();

export class ImageFileCache {
  readonly scope: string;
  private readonly directory: string;
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      fetch: typeof fetch;
      root?: string;
    },
  ) {
    this.scope = createHash("sha256").update(`${options.baseUrl}\0${options.apiKey}`).digest("hex");
    this.directory = join(options.root ?? attachmentRoot(), "remote-files", this.scope);
  }

  async resolve(data: Uint8Array, mime: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const digest = createHash("sha256").update(data).digest("hex");
    const path = join(this.directory, `${digest}.json`);
    try {
      if ((await stat(path)).size < 4096) {
        const entry: FileEntry = JSON.parse(await readFile(path, "utf8"));
        if (
          /^file-[a-zA-Z0-9_-]+$/.test(entry.id) &&
          entry.bytes === data.length &&
          entry.expiresAt > Date.now() + 3600_000
        )
          return entry.id;
      }
    } catch {
      /* Missing/expired mappings are regenerated without changing message history. */
    }
    const key = `${this.scope}:${digest}`;
    let flight = flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      flight = {
        controller,
        users: 0,
        promise: this.upload(data, mime, controller.signal)
          .then(async (entry) => {
            await mkdir(this.directory, { recursive: true, mode: 0o700 });
            const temporary = `${path}.${randomUUID()}.tmp`;
            try {
              await writeFile(temporary, JSON.stringify(entry), { flag: "wx", mode: 0o600 });
              await rename(temporary, path);
            } finally {
              await rm(temporary, { force: true });
            }
            return entry;
          })
          .finally(() => {
            flights.delete(key);
          }),
      };
      flights.set(key, flight);
    }
    const shared = flight;
    shared.users++;
    try {
      const entry = await new Promise<FileEntry>((resolve, reject) => {
        const abort = () => reject(new DOMException("Image upload cancelled", "AbortError"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        shared.promise
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener("abort", abort));
      });
      return entry.id;
    } finally {
      shared.users--;
      if (shared.users === 0) shared.controller.abort();
    }
  }

  async invalidate(): Promise<void> {
    // Only our cache mappings are invalidated; never delete unrelated files from a provider account.
    await rm(this.directory, { recursive: true, force: true });
  }

  private async upload(data: Uint8Array, mime: string, signal: AbortSignal): Promise<FileEntry> {
    const form = new FormData();
    form.append("purpose", "user_data");
    form.append("expires_after[anchor]", "created_at");
    form.append("expires_after[seconds]", "604800");
    const copy = Uint8Array.from(data);
    form.append(
      "file",
      new Blob([copy.buffer], { type: mime }),
      mime === "image/webp" ? "jupiter-image.webp" : "jupiter-image.jpg",
    );
    let response: Response;
    try {
      response = await this.options.fetch(`${this.options.baseUrl}/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch (error) {
      if (signal.aborted) throw new DOMException("Image upload cancelled", "AbortError");
      throw new FilesUnavailable("Image upload unavailable; using inline images");
    }
    if ([404, 405, 408, 500, 502, 503, 504, 501].includes(response.status)) {
      await response.body?.cancel();
      throw new FilesUnavailable("Files API is not available");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`Image upload failed (HTTP ${response.status})`), {
        status: response.status,
      });
    }
    const value = (await response.json()) as Record<string, unknown>;
    if (
      typeof value.id !== "string" ||
      !/^file-[a-zA-Z0-9_-]+$/.test(value.id) ||
      value.bytes !== data.length
    )
      throw new Error("Invalid Files API upload response");
    const expiresAt =
      typeof value.expires_at === "number" ? value.expires_at * 1000 : Date.now() + 604800_000;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
      throw new Error("Files API returned an expired file");
    return { id: value.id, expiresAt, bytes: data.length };
  }
}

export async function isExpiredImageResponse(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 404) return false;
  try {
    const value = (await response.clone().json()) as {
      error?: { code?: string; message?: string };
    };
    const code = value?.error?.code;
    const message = value?.error?.message;
    return (
      ["file_not_found", "file_expired", "invalid_file_id"].includes(code ?? "") ||
      (typeof message === "string" &&
        /\bfile(?:[_ ]id)?\b/i.test(message) &&
        /expired|not found|does not exist/i.test(message))
    );
  } catch {
    return false;
  }
}
