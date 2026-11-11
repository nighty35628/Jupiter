import { type ChatFinishReason, Usage } from "../client.js";
import type { ProviderDialectPreference } from "../config.js";
import { type RequestBudget, resolveRequestBudget } from "../context-budget.js";
import { resolveModelCapability } from "../provider-capabilities.js";
import type { ChatMessage, ToolCall } from "../types.js";

const MIN_CONTINUATION_TOKENS = 1_024;

export interface PrefixContinuationPlan {
  maxTokens: number;
  messages: ChatMessage[];
}

export function planPrefixContinuation(opts: {
  enabled: boolean;
  baseUrl: string;
  dialect?: ProviderDialectPreference;
  model: string;
  finishReason: ChatFinishReason;
  messages: ChatMessage[];
  assistantContent: string;
  reasoningContent: string;
  toolCalls: readonly ToolCall[];
  usage: Usage | null;
  /** Current request snapshot, including legacy input and request-local output caps. */
  budget?: RequestBudget;
}): PrefixContinuationPlan | null {
  const capability = resolveModelCapability(opts.baseUrl, opts.model, opts.dialect);
  if (!opts.enabled || !capability.supportsPrefixContinuation) return null;
  if (opts.finishReason !== "length" || opts.toolCalls.length > 0 || !opts.usage) return null;
  if (!opts.assistantContent && !opts.reasoningContent) return null;

  if (
    !Number.isSafeInteger(opts.usage.promptTokens) ||
    !Number.isSafeInteger(opts.usage.completionTokens) ||
    opts.usage.promptTokens < 0 ||
    opts.usage.completionTokens < 0
  )
    return null;

  const budget =
    opts.budget ??
    resolveRequestBudget({
      baseUrl: opts.baseUrl,
      model: opts.model,
      dialect: opts.dialect,
      maxTokens: capability.maxOutputTokens,
    });
  const estimatedSecondPrompt = opts.usage.promptTokens + opts.usage.completionTokens;
  const available = budget.contextWindowTokens - estimatedSecondPrompt - budget.safetyTokens;
  if (available < MIN_CONTINUATION_TOKENS) return null;
  const continuationBudget = resolveRequestBudget({
    baseUrl: opts.baseUrl,
    model: opts.model,
    dialect: opts.dialect,
    contextWindowTokens: budget.contextWindowTokens,
    inputTokenLimit: budget.inputTokenLimit,
    maxTokens: Math.min(budget.maxTokens ?? capability.maxOutputTokens ?? 0, available),
  });
  if (
    !continuationBudget.maxTokens ||
    continuationBudget.maxTokens < MIN_CONTINUATION_TOKENS ||
    estimatedSecondPrompt > continuationBudget.inputLimit
  )
    return null;

  const prefixMessage: ChatMessage = {
    role: "assistant",
    content: opts.assistantContent,
    prefix: true,
  };
  if (opts.reasoningContent) prefixMessage.reasoning_content = opts.reasoningContent;

  return {
    maxTokens: continuationBudget.maxTokens,
    messages: [...opts.messages, prefixMessage],
  };
}

export function addUsage(first: Usage | null, second: Usage | null): Usage | null {
  if (!first) return second;
  if (!second) return first;
  return new Usage(
    first.promptTokens + second.promptTokens,
    first.completionTokens + second.completionTokens,
    first.totalTokens + second.totalTokens,
    first.promptCacheHitTokens + second.promptCacheHitTokens,
    first.promptCacheMissTokens + second.promptCacheMissTokens,
  );
}
