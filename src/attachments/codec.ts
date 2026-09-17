import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { ImageMime } from "./types.js";
import { MAX_IMAGE_INPUT_BYTES } from "./types.js";

export interface EncodedImage {
  data: Uint8Array;
  mime: ImageMime;
  width: number;
  height: number;
}

export interface ImageEncoding {
  image: EncodedImage;
  thumbnail?: EncodedImage;
  originalWidth?: number;
  originalHeight?: number;
  staticFrame?: boolean;
}

let active = 0;
let queuedBytes = 0;
const waiting: Array<() => void> = [];

/** One decoder at a time, bounded queue, and a fresh worker so WASM memory is released. */
export async function encodeImage(
  bytes: Uint8Array,
  mode: "canonical" | "request" = "canonical",
  signal?: AbortSignal,
): Promise<ImageEncoding> {
  signal?.throwIfAborted();
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_INPUT_BYTES)
    throw new Error("Image must be between 1 byte and 20 MiB");
  if (waiting.length >= 8 || queuedBytes + bytes.byteLength > 40 * 1024 * 1024)
    throw new Error("Too many images are being processed. Try again shortly.");
  if (active > 0) {
    queuedBytes += bytes.byteLength;
    try {
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = waiting.indexOf(ready);
          if (index >= 0) waiting.splice(index, 1);
          reject(new DOMException("Image processing cancelled", "AbortError"));
        };
        waiting.push(ready);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    } finally {
      queuedBytes -= bytes.byteLength;
    }
  } else active = 1;
  try {
    signal?.throwIfAborted();
    const locations = [
      new URL("./image-worker.cjs", import.meta.url),
      new URL("./attachments/image-worker.cjs", import.meta.url),
    ];
    const workerUrl = locations.find((url) => existsSync(url));
    if (!workerUrl) throw new Error("Image worker is missing from this Jupiter installation");
    return await new Promise<ImageEncoding>((resolve, reject) => {
      const copy = Uint8Array.from(bytes);
      const worker = new Worker(workerUrl, {
        workerData: { bytes: copy, mode },
        transferList: [copy.buffer],
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 },
      });
      let settled = false;
      const finish = (error?: Error, value?: ImageEncoding) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        void worker.terminate().finally(() => (error ? reject(error) : resolve(value!)));
      };
      const abort = () => finish(new DOMException("Image processing cancelled", "AbortError"));
      const timer = setTimeout(() => finish(new Error("Image processing timed out")), 30_000);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      worker.once("message", (message) =>
        message.ok ? finish(undefined, message.value) : finish(new Error(message.error)),
      );
      worker.once("error", (error) => finish(error));
      worker.once("exit", (code) => {
        if (!settled) finish(new Error(`Image worker exited (${code})`));
      });
    });
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active = 0;
  }
}
