import type { ChatFinishReason, DeepSeekClient, Usage } from "../client.js";
import type { ReasoningEffort } from "../config.js";
import type { ChatMessage, ToolCall, ToolSpec } from "../types.js";
import { looksLikeCompleteJson } from "./shrink.js";
import { thinkingModeForModel } from "./thinking.js";
import {
  type LoopEvent,
  createModelRequestId,
  ensureToolCallIdentity,
  toolCallEventFields,
} from "./types.js";

export interface StreamModelOptions {
  client: DeepSeekClient;
  model: string;
  messages: ChatMessage[];
  toolSpecs: readonly ToolSpec[];
  signal: AbortSignal;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  maxTokens?: number;
  betaPrefix?: boolean;
  disableRetry?: boolean;
  turn: number;
  requestId?: string;
  /** Host-only image access gate; client projection must not serialize this field. */
  activeImageIds?: readonly string[];
}

export interface StreamModelResult {
  assistantContent: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  usage: Usage | null;
  usageComplete: boolean;
  finishReason: ChatFinishReason;
  requestId: string;
  outputChars: number;
  reasoningChars: number;
  toolArgsChars: number;
}

export async function* streamModelResponse(
  opts: StreamModelOptions,
): AsyncGenerator<LoopEvent, StreamModelResult, void> {
  const {
    client,
    model,
    messages,
    toolSpecs,
    signal,
    thinkingEnabled,
    reasoningEffort,
    maxTokens,
    betaPrefix,
    disableRetry,
    turn,
  } = opts;
  let assistantContent = "";
  let reasoningContent = "";
  let usage: Usage | null = null;
  let finishReason: ChatFinishReason = "unknown";
  const callBuf: Map<number, ToolCall> = new Map();
  const readyIndices = new Set<number>();
  const requestId = opts.requestId ?? createModelRequestId();
  let outputChars = 0;
  let reasoningChars = 0;
  let toolArgsChars = 0;
  const pendingIndices = new Set<number>();
  const announcedIndices = new Set<number>();
  let lastProgressAt = Date.now();
  const counters = () => ({ requestId, outputChars, reasoningChars, toolArgsChars });
  function* flushProgress(): Generator<LoopEvent> {
    for (const index of pendingIndices) {
      const call = callBuf.get(index)!;
      if (looksLikeCompleteJson(call.function.arguments)) readyIndices.add(index);
    }
    for (const index of pendingIndices) {
      const call = callBuf.get(index)!;
      if (!call.function.name) continue;
      announcedIndices.add(index);
      yield {
        turn,
        role: "tool_call_delta",
        content: "",
        ...counters(),
        ...toolCallEventFields(call),
        toolName: call.function.name,
        toolCallArgsChars: call.function.arguments.length,
        toolCallReadyCount: readyIndices.size,
      };
    }
    pendingIndices.clear();
    lastProgressAt = Date.now();
  }

  try {
    for await (const chunk of client.stream({
      model,
      messages,
      tools: toolSpecs.length ? toolSpecs : undefined,
      signal,
      thinking: thinkingModeForModel(model, thinkingEnabled),
      reasoningEffort: thinkingEnabled ? reasoningEffort : undefined,
      maxTokens,
      betaPrefix,
      disableRetry,
      activeImageIds: opts.activeImageIds,
    })) {
      if (chunk.reasoningDelta) {
        reasoningContent += chunk.reasoningDelta;
        reasoningChars += chunk.reasoningDelta.length;
        yield {
          turn,
          role: "assistant_delta",
          content: "",
          reasoningDelta: chunk.reasoningDelta,
          ...counters(),
        };
      }
      if (chunk.contentDelta) {
        assistantContent += chunk.contentDelta;
        outputChars += chunk.contentDelta.length;
        yield {
          turn,
          role: "assistant_delta",
          content: chunk.contentDelta,
          ...counters(),
        };
      }
      for (const d of chunk.toolCallDeltas ?? []) {
        const cur = callBuf.get(d.index) ?? {
          id: d.id,
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (d.id) cur.id = d.id;
        if (d.name) cur.function.name = (cur.function.name ?? "") + d.name;
        if (d.argumentsDelta)
          cur.function.arguments = (cur.function.arguments ?? "") + d.argumentsDelta;
        toolArgsChars += d.argumentsDelta?.length ?? 0;
        callBuf.set(d.index, cur);
        ensureToolCallIdentity(cur, requestId, d.index);
        pendingIndices.add(d.index);
        if (cur.function.name && !announcedIndices.has(d.index)) yield* flushProgress();
      }
      if (pendingIndices.size && Date.now() - lastProgressAt >= 50) yield* flushProgress();
      if (chunk.usage) usage = chunk.usage;
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }
    signal.throwIfAborted();
  } catch (error) {
    yield* flushProgress();
    for (const call of callBuf.values()) {
      yield {
        turn,
        role: "tool_call_drop",
        content: signal.aborted
          ? "Tool preparation was cancelled."
          : "Tool preparation ended before the stream completed.",
        toolName: call.function.name,
        ...toolCallEventFields(call),
        terminalState: signal.aborted ? "cancelled" : "dropped",
      };
    }
    throw error;
  }
  yield* flushProgress();

  return {
    assistantContent,
    reasoningContent,
    toolCalls: [...callBuf.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
    usage,
    usageComplete: usage !== null,
    finishReason,
    ...counters(),
  };
}
