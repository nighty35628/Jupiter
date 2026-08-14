import { type EventSourceMessage, createParser } from "eventsource-parser";
import { loadRateLimit, resolveBaseUrlEnv } from "./config.js";
import {
  isStrictOfficialDeepSeekEndpoint,
  normalizeOfficialDeepSeekEffort,
  resolveModelCapability,
} from "./provider-capabilities.js";
import { providerHttpErrorFromResponse } from "./provider-http-error.js";
import { type RetryOptions, fetchWithRetry } from "./retry.js";
import type { ChatMessage, ChatRequestOptions, RawUsage, ToolCall, ToolSpec } from "./types.js";

export class Usage {
  constructor(
    public promptTokens = 0,
    public completionTokens = 0,
    public totalTokens = 0,
    public promptCacheHitTokens = 0,
    public promptCacheMissTokens = 0,
  ) {}

  get cacheHitRatio(): number {
    const denom = this.promptCacheHitTokens + this.promptCacheMissTokens;
    return denom > 0 ? this.promptCacheHitTokens / denom : 0;
  }

  static hasApiUsage(raw: unknown): raw is RawUsage {
    if (!raw || typeof raw !== "object") return false;
    const u = raw as RawUsage;
    return (
      typeof u.prompt_tokens === "number" ||
      typeof u.completion_tokens === "number" ||
      typeof u.total_tokens === "number" ||
      typeof u.prompt_cache_hit_tokens === "number" ||
      typeof u.prompt_cache_miss_tokens === "number" ||
      typeof u.prompt_eval_count === "number" ||
      typeof u.eval_count === "number"
    );
  }

  static fromApi(raw: RawUsage | undefined | null): Usage {
    const u = raw ?? {};
    const promptTokens = u.prompt_tokens ?? u.prompt_eval_count ?? 0;
    const completionTokens = u.completion_tokens ?? u.eval_count ?? 0;
    const cacheHitTokens = u.prompt_cache_hit_tokens ?? 0;
    const cacheMissTokens =
      u.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHitTokens);
    return new Usage(
      promptTokens,
      completionTokens,
      u.total_tokens ?? promptTokens + completionTokens,
      cacheHitTokens,
      cacheMissTokens,
    );
  }
}

export interface ChatResponse {
  content: string;
  reasoningContent: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  usageComplete: boolean;
  finishReason: ChatFinishReason;
  raw: unknown;
}

export type ChatFinishReason =
  | "stop"
  | "length"
  | "content_filter"
  | "tool_calls"
  | "insufficient_system_resource"
  | "unknown";

export function normalizeChatFinishReason(value: unknown): ChatFinishReason {
  if (
    value === "stop" ||
    value === "length" ||
    value === "content_filter" ||
    value === "tool_calls" ||
    value === "insufficient_system_resource"
  ) {
    return value;
  }
  return "unknown";
}

export function chatCompletionsUrl(baseUrl: string, betaPrefix = false): string {
  if (!betaPrefix) return `${baseUrl}/chat/completions`;
  const url = new URL(baseUrl);
  let path = url.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  if (path === "/v1" || path.endsWith("/v1")) path = path.slice(0, -3);
  url.pathname = `${path}/beta/chat/completions`.replace(/\/+/g, "/");
  return url.toString();
}

export interface StreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCallDeltas?: Array<{
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  }>;
  usage?: Usage;
  finishReason?: ChatFinishReason;
  raw: any;
}

export interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance?: string;
  topped_up_balance?: string;
}

export interface UserBalance {
  is_available: boolean;
  balance_infos: BalanceInfo[];
}

/** Largest `total_balance` wins — the wallet the user actually paid for and expects to see ticking down. */
export function pickPrimaryBalance(infos: ReadonlyArray<BalanceInfo>): BalanceInfo | null {
  if (infos.length === 0) return null;
  let best = infos[0]!;
  for (let i = 1; i < infos.length; i++) {
    if (Number(infos[i]!.total_balance) > Number(best.total_balance)) best = infos[i]!;
  }
  return best;
}

