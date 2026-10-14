import type { LoopEvent } from "../loop.js";
import type { ChatMessage, RawUsage, ToolCall } from "../types.js";
import { redactEventValue } from "./event-redaction.js";
import type {
  Event,
  ErrorEvent as KernelErrorEvent,
  ModelDeltaEvent,
  ModelFinalEvent,
  ModelTurnStartedEvent,
  SessionCompactedEvent,
  SessionOpenedEvent,
  SlashInvokedEvent,
  StatusEvent,
  ToolCallEvent,
  ToolConfirmAllowEvent,
  ToolConfirmAlwaysAllowEvent,
  ToolConfirmDenyEvent,
  ToolDispatchedEvent,
  ToolIntentEvent,
  ToolPreparingEvent,
  ToolResultEvent,
  UserMessageEvent,
} from "./events.js";

export interface EventizeContext {
  model: string;
  prefixHash: string;
  reasoningEffort: import("../config.js").ReasoningEffort;
}

type ToolEventMetadata = Pick<
  LoopEvent,
  | "requestId"
  | "localCallId"
  | "providerCallId"
  | "toolCallIndex"
  | "outputChars"
  | "reasoningChars"
  | "toolArgsChars"
>;

export class Eventizer {
  private nextId = 0;
  private lastTurn = -1;
  private nextToolSeq = 0;
  private legacyRequest = 0;
  private calls = new Map<
    string,
    {
      name: string;
      turn: number;
      phase: "preparing" | "running" | "terminal";
      metadata: ToolEventMetadata;
      legacyPreparation?: boolean;
      legacyRequest: number;
    }
  >();
  private legacyIndices = new Map<string, string>();
  private legacyCallIds = new Map<string, string>();

