import { type ChatFinishReason, Usage } from "../client.js";
import type { ProviderDialectPreference } from "../config.js";
import { resolveModelCapability } from "../provider-capabilities.js";
import type { ChatMessage, ToolCall } from "../types.js";

const MAX_DEEPSEEK_OUTPUT_TOKENS = 384_000;
const CONTINUATION_RESERVE_TOKENS = 4_096;
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
}): PrefixContinuationPlan | null {
  const capability = resolveModelCapability(opts.baseUrl, opts.model, opts.dialect);
  if (!opts.enabled || !capability.supportsPrefixContinuation) return null;
  if (opts.finishReason !== "length" || opts.toolCalls.length > 0 || !opts.usage) return null;
  if (!opts.assistantContent && !opts.reasoningContent) return null;

  const contextWindow = capability.contextWindowTokens;
  if (!contextWindow) return null;
  const estimatedSecondPrompt = opts.usage.promptTokens + opts.usage.completionTokens;
  const available = contextWindow - estimatedSecondPrompt - CONTINUATION_RESERVE_TOKENS;
  if (available < MIN_CONTINUATION_TOKENS) return null;

  const prefixMessage: ChatMessage = {
    role: "assistant",
    content: opts.assistantContent,
    prefix: true,
  };
  if (opts.reasoningContent) prefixMessage.reasoning_content = opts.reasoningContent;

  return {
    maxTokens: Math.min(MAX_DEEPSEEK_OUTPUT_TOKENS, available),
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