export interface ModelInfo {
  id: string;
  object: "model";
  owned_by: string;
}

export interface ModelList {
  object: "list";
  data: ModelInfo[];
}

export interface DeepSeekClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  fetch?: typeof fetch;
  rateLimit?: { rpm?: number };
  /** Retry configuration. Pass `{ maxAttempts: 1 }` to disable retries. */
  retry?: RetryOptions;
}

// DeepSeek's strict JSON parser rejects lone UTF-16 surrogate escapes
// (`\ud800`, `\udc00`) even though JavaScript can carry them in strings.
function replaceLoneSurrogates(value: string): string {
  let out = "";
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
      } else {
        out += value.slice(last, i);
        out += "\uFFFD";
        last = i + 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += value.slice(last, i);
      out += "\uFFFD";
      last = i + 1;
    }
  }
  if (last === 0) return value;
  return out + value.slice(last);
}

function sanitizeJsonTransportValue(value: unknown): unknown {
  if (typeof value === "string") return replaceLoneSurrogates(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonTransportValue(item));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = sanitizeJsonTransportValue(item);
  }
  return out;
}

function stringifyJsonTransport(value: unknown): string {
  return JSON.stringify(sanitizeJsonTransportValue(value));
}

export class DeepSeekClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly streamIdleTimeoutMs: number;
  readonly retry: RetryOptions;
  private readonly _fetch: typeof fetch;
  private readonly minChatIntervalMs: number;
  private nextChatRequestAt = 0;

  constructor(opts: DeepSeekClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "DEEPSEEK_API_KEY is not set. Put it in .env or pass apiKey to DeepSeekClient.",
      );
    }
    this.apiKey = apiKey;
    let url = opts.baseUrl ?? resolveBaseUrlEnv() ?? "https://api.deepseek.com";
    // Manual trim — `/\/+$/` is O(n²) on slash-heavy non-matches per CodeQL js/polynomial-redos.
    while (url.endsWith("/")) url = url.slice(0, -1);
    this.baseUrl = url;
    // 11 min. DeepSeek's load-balancer may keep a connection open for
    // up to 10 minutes while the request waits in queue (non-streaming
    // sends empty lines, streaming sends `:` SSE keep-alive comments —
    // both are invisible to our parsers, so neither surfaces until the
    // real response starts). Timing out at the legacy 2-min default
    // killed queued requests prematurely, burned the queue slot on
    // retry, and could loop through the whole queue repeatedly.
    // Setting 11 min lets the server's own 10-min cap close the
    // connection first (clean EOF → natural retry), and our timer
    // is a safety net for genuinely hung sockets.
    this.timeoutMs = opts.timeoutMs ?? 660_000;
    // Separate body-idle watchdog: keeps the long queue timeout above, but
    // fails streams that have started and then stop delivering any bytes.
    this.streamIdleTimeoutMs = opts.streamIdleTimeoutMs ?? 120_000;
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.retry = opts.retry ?? {};
    const rpm = opts.rateLimit?.rpm ?? loadRateLimit()?.rpm;
    this.minChatIntervalMs = rpm ? Math.ceil(60_000 / rpm) : 0;
  }

  private async waitForChatRateLimit(signal?: AbortSignal): Promise<void> {
    if (this.minChatIntervalMs <= 0) return;
    const now = Date.now();
    const waitMs = Math.max(0, this.nextChatRequestAt - now);
    this.nextChatRequestAt = Math.max(now, this.nextChatRequestAt) + this.minChatIntervalMs;
    if (waitMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, waitMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }

  private buildPayload(opts: ChatRequestOptions, stream: boolean) {
    const payload: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream,
    };
    if (stream) payload.stream_options = { include_usage: true };
    if (opts.tools?.length) payload.tools = opts.tools;
    if (opts.temperature !== undefined) payload.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) payload.max_tokens = opts.maxTokens;
    if (opts.responseFormat) payload.response_format = opts.responseFormat;
    const capability = resolveModelCapability(this.baseUrl, opts.model);
    if (opts.thinking) {
      if (capability.dialect === "deepseek") {
        // This client sends raw HTTP. `extra_body` is only an OpenAI SDK
        // escape hatch; DeepSeek's wire contract requires a top-level field.
        payload.thinking = { type: opts.thinking };
      } else if (capability.dialect === "openai-compatible") {
        // Preserve the legacy custom-gateway request shape. A future explicit
        // dialect setting can opt compatible gateways into DeepSeek's wire form.
        payload.extra_body = { thinking: { type: opts.thinking } };
      }
    }
    if (
      opts.reasoningEffort &&
      !(capability.dialect === "deepseek" && opts.thinking === "disabled")
    ) {
      payload.reasoning_effort = capability.officialDeepSeekV4
        ? normalizeOfficialDeepSeekEffort(opts.reasoningEffort)
        : opts.reasoningEffort;
    }
    return payload;
  }

  /** Returns null on failure so callers can degrade — session must keep working without balance UI. */
  async getBalance(opts: { signal?: AbortSignal } = {}): Promise<UserBalance | null> {
    try {
      const resp = await this._fetch(`${this.baseUrl}/user/balance`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: opts.signal,
        redirect: "error",
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as UserBalance;
      if (!data || !Array.isArray(data.balance_infos)) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** Returns null on failure — callers fall back to a hardcoded model hint. */
  async listModels(opts: { signal?: AbortSignal } = {}): Promise<ModelList | null> {
    try {
      const resp = await this._fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: opts.signal,
        redirect: "error",
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as ModelList;
      if (!data || !Array.isArray(data.data)) return null;
      return data;
    } catch {
      return null;
    }
  }

  async chat(opts: ChatRequestOptions): Promise<ChatResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new Error(`DeepSeek request timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    // Combine — `opts.signal ?? ctrl.signal` orphans the timer when the
    // caller passes a signal, so timeoutMs never reaches fetch.
    const signal = opts.signal ? AbortSignal.any([opts.signal, ctrl.signal]) : ctrl.signal;

    try {
      await this.waitForChatRateLimit(signal);
      const resp = await fetchWithRetry(
        this._fetch,
        chatCompletionsUrl(this.baseUrl, opts.betaPrefix),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: stringifyJsonTransport(this.buildPayload(opts, false)),
          signal,
          redirect: "error",
        },
        { ...this.retry, ...(opts.disableRetry ? { maxAttempts: 1 } : {}), signal },
      );
      if (!resp.ok) {
        throw await providerHttpErrorFromResponse(resp, {
          baseUrl: this.baseUrl,
          knownSecrets: [this.apiKey],
        });
      }
      const data: any = await resp.json();
      const responseChoice = data.choices?.[0] ?? {};
      const choice = responseChoice.message ?? {};
      const rawUsage = data.usage ?? (Usage.hasApiUsage(data) ? data : undefined);
      return {
        content: choice.content ?? "",
        reasoningContent: choice.reasoning_content ?? null,
        toolCalls: choice.tool_calls ?? [],
        usage: Usage.fromApi(rawUsage),
        usageComplete: Usage.hasApiUsage(rawUsage),
        finishReason: normalizeChatFinishReason(responseChoice.finish_reason),
        raw: data,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async *stream(opts: ChatRequestOptions): AsyncGenerator<StreamChunk> {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new Error(`DeepSeek stream timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    // Combine — `opts.signal ?? ctrl.signal` orphans the timer when the
    // caller passes a signal, leaving a stalled SSE body to hang forever
    // on reader.read() (issue #1535).
    const signal = opts.signal ? AbortSignal.any([opts.signal, ctrl.signal]) : ctrl.signal;

    let resp: Response;
    try {
      await this.waitForChatRateLimit(signal);
      // Only the initial fetch is retried. Once the server has started sending
      // the stream body we do NOT retry — a mid-stream retry would re-bill and
      // desync the session context.
      resp = await fetchWithRetry(
        this._fetch,
        chatCompletionsUrl(this.baseUrl, opts.betaPrefix),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: stringifyJsonTransport(this.buildPayload(opts, true)),
          signal,
          redirect: "error",
        },
        { ...this.retry, ...(opts.disableRetry ? { maxAttempts: 1 } : {}), signal },
      );
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
    if (!resp.ok) {
      clearTimeout(timer);
      throw await providerHttpErrorFromResponse(resp, {
        baseUrl: this.baseUrl,
        knownSecrets: [this.apiKey],
      });
    }
    if (!resp.body) {
      clearTimeout(timer);
      throw new Error("DeepSeek stream response has no body");
    }

    const queue: StreamChunk[] = [];
    const requireDoneMarker = isStrictOfficialDeepSeekEndpoint(this.baseUrl);
    let done = false;
    let sawDoneMarker = false;
    let sawTerminalFinishReason = false;
    let parseError: Error | null = null;
    const parser = createParser({
      onEvent: (ev: EventSourceMessage) => {
        if (done) return;
        if (ev.data === "") return;
        if (ev.data === "[DONE]") {
          sawDoneMarker = true;
          done = true;
          return;
        }
        try {
          const json = JSON.parse(ev.data);
          const delta = json.choices?.[0]?.delta ?? {};
          const rawFinishReason = json.choices?.[0]?.finish_reason;
          const finishReason =
            rawFinishReason === null || rawFinishReason === undefined
              ? undefined
              : normalizeChatFinishReason(rawFinishReason);
          if (finishReason && finishReason !== "unknown") sawTerminalFinishReason = true;
          const chunk: StreamChunk = { raw: json, finishReason };
          if (typeof delta.content === "string" && delta.content.length > 0) {
            chunk.contentDelta = delta.content;
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            chunk.reasoningDelta = delta.reasoning_content;
          }
          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
            chunk.toolCallDeltas = delta.tool_calls.map((tc: any, position: number) => ({
              index: Number.isInteger(tc?.index) ? tc.index : position,
              id: tc?.id,
              name: tc?.function?.name,
              argumentsDelta: tc?.function?.arguments,
            }));
          }
          const rawUsage = json.usage ?? (Usage.hasApiUsage(json) ? json : undefined);
          if (rawUsage) {
            chunk.usage = Usage.fromApi(rawUsage);
          }
          queue.push(chunk);
        } catch (err) {
          parseError = new Error(
            `DeepSeek stream contained malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
          );
          done = true;
        }
      },
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const readWithIdleTimeout = async () => {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            idleTimer = setTimeout(() => {
              const err = new Error(
                `DeepSeek stream idle timeout after ${this.streamIdleTimeoutMs}ms`,
              );
              ctrl.abort(err);
              reject(err);
            }, this.streamIdleTimeoutMs);
          }),
        ]);
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
    };
    try {
      while (true) {
        if (parseError) throw parseError;
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        let value: Uint8Array | undefined;
        let streamDone: boolean;
        try {
          ({ value, done: streamDone } = await readWithIdleTimeout());
        } catch (readErr) {
          if (readErr instanceof Error && /idle timeout/i.test(readErr.message)) throw readErr;
          const cause = readErr instanceof Error ? readErr : new Error(String(readErr));
          const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
          throw Object.assign(new Error(`SSE body read failed: ${cause.message}`), {
            phase: "stream_body_read" as const,
            code,
          });
        }
        if (streamDone) {
          const tail = decoder.decode();
          if (tail) parser.feed(tail);
          parser.reset({ consume: true });
          if (parseError) throw parseError;
          if (!sawDoneMarker && (requireDoneMarker || !sawTerminalFinishReason)) {
            throw new Error(
              requireDoneMarker
                ? "DeepSeek stream ended before the required [DONE] marker"
                : "Model stream ended without [DONE] or a terminal finish_reason",
            );
          }
          break;
        }
        parser.feed(decoder.decode(value, { stream: true }));
        if (parseError) throw parseError;
      }
      while (queue.length > 0) yield queue.shift()!;
    } finally {
      clearTimeout(timer);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export type { ChatMessage, ToolCall, ToolSpec };