  consume(ev: LoopEvent, ctx: EventizeContext): Event[] {
    const out: Event[] = [];
    if (ev.turn !== this.lastTurn) {
      this.lastTurn = ev.turn;
      out.push(this.turnStartedEvent(ev.turn, ctx));
    }
    switch (ev.role) {
      case "assistant_delta":
        if (ev.content)
          out.push({
            ...this.deltaEvent(ev.turn, "content", ev.content),
            ...this.identityFields(ev),
          });
        if (ev.reasoningDelta)
          out.push({
            ...this.deltaEvent(ev.turn, "reasoning", ev.reasoningDelta),
            ...this.identityFields(ev),
          });
        break;
      case "tool_call_delta": {
        const idx = ev.toolCallIndex;
        const name = ev.toolName;
        if (!name || (idx === undefined && !ev.localCallId && !ev.callId)) break;
        const callId = this.resolveCallId(ev, "preparing");
        const prior = this.calls.get(callId);
        if (prior?.phase === "terminal") break;
        if (!prior) {
          this.calls.set(callId, {
            name,
            turn: ev.turn,
            phase: "preparing",
            legacyRequest: this.legacyRequestFor(ev),
            metadata: this.identityFields(ev),
            legacyPreparation:
              !ev.callId && ev.requestId === undefined && ev.localCallId === undefined,
          });
          out.push({
            ...this.toolPreparingEvent(ev.turn, callId, name),
            ...this.identityFields(ev),
            toolCallArgsChars: ev.toolCallArgsChars,
            toolCallReadyCount: ev.toolCallReadyCount,
          });
        } else {
          prior.name = name;
          prior.metadata = { ...prior.metadata, ...this.identityFields(ev) };
          out.push({
            id: ++this.nextId,
            ts: new Date().toISOString(),
            turn: ev.turn,
            type: "tool.progress",
            callId,
            name,
            phase: prior.phase,
            ...prior.metadata,
            toolCallArgsChars: ev.toolCallArgsChars,
            toolCallReadyCount: ev.toolCallReadyCount,
          });
        }
        break;
      }
      case "assistant_final":
        out.push({ ...this.finalEvent(ev), ...this.identityFields(ev) });
        this.legacyRequest++;
        break;
      case "tool_start": {
        const callId = this.resolveCallId(ev, "preparing");
        const prior = this.calls.get(callId);
        if (prior?.phase === "terminal" || prior?.phase === "running") break;
        const metadata = { ...prior?.metadata, ...this.identityFields(ev) };
        this.calls.set(callId, {
          name: ev.toolName ?? "",
          turn: ev.turn,
          phase: "running",
          legacyRequest: this.legacyRequestFor(ev),
          metadata,
        });
        out.push({
          ...this.toolIntentEvent(ev.turn, callId, ev.toolName ?? "", ev.toolArgs ?? ""),
          ...metadata,
        });
        out.push({ ...this.toolDispatchedEvent(ev.turn, callId), ...metadata });
        break;
      }
      case "tool": {
        const callId = this.resolveCallId(ev, "running");
        const prior = this.calls.get(callId);
        if (prior?.phase === "terminal") break;
        const metadata = { ...prior?.metadata, ...this.identityFields(ev) };
        this.calls.set(callId, {
          name: ev.toolName ?? "",
          turn: ev.turn,
          phase: "terminal",
          legacyRequest: this.legacyRequestFor(ev),
          metadata,
        });
        const ok = !looksLikeToolError(ev.content, ev.toolName);
        out.push({
          ...this.toolResultEvent(ev.turn, callId, ok, ev.content, 0),
          ...metadata,
          terminalState: ev.terminalState ?? (ok ? "completed" : "failed"),
          executed: true,
          ...(ev.attachments?.length ? { attachments: ev.attachments } : {}),
        });
        break;
      }
      case "tool_call_drop": {
        const callId = this.resolveCallId(ev, "preparing");
        const prior = this.calls.get(callId);
        if (prior?.phase === "terminal") break;
        const metadata = { ...prior?.metadata, ...this.identityFields(ev) };
        this.calls.set(callId, {
          name: ev.toolName ?? prior?.name ?? "",
          turn: ev.turn,
          phase: "terminal",
          legacyRequest: this.legacyRequestFor(ev),
          metadata,
        });
        out.push({
          ...this.toolResultEvent(ev.turn, callId, false, ev.content, 0),
          ...metadata,
          terminalState: ev.terminalState ?? "dropped",
          executed: prior?.phase === "running",
        });
        break;
      }
      case "warning": {
        if (ev.activity === "compaction") {
          out.push({
            ...this.statusEvent(ev.turn, ev.content),
            activity: ev.activity,
            activityState: ev.activityState,
          });
          break;
        }
        const classified = this.classifyWarning(ev);
        if (classified) out.push(classified);
        break;
      }
      case "error":
        out.push(...this.closeOpenCalls(ev.turn, "cancelled"));
        out.push(
          this.errorEvent(ev.turn, ev.error ?? ev.content, ev.errorDetail?.recoverable ?? false, {
            name: ev.errorDetail?.name,
            code: ev.errorDetail?.code,
            phase: ev.errorDetail?.phase,
            retryable: ev.errorDetail?.retryable,
          }),
        );
        break;
      case "status":
        out.push({
          ...this.statusEvent(ev.turn, ev.content),
          ...(ev.activity ? { activity: ev.activity, activityState: ev.activityState } : {}),
        });
        break;
      case "done":
        out.push(...this.closeOpenCalls(ev.turn, "dropped"));
        break;
      default:
        break;
    }
    return out;
  }

  private identityFields(ev: LoopEvent): ToolEventMetadata {
    return {
      ...(ev.requestId !== undefined ? { requestId: ev.requestId } : {}),
      ...(ev.localCallId !== undefined ? { localCallId: ev.localCallId } : {}),
      ...(ev.providerCallId !== undefined ? { providerCallId: ev.providerCallId } : {}),
      ...(ev.toolCallIndex !== undefined ? { toolCallIndex: ev.toolCallIndex } : {}),
      ...(ev.outputChars !== undefined ? { outputChars: ev.outputChars } : {}),
      ...(ev.reasoningChars !== undefined ? { reasoningChars: ev.reasoningChars } : {}),
      ...(ev.toolArgsChars !== undefined ? { toolArgsChars: ev.toolArgsChars } : {}),
    };
  }

