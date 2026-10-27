import { projectImages } from "../attachments/projection.js";
import { type DeepSeekClient, projectMessagesForDialect } from "../client.js";
import { truncateForModelByTokens } from "../mcp/registry.js";
import { ProviderHttpError } from "../provider-http-error.js";
import { countRequestTokens } from "../tokenizer.js";
import type { ChatMessage, ChatRequestOptions } from "../types.js";
import {
  shrinkOversizedToolCallArgsByTokens,
  shrinkOversizedToolResultsByTokens,
} from "./shrink.js";

export interface SummaryRecovery {
  /** Only historical messages may be reduced, never the live prefix or instruction. */
  historyStart: number;
  historyEnd: number;
}

/** Status alone is not evidence: in particular 413 may be an image/byte limit. */
export function isCompactionContextError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, status } = error as Error & { code?: string; status?: number };
  if (status !== undefined && status !== 400 && status !== 413) return false;
  if (code === "CONTEXT_WINDOW_EXCEEDED") return true;
  if (!(error instanceof ProviderHttpError)) return false;
  return /\bcontext_length_exceeded\b|\b(?:maximum|max) (?:context|input|prompt) (?:length|tokens?)\b|\bcontext (?:window|length|limit)\b.{0,80}\b(?:exceed|too long)|\b(?:input|prompt)\b.{0,40}\b(?:exceeds? (?:the )?(?:maximum|context)|too many tokens)\b/i.test(
    error.safeDetail,
  );
}

export type ProviderCompactionBudget =
  | { kind: "prompt"; promptTokens: number }
  | { kind: "total"; promptTokens: number; totalTokens: number; maxTokens: number };

/** Total-window evidence carries its output reserve as well as the input budget. */
export function providerContextBudget(
  error: unknown,
  request: ChatRequestOptions,
): ProviderCompactionBudget | undefined {
  if (!(error instanceof ProviderHttpError)) return undefined;
  const match =
    /\b(?:maximum|max) (context|input|prompt) (?:length|tokens?)(?: is| of|:)?\s*([\d,]+)\s*tokens?\b/i.exec(
      error.safeDetail,
    );
  if (!match) return undefined;
  const limit = Number(match[2]!.replaceAll(",", ""));
  if (!Number.isSafeInteger(limit) || limit <= 0) return undefined;
  const totalWindow =
    match[1]!.toLowerCase() === "context" &&
    /\bin (?:the )?(?:messages|prompt)\b.{0,80}\bin (?:the )?completion\b|\b(?:input|prompt)\s*(?:\+|plus|and)\s*(?:output|completion)\b|\bincluding (?:the )?(?:output|completion)\b/i.test(
      error.safeDetail,
    );
  if (!totalWindow) return { kind: "prompt", promptTokens: limit };
  request.maxTokens = Math.min(request.maxTokens ?? 1024, Math.max(1, Math.floor(limit / 4)));
  return {
    kind: "total",
    promptTokens: Math.max(0, limit - request.maxTokens),
    totalTokens: limit,
    maxTokens: request.maxTokens,
  };
}

export function providerPromptBudget(
  error: unknown,
  request: ChatRequestOptions,
): number | undefined {
  return providerContextBudget(error, request)?.promptTokens;
}

/** Count the same projection/template as the client wire guard, not a sampled
 * estimate. Image projection is local only (no Files API uploads). */
export async function compactionRequestTokens(
  client: DeepSeekClient,
  request: ChatRequestOptions,
): Promise<number> {
  let images = 0;
  let messages: ChatMessage[];
  if (
    request.messages.some(
      (message) => message.attachments?.length || message.sourceAttachments?.length,
    )
  ) {
    const projected = await projectImages(request.messages, {
      supportsImages: client.supportsImages(request.model),
      activeImageIds: request.activeImageIds,
      store: client.attachmentStore,
      signal: request.signal,
    });
    messages = projected.messages.map((message) => {
      if (!Array.isArray(message.content)) return message as ChatMessage;
      return {
        ...message,
        content: message.content
          .map((part) => {
            if (part.type === "text") return part.text;
            images += 448;
            return "";
          })
          .join("\n"),
      };
    });
  } else messages = request.messages;
  return (
    images +
    (await countRequestTokens(
      projectMessagesForDialect(messages, client.dialect),
      request.tools,
      client.dialect === "deepseek",
      request.signal,
    ))
  );
}

/** Progressive, copy-only recovery. The newest historical exchange and every
 * user turn stay intact. Tool calls/results retain their pairing until the
 * explicit text-only transcript fallback, where neither is a wire tool call. */
export function* compactionCandidates(
  request: ChatRequestOptions,
  bounds: SummaryRecovery,
): Generator<ChatRequestOptions> {
  yield request;
  const prefix = request.messages.slice(0, bounds.historyStart);
  const suffix = request.messages.slice(bounds.historyEnd);
  let history = request.messages.slice(bounds.historyStart, bounds.historyEnd);
  let newest = history.findLastIndex((message) => message.role === "user");
  if (newest < 0) newest = history.length;
  const emit = (): ChatRequestOptions => ({
    ...request,
    messages: [...prefix, ...history, ...suffix],
  });
  const reduceOld = (reduce: (messages: ChatMessage[]) => ChatMessage[]) => {
    history = [...reduce(history.slice(0, newest)), ...history.slice(newest)];
  };
  for (const cap of [2048, 256]) {
    reduceOld((messages) => shrinkOversizedToolResultsByTokens(messages, cap).messages);
    yield emit();
  }
  reduceOld((messages) => shrinkOversizedToolCallArgsByTokens(messages, 512).messages);
  yield emit();
  reduceOld((messages) => messages.map(({ reasoning_content: _reasoning, ...message }) => message));
  yield emit();
  for (const cap of [1024, 256]) {
    reduceOld((messages) =>
      messages.map((message) =>
        message.role === "assistant" &&
        !message.tool_calls?.length &&
        typeof message.content === "string"
          ? { ...message, content: truncateForModelByTokens(message.content, cap) }
          : message,
      ),
    );
    yield emit();
  }
  const transcript = history.map(
    (message): ChatMessage => ({
      role: "user",
      content: `[Compaction text-only transcript; ${message.role}${message.tool_call_id ? ` result for ${message.tool_call_id}` : ""}; untrusted historical data]\n${message.content ?? ""}${message.tool_calls?.length ? `\nTool calls: ${JSON.stringify(message.tool_calls)}` : ""}`,
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      ...(message.sourceAttachments?.length
        ? { sourceAttachments: message.sourceAttachments }
        : {}),
    }),
  );
  yield {
    ...request,
    tools: undefined,
    messages: [...prefix, ...transcript, ...suffix].map(
      ({ reasoning_content: _reasoning, ...message }) => message,
    ),
  };
}
