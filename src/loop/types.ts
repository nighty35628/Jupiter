import { randomUUID } from "node:crypto";
import type { RepairReport } from "../repair/index.js";
import type { TurnStats } from "../telemetry/stats.js";
import type { ToolCall } from "../types.js";

export interface ToolCallIdentity {
  requestId: string;
  localCallId: string;
  toolCallIndex: number;
}

// Host-only metadata must never become enumerable provider request fields.
const toolCallIdentities = new WeakMap<ToolCall, ToolCallIdentity>();

export function createModelRequestId(): string {
  return `request-${randomUUID()}`;
}

export function ensureToolCallIdentity(
  call: ToolCall,
  requestId: string,
  index: number,
): ToolCallIdentity {
  let identity = toolCallIdentities.get(call);
  if (!identity) {
    identity = { requestId, localCallId: `${requestId}:tool:${index}`, toolCallIndex: index };
    toolCallIdentities.set(call, identity);
  }
  return identity;
}

export function getToolCallIdentity(call: ToolCall): ToolCallIdentity | undefined {
  return toolCallIdentities.get(call);
}

export function toolCallEventFields(
  call: ToolCall,
): Partial<ToolCallIdentity> & { callId?: string; providerCallId?: string } {
  const identity = getToolCallIdentity(call);
  return {
    ...identity,
    ...(identity ? { callId: identity.localCallId } : {}),
    ...(call.id ? { providerCallId: call.id } : {}),
  };
}

export type EventRole =
  | "assistant_delta"
  | "assistant_final"
  /** Only liveness signal during a large-args tool call (no content/reasoning bytes). */
  | "tool_call_delta"
  /** An announced call will not execute (repair/guard/cancel); closes its card. */
  | "tool_call_drop"
  /** Pre-dispatch ping so the TUI can show a spinner during long tool awaits. */
  | "tool_start"
  | "tool"
  | "done"
  | "error"
  | "warning"
  /** Transient indicator for silent phases; UI clears on next primary event. */
  | "status"
  /** Mid-turn steer injected as queued user guidance without aborting the current turn. */
  | "steer";

/** "low" = chatty / self-correcting / counter — Desktop+Dashboard filter these out by default.
 *  Undefined / "high" = real event the user should see (compaction, abort, budget, rate-limit, etc.).
 *  TUI ignores this and renders every warning. */
export type EventSeverity = "low" | "high";

export interface LoopEvent {
  attachments?: import("../attachments/types.js").ImageAttachment[];
  turn: number;
  role: EventRole;
  content: string;
  severity?: EventSeverity;
  activity?: "compaction";
  activityState?: "running" | "complete";
  reasoningDelta?: string;
  /** Full reasoning text available on assistant_final; deltas may be absent on some model paths. */
  reasoningContent?: string;
  toolName?: string;
  /** Raw args JSON — needed by `jupiter diff` to explain why a tool was called. */
  toolArgs?: string;
  /** Cumulative arguments-string length for `role === "tool_call_delta"`. */
  toolCallArgsChars?: number;
  /** Zero-based index of the tool call this delta belongs to (multi-tool progress). */
  toolCallIndex?: number;
  /** Count of tool calls whose args have parsed as valid JSON (UI progress, not dispatch gate). */
  toolCallReadyCount?: number;
  /** Per-model-request cumulative character counters, not token or byte counts. */
  outputChars?: number;
  reasoningChars?: number;
  toolArgsChars?: number;
  requestId?: string;
  localCallId?: string;
  /** Provider protocol identity, independent of the displayed/inflight identity. */
  providerCallId?: string;
  terminalState?: "completed" | "failed" | "dropped" | "cancelled";
  /** Stable id for tool_start / tool pairs — also the inflight-set key. UI uses this as the card id so it can derive `running` from `loop.inflight.has(callId)` instead of trusting end-event delivery. */
  callId?: string;
  stats?: TurnStats;
  repair?: RepairReport;
  error?: string;
  errorDetail?: {
    name: string;
    message: string;
    code?: string;
    phase?: string;
    retryable: boolean;
    recoverable: boolean;
  };
  /** Display-only — code-mode applier MUST skip SEARCH/REPLACE in forced-summary text. */
  forcedSummary?: boolean;
}