  private resolveCallId(ev: LoopEvent, phase: "preparing" | "running"): string {
    if (ev.localCallId) return ev.localCallId;
    if (ev.requestId !== undefined) {
      if (ev.callId) return ev.callId;
      if (ev.toolCallIndex !== undefined) return `${ev.requestId}:tool:${ev.toolCallIndex}`;
      return this.nextLegacyCallId();
    }
    if (ev.callId) {
      const legacyRequest = this.legacyRequestFor(ev);
      const key = JSON.stringify([ev.turn, legacyRequest, ev.callId]);
      const known = this.legacyCallIds.get(key);
      if (known) return known;
      const preparations = [...this.calls].filter(
        ([, call]) =>
          call.turn === ev.turn &&
          call.legacyRequest === legacyRequest &&
          call.phase === "preparing" &&
          call.name === (ev.toolName ?? ""),
      );
      const candidate = preparations.length === 1 ? preparations[0] : undefined;
      const canAlias =
        (ev.role === "tool_start" || ev.role === "tool_call_delta") &&
        candidate?.[1].legacyPreparation &&
        candidate[1].metadata.requestId === undefined &&
        candidate[1].metadata.localCallId === undefined &&
        (ev.toolCallIndex === undefined ||
          ev.toolCallIndex === candidate[1].metadata.toolCallIndex);
      const id = canAlias
        ? candidate![0]
        : this.calls.has(ev.callId)
          ? this.nextLegacyCallId()
          : ev.callId;
      if (canAlias) candidate![1].legacyPreparation = false;
      this.legacyCallIds.set(key, id);
      return id;
    }
    if (ev.role === "tool_call_delta" && ev.toolCallIndex !== undefined) {
      const key = `${ev.turn}:${this.legacyRequest}:${ev.toolCallIndex}`;
      let id = this.legacyIndices.get(key);
      if (!id) {
        id = this.nextLegacyCallId();
        this.legacyIndices.set(key, id);
      }
      return id;
    }
    // Old producers without IDs may correlate only an unambiguous same-name call.
    // Never attach an unknown/ambiguous event to the oldest unrelated card.
    const matches = [...this.calls].filter(
      ([, call]) =>
        call.turn === ev.turn &&
        call.legacyRequest === this.legacyRequestFor(ev) &&
        call.phase === phase &&
        call.name === (ev.toolName ?? "") &&
        call.metadata.requestId === undefined &&
        call.metadata.localCallId === undefined,
    );
    return matches.length === 1 ? matches[0]![0] : this.nextLegacyCallId();
  }

  private nextLegacyCallId(): string {
    let id: string;
    do {
      id = `tc-${++this.nextToolSeq}`;
    } while (this.calls.has(id));
    return id;
  }

  private legacyRequestFor(ev: LoopEvent): number {
    // Deltas precede final; start/result belong to the request final just closed.
    return ev.role === "tool_call_delta" ? this.legacyRequest : Math.max(0, this.legacyRequest - 1);
  }

  finishTurn(turn: number): ToolResultEvent[] {
    return this.closeOpenCalls(turn, "cancelled");
  }

  private closeOpenCalls(turn: number, terminalState: "dropped" | "cancelled"): ToolResultEvent[] {
    const out: ToolResultEvent[] = [];
    for (const [callId, call] of this.calls) {
      if (call.turn !== turn || call.phase === "terminal") continue;
      out.push({
        ...this.toolResultEvent(turn, callId, false, terminalState, 0),
        ...call.metadata,
        terminalState,
        executed: call.phase === "running",
      });
      call.phase = "terminal";
    }
    return out;
  }

  emitUserMessage(
    turn: number,
    text: string,
    attachments?: ChatMessage["attachments"],
  ): UserMessageEvent {
    return {
      id: ++this.nextId,
      ...(attachments?.length ? { attachments } : {}),
      ts: new Date().toISOString(),
      turn,
      type: "user.message",
      text,
    };
  }

