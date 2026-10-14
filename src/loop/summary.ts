import type { ChatResponse, DeepSeekClient } from "../client.js";
import type { ChatRequestOptions } from "../types.js";
import { stripHallucinatedToolMarkup } from "./thinking.js";

export type SummaryFailure =
  | "summary-empty"
  | "summary-invalid"
  | "summary-timeout"
  | "summary-cancelled"
  | "summary-failed";

export class SummaryRequestError extends Error {
  constructor(readonly reason: SummaryFailure) {
    super(reason);
    this.name = "SummaryRequestError";
  }
}

export function acceptedSummary(response: ChatResponse): string {
  if (
    response.finishReason !== "stop" ||
    response.toolCalls.length > 0 ||
    typeof response.content !== "string"
  ) {
    throw new SummaryRequestError("summary-invalid");
  }
  const content = response.content.trim();
  if (!content) throw new SummaryRequestError("summary-empty");
  if (
    stripHallucinatedToolMarkup(content) !== content ||
    /<\/?(?:tool_call|function_call|function_calls|invoke|tool_use)\b|<\/?[|｜]DSML[|｜](?:tool_calls|function_calls|invoke|parameter)\b|<<<<<<<\s*SEARCH|>>>>>>>\s*REPLACE/i.test(
      content,
    )
  ) {
    throw new SummaryRequestError("summary-invalid");
  }
  return content;
}

export async function requestFoldSummary(
  client: DeepSeekClient,
  request: ChatRequestOptions,
  timeoutMs: number,
): Promise<ChatResponse> {
  if (request.signal?.aborted) throw new SummaryRequestError("summary-cancelled");
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => {};
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        controller.abort();
        reject(new SummaryRequestError("summary-cancelled"));
      };
      if (request.signal?.aborted) onAbort();
      else request.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new SummaryRequestError("summary-timeout"));
      }, timeoutMs);
    });
    const response = await Promise.race([
      cancelled,
      expired,
      client.chat({ ...request, signal: controller.signal }),
    ]);
    if (request.signal?.aborted) throw new SummaryRequestError("summary-cancelled");
    return response;
  } finally {
    if (timeout) clearTimeout(timeout);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
