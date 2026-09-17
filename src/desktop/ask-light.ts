import type { ImageAttachment } from "../attachments/types.js";
import type { Usage } from "../client.js";
import { costUsd } from "../telemetry/stats.js";
import type { ChatMessage } from "../types.js";

export const LIGHT_ASK_SYSTEM_PROMPT =
  "You are Jupiter. Answer directly and concisely. Do not use tools. If the user asks you to inspect or modify files, tell them to use Agent mode.";

type LightAskClient = {
  providerId?: string;
  chat: (opts: {
    model: string;
    messages: ChatMessage[];
    tools: [];
    signal?: AbortSignal;
    thinking?: "enabled" | "disabled";
    maxTokens?: number;
  }) => Promise<{
    content: string;
    reasoningContent?: string | null;
    usage: Usage;
  }>;
};

export type LightAskEmitEvent =
  | {
      type: "user.message";
      id: number;
      ts: string;
      turn: number;
      text: string;
      clientId?: string;
      attachments?: ImageAttachment[];
    }
  | {
      type: "model.turn.started";
      id: number;
      ts: string;
      turn: number;
      model: string;
      reasoningEffort: import("../config.js").ReasoningEffort;
      prefixHash: string;
    }
  | {
      type: "model.final";
      id: number;
      ts: string;
      turn: number;
      content: string;
      reasoningContent?: string;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_cache_hit_tokens: number;
        prompt_cache_miss_tokens: number;
      };
      toolCalls: [];
      costUsd: number;
    }
  | { type: "$turn_complete" };

export async function runDesktopLightAsk(args: {
  client: LightAskClient;
  model: string;
  reasoningEffort?: import("../config.js").ReasoningEffort;
  prefixHash?: string;
  text: string;
  attachments?: ImageAttachment[];
  turn: number;
  clientId?: string;
  signal?: AbortSignal;
  appendAndPersist?: (message: ChatMessage) => void;
  recordExchange?: (exchange: {
    userInput: string;
    assistantContent: string;
    model: string;
    usage: Usage;
    reasoningContent?: string | null;
  }) => void;
  emitUserMessage?: boolean;
  emit: (event: LightAskEmitEvent) => void;
}): Promise<{ content: string; usage: Usage; costUsd: number }> {
  const text = args.text.trim();
  if (!text && !args.attachments?.length) throw new Error("ask_light requires text or images");
  const ts = () => new Date().toISOString();
  let id = Date.now();
  if (args.emitUserMessage !== false) {
    args.emit({
      type: "user.message",
      id: id++,
      ts: ts(),
      turn: args.turn,
      text,
      clientId: args.clientId,
      ...(args.attachments?.length ? { attachments: args.attachments } : {}),
    });
  }
  args.emit({
    type: "model.turn.started",
    id: id++,
    ts: ts(),
    turn: args.turn,
    model: args.model,
    reasoningEffort: args.reasoningEffort ?? "low",
    prefixHash: args.prefixHash ?? "ask-light",
  });
  const response = await args.client.chat({
    model: args.model,
    messages: [
      { role: "system", content: LIGHT_ASK_SYSTEM_PROMPT },
      {
        role: "user",
        content: text,
        ...(args.attachments?.length ? { attachments: args.attachments } : {}),
      },
    ],
    tools: [],
    thinking: "disabled",
    maxTokens: 1200,
    signal: args.signal,
  });
  const content = response.content.trim() || "(no answer)";
  if (args.recordExchange) {
    args.recordExchange({
      userInput: text,
      assistantContent: content,
      model: args.model,
      usage: response.usage,
      reasoningContent: response.reasoningContent ?? null,
    });
  } else if (args.appendAndPersist) {
    args.appendAndPersist({
      role: "user",
      content: text,
      ...(args.attachments?.length ? { attachments: args.attachments } : {}),
    });
    args.appendAndPersist({
      role: "assistant",
      content,
      ...(response.reasoningContent ? { reasoning_content: response.reasoningContent } : {}),
    });
  }
  const dollars = costUsd(args.model, response.usage, undefined, {
    providerId: args.client.providerId,
  });
  args.emit({
    type: "model.final",
    id: id++,
    ts: ts(),
    turn: args.turn,
    content,
    ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
    usage: {
      prompt_tokens: response.usage.promptTokens,
      completion_tokens: response.usage.completionTokens,
      total_tokens: response.usage.totalTokens,
      prompt_cache_hit_tokens: response.usage.promptCacheHitTokens,
      prompt_cache_miss_tokens: response.usage.promptCacheMissTokens,
    },
    toolCalls: [],
    costUsd: dollars,
  });
  args.emit({ type: "$turn_complete" });
  return { content, usage: response.usage, costUsd: dollars };
}