  emitSlashInvoked(turn: number, name: string, args: string): SlashInvokedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "slash.invoked",
      name,
      args,
    };
  }

  emitSessionOpened(turn: number, name: string, resumedFromTurn: number): SessionOpenedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "session.opened",
      name,
      resumedFromTurn,
    };
  }

  emitSessionCompacted(
    turn: number,
    before: number,
    after: number,
    reason: "user" | "auto-context-pressure",
    replacementMessages: ReadonlyArray<ChatMessage>,
  ): SessionCompactedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "session.compacted",
      beforeMessages: before,
      afterMessages: after,
      reason,
      replacementMessages,
    };
  }

  emitToolCall(turn: number, name: string, args: Record<string, unknown>): ToolCallEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "tool.call",
      name,
      args: redactEventValue(args),
    };
  }

  emitToolConfirmAllow(
    turn: number,
    kind: "run_command" | "run_background",
    payload: { command: string },
  ): ToolConfirmAllowEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "tool.confirm.allow",
      kind,
      payload: redactEventValue(payload),
    };
  }

  emitToolConfirmDeny(
    turn: number,
    kind: "run_command" | "run_background",
    payload: { command: string },
    denyContext?: string,
  ): ToolConfirmDenyEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "tool.confirm.deny",
      kind,
      payload: redactEventValue(payload),
      denyContext,
    };
  }

  emitToolConfirmAlwaysAllow(
    turn: number,
    kind: "run_command" | "run_background",
    payload: { command: string },
    prefix: string,
  ): ToolConfirmAlwaysAllowEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "tool.confirm.always_allow",
      kind,
      payload: redactEventValue(payload),
      prefix,
    };
  }

  private turnStartedEvent(turn: number, ctx: EventizeContext): ModelTurnStartedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "model.turn.started",
      model: ctx.model,
      reasoningEffort: ctx.reasoningEffort,
      prefixHash: ctx.prefixHash,
    };
  }

  private deltaEvent(
    turn: number,
    channel: "content" | "reasoning" | "tool_args",
    text: string,
  ): ModelDeltaEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "model.delta",
      channel,
      text,
    };
  }

  private finalEvent(ev: LoopEvent): ModelFinalEvent {
    const usage: RawUsage = ev.stats
      ? {
          prompt_tokens: ev.stats.usage.promptTokens,
          completion_tokens: ev.stats.usage.completionTokens,
          total_tokens: ev.stats.usage.totalTokens,
          prompt_cache_hit_tokens: ev.stats.usage.promptCacheHitTokens,
          prompt_cache_miss_tokens: ev.stats.usage.promptCacheMissTokens,
        }
      : {};
    const costUsd = ev.stats?.cost ?? 0;
    const out: ModelFinalEvent = {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn: ev.turn,
      type: "model.final",
      content: ev.content,
      // toolCalls land later via tool_start → tool.intent — not in this event.
      toolCalls: [] as ReadonlyArray<ToolCall>,
      usage,
      costUsd,
    };
    if (ev.reasoningContent !== undefined) out.reasoningContent = ev.reasoningContent;
    if (ev.forcedSummary) out.forcedSummary = true;
    return out;
  }

  private toolPreparingEvent(turn: number, callId: string, name: string): ToolPreparingEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "tool.preparing",
      callId,
      name,
    };
  }

  private toolIntentEvent(
    turn: number,
    callId: string,
    name: string,
    args: string,
  ): ToolIntentEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "tool.intent",
      callId,
      name,
      args,
    };
  }

  private toolDispatchedEvent(turn: number, callId: string): ToolDispatchedEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "tool.dispatched",
      callId,
    };
  }

  private toolResultEvent(
    turn: number,
    callId: string,
    ok: boolean,
    output: string,
    durationMs: number,
  ): ToolResultEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "tool.result",
      callId,
      ok,
      output,
      durationMs,
    };
  }

  private statusEvent(turn: number, text: string): StatusEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "status",
      text,
    };
  }

  private errorEvent(
    turn: number,
    message: string,
    recoverable: boolean,
    detail?: { name?: string; code?: string; phase?: string; retryable?: boolean },
  ): KernelErrorEvent {
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn,
      type: "error",
      message,
      recoverable,
      ...detail,
    };
  }

  /** Pattern-match warning text since LoopEvent doesn't carry a typed kind. Returns null
   *  for low-severity warnings (self-correcting / counter messages); the UI surface drops
   *  them entirely instead of rendering noise. */
  private classifyWarning(ev: LoopEvent): Event | null {
    const c = ev.content;
    if (/\bauto-escalating to\b|\barmed\b.*pro|NEEDS_PRO/.test(c)) {
      return {
        id: ++this.nextId,
        ts: new Date().toISOString(),
        turn: ev.turn,
        type: "policy.escalated",
        fromModel: "",
        toModel: "",
        reason: c.includes("armed") ? "user-request" : "self-report",
      };
    }
    if (/budget\b.*\$|\$\d.*\/\s*\$\d/.test(c)) {
      const blocked = /blocked|exceeded|refus/i.test(c);
      return {
        id: ++this.nextId,
        ts: new Date().toISOString(),
        turn: ev.turn,
        type: blocked ? "policy.budget.blocked" : "policy.budget.warning",
        spentUsd: 0,
        capUsd: 0,
      };
    }
    if (ev.severity === "low") return null;
    return {
      id: ++this.nextId,
      ts: new Date().toISOString(),
      turn: ev.turn,
      type: "warning",
      text: c,
      severity: ev.severity ?? "high",
    };
  }
}

function looksLikeToolError(content: string, _toolName: string | undefined): boolean {
  if (!content) return false;
  if (content.startsWith("ERROR:")) return true;
  if (content.startsWith("[hook block]")) return true;
  if (/^\{"error"\s*:/.test(content)) return true;
  if (/\bConfirmationError:|\bNeedsConfirmationError\b/.test(content)) return true;
  return false;
}
