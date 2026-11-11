type NativeReply = { requestId: string; runId: string; ok: boolean; result?: unknown; error?: string };
type NativePort = { postMessage(message: string): void; onmessage?: (event: MessageEvent<string>) => void };
declare global { interface Window { JupiterAndroid?: NativePort } }

export const isAndroidLocal = document.querySelector('meta[name="jupiter-platform"]')?.getAttribute("content") === "android";
const runId = document.querySelector('meta[name="jupiter-run"]')?.getAttribute("content") ?? "";
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let listening: NativePort | undefined;

export type AndroidSpeechEvent = {
  sessionId: string;
  state: "preparing" | "recording" | "transcribing" | "result" | "error" | "cancelled";
  text?: string;
  error?: string;
};
const speechSubscribers = new Set<(event: AndroidSpeechEvent) => void>();
const speechStates = new Set(["preparing", "recording", "transcribing", "result", "error", "cancelled"]);

function isSpeechEvent(value: unknown): value is AndroidSpeechEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.sessionId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(event.sessionId) &&
    typeof event.state === "string" && speechStates.has(event.state) &&
    (event.text === undefined || (typeof event.text === "string" && event.text.length <= 32768)) &&
    (event.error === undefined || (typeof event.error === "string" && event.error.length <= 512)) &&
    (event.state !== "result" || (typeof event.text === "string" && event.text.trim().length > 0)) &&
    (event.state !== "error" || (typeof event.error === "string" && event.error.length > 0));
}

function listen(port: NativePort): void {
  if (listening === port) return;
  listening = port;
  port.onmessage = event => {
    let message: NativeReply & { type?: unknown; event?: unknown };
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message || typeof message !== "object" || message.runId !== runId) return;
    if (message.type === "speech") {
      if (listening !== port || window.JupiterAndroid !== port || !isSpeechEvent(message.event)) return;
      for (const callback of [...speechSubscribers]) {
        // A subscriber cannot consume command replies or interrupt another subscriber.
        try { callback({ ...message.event }); } catch { /* Subscriber owns its errors. */ }
      }
      return;
    }
    if (typeof message.ok !== "boolean" || typeof message.requestId !== "string") return;
    const item = pending.get(message.requestId);
    if (!item) return;
    pending.delete(message.requestId);
    if (message.ok) item.resolve(message.result);
    else item.reject(new Error(message.error || "Android operation failed"));
  };
}

/** Speech notifications share the native port, not the command's one-shot reply. */
export function subscribeAndroidSpeech(callback: (event: AndroidSpeechEvent) => void): () => void {
  const port = window.JupiterAndroid;
  if (!isAndroidLocal || !runId) return () => {};
  // WebView may expose the port after modules initialize. The first command also calls listen.
  if (port) listen(port);
  speechSubscribers.add(callback);
  return () => { speechSubscribers.delete(callback); };
}

/** Host permissions are checked again by Native against the main frame, exact origin and run. */
export function callAndroid<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const port = window.JupiterAndroid;
  if (!isAndroidLocal || !port || !runId) return Promise.reject(new Error("Android host is not connected"));
  listen(port);
  if (pending.size >= 16) return Promise.reject(new Error("Too many pending Android operations"));
  const requestId = crypto.randomUUID();
  const message = JSON.stringify({ version: 1, requestId, runId, command, args });
  if (new TextEncoder().encode(message).length > 8192) return Promise.reject(new Error("Android request is too large"));
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, { resolve: value => resolve(value as T), reject });
    try { port.postMessage(message); }
    catch { pending.delete(requestId); reject(new Error("Android host channel failed")); }
  });
}

export async function downloadAndroidFile(fileId: string, name: string): Promise<void> {
  const result = await callAndroid<{ saved?: boolean; cancelled?: boolean }>("downloadFile", { fileId, name });
  if (result?.cancelled) throw new DOMException("Export cancelled", "AbortError");
  if (!result?.saved) throw new Error("Android export did not complete");
}

export type AndroidShare = {
  id: string;
  text: string;
  files: { id: string; name: string; mime: string; size: number; url: string }[];
};

const SHARE_MAX_BYTES = 100 * 1024 * 1024;
const SHARE_FILE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Native keeps this staged share readable until acknowledgeShare succeeds. */
export async function consumeAndroidShare(): Promise<AndroidShare | null> {
  const share = await callAndroid<AndroidShare | null>("consumeShare");
  if (share === null) return null;
  if (!share || typeof share.id !== "string" || !share.id || share.id.length > 128 ||
      typeof share.text !== "string" || share.text.length > 2 * 1024 * 1024 ||
      !Array.isArray(share.files) || share.files.length > 12) {
    throw new Error("Invalid Android share");
  }
  let bytes = 0;
  const ids = new Set<string>();
  for (const file of share.files) {
    if (!file || typeof file.id !== "string" || !SHARE_FILE_ID.test(file.id) ||
        ids.has(file.id) || typeof file.name !== "string" || !file.name ||
        typeof file.mime !== "string" || !Number.isSafeInteger(file.size) || file.size < 0 ||
        typeof file.url !== "string") throw new Error("Invalid Android share file");
    const url = new URL(file.url, window.location.origin);
    if (url.origin !== window.location.origin || url.username || url.password ||
        url.pathname !== `/native-share/${file.id}` || url.search || url.hash) {
      throw new Error("Invalid Android share URL");
    }
    ids.add(file.id);
    bytes += file.size;
    if (bytes > SHARE_MAX_BYTES) throw new Error("Android share exceeds 100 MiB");
  }
  return share;
}

/** Native presents confirmation; a cancelled confirmation must leave the staged head intact. */
export async function discardAndroidShare(id?: string): Promise<boolean> {
  const result = await callAndroid<{ discarded: boolean }>("discardShare", id ? { id } : {});
  if (typeof result?.discarded !== "boolean") throw new Error("Invalid Android share discard result");
  return result.discarded;
}

export async function fetchAndroidShareFiles(share: AndroidShare, signal: AbortSignal): Promise<File[]> {
  const files: File[] = [];
  let bytes = 0;
  for (const file of share.files) {
    // The descriptor was validated above; never follow a redirect with the share capability.
    const response = await fetch(`/native-share/${file.id}`, {
      headers: { "x-jupiter-share": share.id },
      credentials: "same-origin", redirect: "error", cache: "no-store", signal,
    });
    if (!response.ok || response.redirected) throw new Error("Android share file is unavailable");
    const blob = await response.blob();
    bytes += blob.size;
    if (blob.size !== file.size || bytes > SHARE_MAX_BYTES) throw new Error("Android share file size changed");
    files.push(new File([blob], file.name, { type: file.mime }));
  }
  return files;
}

if (isAndroidLocal) window.addEventListener("pagehide", () => {
  for (const item of pending.values()) item.reject(new Error("Android page disconnected"));
  pending.clear();
  speechSubscribers.clear();
});
