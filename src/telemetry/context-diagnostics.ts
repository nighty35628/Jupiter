import { COMPACTION_SUMMARY_MARKER } from "@jupiter/core-utils";
import type { Usage } from "../client.js";
import { countTokensBounded } from "../tokenizer.js";
import type { ChatMessage, ToolSpec } from "../types.js";
import { type SessionSummary, resolveContextTokens } from "./stats.js";

export interface ContextDiagnostics {
  systemTokens: number;
  toolsTokens: number;
  logTokens: number;
  inputTokens: number;
  memoryTokens: number;
  summaryTokens: number;
  ctxMax: number;
  toolsCount: number;
  logMessages: number;
  topTools: Array<{ name: string; tokens: number; turn: number }>;
  lastPromptTokens: number;
  lastCacheHitTokens: number;
  lastCacheMissTokens: number;
  sessionCacheHitRatio: number;
  totalCostUsd: number;
  turns: number;
}

export interface ContextDiagnosticsInput {
  systemPrompt: string;
  toolSpecs: readonly ToolSpec[];
  messages: readonly ChatMessage[];
  model: string;
  summary?: Pick<SessionSummary, "turns" | "totalCostUsd" | "cacheHitRatio" | "lastPromptTokens">;
  lastUsage?: Usage | null;
}

export interface ContextDiagnosticsLoopLike {
  prefix: {
    system: string;
    toolSpecs: readonly ToolSpec[];
  };
  log: {
    toFullHistory(): ChatMessage[];
  };
  model: string;
  stats?: {
    turns: Array<{ usage: Usage }>;
    summary(): SessionSummary;
  };
}

export function computeContextDiagnostics(input: ContextDiagnosticsInput): ContextDiagnostics {
  const systemTokens = countTokensBounded(input.systemPrompt);
  const toolsTokens = countTokensBounded(JSON.stringify(input.toolSpecs));
  const memoryTokens = estimateMemoryTokens(input.systemPrompt);
  const { logTokens, summaryTokens, logMessages, topTools } = computeLogDiagnostics(input.messages);
  const summary = input.summary;
  const lastUsage = input.lastUsage ?? null;
  return {
    systemTokens,
    toolsTokens,
    logTokens,
    inputTokens: 0,
    memoryTokens,
    summaryTokens,
    ctxMax: resolveContextTokens(input.model),
    toolsCount: input.toolSpecs.length,
    logMessages,
    topTools,
    lastPromptTokens: summary?.lastPromptTokens ?? lastUsage?.promptTokens ?? 0,
    lastCacheHitTokens: lastUsage?.promptCacheHitTokens ?? 0,
    lastCacheMissTokens: lastUsage?.promptCacheMissTokens ?? 0,
    sessionCacheHitRatio: summary?.cacheHitRatio ?? lastUsage?.cacheHitRatio ?? 0,
    totalCostUsd: summary?.totalCostUsd ?? 0,
    turns: summary?.turns ?? 0,
  };
}

export function computeContextDiagnosticsFromLoop(
  loop: ContextDiagnosticsLoopLike,
): ContextDiagnostics {
  const summary = loop.stats?.summary();
  const turns = loop.stats?.turns ?? [];
  const lastUsage = turns[turns.length - 1]?.usage ?? null;
  return computeContextDiagnostics({
    systemPrompt: loop.prefix.system,
    toolSpecs: loop.prefix.toolSpecs,
    messages: loop.log.toFullHistory(),
    model: loop.model,
    summary,
    lastUsage,
  });
}

export function estimateMemoryTokens(systemPrompt: string): number {
  const blocks = systemPrompt.match(
    /# (?:HIGH PRIORITY constraints|User memory|Project memory)[\s\S]*?(?=\n# |\n---|$)/g,
  );
  if (!blocks || blocks.length === 0) return 0;
  return countTokensBounded(blocks.join("\n\n"));
}

function computeLogDiagnostics(messages: readonly ChatMessage[]): {
  logTokens: number;
  summaryTokens: number;
  logMessages: number;
  topTools: Array<{ name: string; tokens: number; turn: number }>;
} {
  let userTokens = 0;
  let assistantTokens = 0;
  let toolResultTokens = 0;
  let toolCallTokens = 0;
  let summaryTokens = 0;
  let logTurn = 0;
  const toolBreakdown: Array<{ name: string; tokens: number; turn: number }> = [];

  for (const message of messages) {
    const content = typeof message.content === "string" ? message.content : "";
    if (message.role === "user") {
      userTokens += countTokensBounded(content);
      logTurn += 1;
      continue;
    }
    if (message.role === "assistant") {
      const contentTokens = countTokensBounded(content);
      assistantTokens += contentTokens;
      if (content.startsWith(COMPACTION_SUMMARY_MARKER)) {
        summaryTokens += contentTokens;
      }
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        toolCallTokens += countTokensBounded(JSON.stringify(message.tool_calls));
      }
      continue;
    }
    if (message.role === "tool") {
      const tokens = countTokensBounded(content);
      toolResultTokens += tokens;
      toolBreakdown.push({ name: message.name ?? "?", tokens, turn: logTurn });
    }
  }

  return {
    logTokens: userTokens + assistantTokens + toolResultTokens + toolCallTokens,
    summaryTokens,
    logMessages: messages.length,
    topTools: [...toolBreakdown].sort((a, b) => b.tokens - a.tokens).slice(0, 5),
  };
}
