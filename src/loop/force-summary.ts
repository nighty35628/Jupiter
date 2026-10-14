import { type DeepSeekClient, Usage } from "../client.js";
import { t } from "../i18n/index.js";
import { sanitizeProviderErrorText } from "../provider-http-error.js";
import type { TurnStats } from "../telemetry/stats.js";
import type { ChatMessage } from "../types.js";
import { errorLabelFor, reasonPrefixFor } from "./errors.js";
import { buildAssistantMessage } from "./messages.js";
import { acceptedSummary, requestFoldSummary } from "./summary.js";
import type { LoopEvent } from "./types.js";

export type ForceSummaryReason = "aborted" | "context-guard" | "stuck";

export interface ForceSummaryContext {
  client: DeepSeekClient;
  signal: AbortSignal;
  buildMessages: () => ChatMessage[];
  appendAndPersist: (msg: ChatMessage) => boolean | undefined;
  activeImageIds?: readonly string[];
  summaryTimeoutMs?: number;
  recordStats: (model: string, usage: Usage) => TurnStats;
  turn: number;
  /** Model to call for the summary itself — must be valid on the user's endpoint. */
  model: string;
}

export async function* forceSummaryAfterGuard(
  ctx: ForceSummaryContext,
  opts: { reason: ForceSummaryReason },
): AsyncGenerator<LoopEvent> {
  try {
    // Status bridges the non-streaming summary request until its deadline.
    yield { turn: ctx.turn, role: "status", content: t("summary.status") };
    const messages = ctx.buildMessages();
    // Passing `tools: undefined` was supposed to force a text response,
    // but R1 can still hallucinate tool-call markup (e.g. DSML
    // `<｜DSML｜function_calls>…`) when primed by prior tool use. An
    // explicit user-role instruction plus validation rejects such responses
    // before replacing any durable history.
    messages.push({
      role: "user",
      content:
        "The turn is being force-summarized (context guard or stuck-state). Summarize in plain prose what you learned from the tool results above. Do NOT emit any tool calls, function-call markup, DSML invocations, or SEARCH/REPLACE edit blocks — they will be silently discarded. Just plain text.",
    });
    // Use the active turn model — pinning a specific name (e.g. flash) 400s
    // on third-party endpoints that don't advertise it. `thinking: disabled`
    // still keeps reasoning tokens off the bill for the bounded paraphrase.
    const resp = await requestFoldSummary(
      ctx.client,
      {
        model: ctx.model,
        messages,
        signal: ctx.signal,
        activeImageIds: ctx.activeImageIds,
        thinking: "disabled",
      },
      ctx.summaryTimeoutMs ?? 15_000,
    );
    const summaryStats = ctx.recordStats(ctx.model, resp.usage ?? new Usage());
    const summary = acceptedSummary(resp);
    ctx.signal.throwIfAborted();
    const reasonPrefix = reasonPrefixFor(opts.reason);
    const annotated = `${reasonPrefix}\n\n${summary}`;
    if (
      ctx.appendAndPersist(buildAssistantMessage(summary, [], ctx.model, resp.reasoningContent)) ===
      false
    )
      throw new Error("Summary could not be committed; the original history was retained.");
    yield {
      turn: ctx.turn,
      role: "assistant_final",
      content: annotated,
      reasoningContent: resp.reasoningContent || undefined,
      stats: summaryStats,
      forcedSummary: true,
    };
    yield { turn: ctx.turn, role: "done", content: summary };
  } catch (err) {
    const label = errorLabelFor(opts.reason);
    const message = t("summary.failedAfterReason", {
      label,
      message: sanitizeProviderErrorText((err as Error).message, {
        knownSecrets: [ctx.client.apiKey],
      }),
    });
    yield {
      turn: ctx.turn,
      role: "error",
      content: "",
      error: message,
      errorDetail: {
        name: "ForceSummaryFailed",
        message,
        retryable: true,
        recoverable: true,
      },
    };
    yield { turn: ctx.turn, role: "done", content: "" };
  }
}
