import type { ChatResponse, DeepSeekClient } from "../client.js";
import { resolveContextTokens } from "../telemetry/stats.js";
import type { ChatRequestOptions } from "../types.js";
import {
  type ProviderCompactionBudget,
  type SummaryRecovery,
  compactionCandidates,
  compactionRequestTokens,
  isCompactionContextError,
  providerContextBudget,
} from "./compaction.js";
import { stripHallucinatedToolMarkup } from "./thinking.js";

export type SummaryFailure =
  | "summary-empty"
  | "summary-invalid"
  | "summary-timeout"
  | "summary-cancelled"
  | "summary-over-limit"
  | "summary-failed";

export class SummaryRequestError extends Error {
  constructor(readonly reason: SummaryFailure) {
    super(reason);
    this.name = "SummaryRequestError";
  }
}

export interface FoldSummaryResponse extends ChatResponse {
  /** Explicit provider evidence only; recovery's tokens-minus-one ceiling is not a model limit. */
  contextBudget?: ProviderCompactionBudget & { model: string };
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
  recovery?: SummaryRecovery,
): Promise<FoldSummaryResponse> {
  return withSummaryDeadline(request.signal, timeoutMs, async (signal) => {
    const base = { ...request, signal, disableRetry: true };
    if (!recovery) return client.chat(base);
    let budget = resolveContextTokens(request.model);
    let learnedBudget: number | undefined;
    let totalWindow: number | undefined;
    let attempts = 0;
    let outputCap = request.maxTokens;
    for (const candidate of compactionCandidates(base, recovery)) {
      signal.throwIfAborted();
      if (attempts >= 3) break;
      candidate.maxTokens = outputCap;
      const tokens = await compactionRequestTokens(client, candidate);
      if (tokens > budget) continue;
      while (attempts < 3) {
        signal.throwIfAborted();
        attempts++;
        const attemptedOutputCap = candidate.maxTokens;
        try {
          const response = await client.chat(candidate);
          if (learnedBudget === undefined) return response;
          const contextBudget: FoldSummaryResponse["contextBudget"] =
            totalWindow !== undefined && outputCap !== undefined
              ? {
                  kind: "total",
                  model: request.model,
                  promptTokens: learnedBudget,
                  totalTokens: totalWindow,
                  maxTokens: outputCap,
                }
              : { kind: "prompt", model: request.model, promptTokens: learnedBudget };
          return { ...response, contextBudget };
        } catch (error) {
          // Classify while provider evidence is still structured, before the
          // caller collapses errors into SummaryFailure.
          if (!isCompactionContextError(error)) throw error;
          const providerBudget = providerContextBudget(error, candidate);
          if (providerBudget !== undefined) {
            learnedBudget = Math.min(
              learnedBudget ?? Number.POSITIVE_INFINITY,
              providerBudget.promptTokens,
            );
            if (providerBudget.kind === "total")
              totalWindow = Math.min(
                totalWindow ?? Number.POSITIVE_INFINITY,
                providerBudget.totalTokens,
              );
          }
          outputCap = candidate.maxTokens;
          budget = Math.min(budget, providerBudget?.promptTokens ?? Number.POSITIVE_INFINITY);
          // Lowering the output cap is real progress even with identical input.
          // Retry this exact candidate once per cap change, within the shared budget.
          if (outputCap !== attemptedOutputCap && tokens <= budget) continue;
          budget = Math.min(budget, tokens - 1);
          break;
        }
      }
    }
    throw new SummaryRequestError("summary-over-limit");
  });
}

export async function withSummaryDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw new SummaryRequestError("summary-cancelled");
  if (timeoutMs <= 0) throw new SummaryRequestError("summary-timeout");
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => {};
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        controller.abort();
        reject(new SummaryRequestError("summary-cancelled"));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new SummaryRequestError("summary-timeout"));
      }, timeoutMs);
    });
    const response = await Promise.race([cancelled, expired, task(controller.signal)]);
    if (signal?.aborted) throw new SummaryRequestError("summary-cancelled");
    return response;
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}
