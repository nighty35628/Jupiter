import { t } from "../i18n/index.js";

/** Web request lifetime includes DNS, headers and bounded body consumption. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // The operation may already have started; still observe rejection after an early abort.
  if (signal.aborted) void work.catch(() => undefined);
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function withWebDeadline<T>(
  timeoutMs: number,
  caller: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutError?: Error,
): Promise<T> {
  caller?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(timeoutError ?? new Error(`Web request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
  try {
    return await abortable(run(signal), signal);
  } finally {
    clearTimeout(timer);
  }
}

export function discardWebBody(response: Response): void {
  // Stream cancellation may itself never settle. It must not extend the deadline.
  void response.body?.cancel().catch(() => undefined);
}

export async function readWebBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    discardWebBody(response);
    throw new Error(`Web response content-length ${declared} exceeds ${maxBytes}-byte cap`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let complete = false;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (done) {
        complete = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes)
        throw new Error(t("webErrors.fetchBodyTooLarge", { cap: maxBytes, seen: bytes }));
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
