import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACTION_SUMMARY_MARKER } from "@jupiter/core-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatResponse, DeepSeekClient, Usage } from "../src/client.js";
import { loadPricingOverride } from "../src/config.js";
import {
  PREDICTION_CONTEXT_TOKENS,
  PREDICTION_IMAGE_MARKER,
  estimatePredictionTokens,
  parsePrediction,
  predictNextMessage,
  predictionCostUsd,
  predictionMaxCostUsd,
  projectPredictionContext,
} from "../src/desktop/prompt-prediction.js";
import * as tokenizer from "../src/tokenizer.js";
import type { ChatMessage, ChatRequestOptions } from "../src/types.js";

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadPricingOverride: vi.fn(() => ({})),
  loadRateLimit: vi.fn(() => undefined),
}));

const model = "deepseek-chat";
const providerId = "deepseek-official";
const history: readonly ChatMessage[] = Object.freeze([
  Object.freeze({ role: "user", content: "Review the implementation" }),
  Object.freeze({ role: "assistant", content: "The implementation looks correct." }),
]);
const usage = new Usage(100, 20, 120, 10, 90);
let home: string;

function response(patch: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content: '{"suggestion":"Add a regression test"}',
    reasoningContent: null,
    toolCalls: [],
    usage,
    usageComplete: true,
    finishReason: "stop",
    raw: {},
    ...patch,
  };
}

function client(reply = response(), dialect: DeepSeekClient["dialect"] = "deepseek") {
  return { providerId, dialect, chat: vi.fn(async (_opts: ChatRequestOptions) => reply) };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "jupiter-prediction-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  mkdirSync(join(home, ".jupiter"));
  writeFileSync(join(home, ".jupiter", "config.json"), "{}");
  vi.setSystemTime(new Date("2026-10-18T00:00:00Z"));
  vi.mocked(loadPricingOverride).mockReset().mockReturnValue({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("prediction JSON contract", { retry: 0 }, () => {
  it("accepts only a single suggestion string or null and counts Unicode code points", () => {
    expect(parsePrediction('{"suggestion":"  next step  "}')).toEqual({ text: "next step" });
    expect(parsePrediction('{"suggestion":null}')).toEqual({ text: null, reason: "no-suggestion" });
    expect(parsePrediction(JSON.stringify({ suggestion: "\u{1f600}".repeat(240) })).text).toBe(
      "\u{1f600}".repeat(240),
    );
    expect(parsePrediction('{"\\u0073uggestion":"next"}')).toEqual({ text: "next" });
  });

  it.each([
    "not JSON",
    '```json\n{"suggestion":"next"}\n```',
    'prefix {"suggestion":"next"}',
    '{"suggestion":"next"} trailing',
    '{"suggestion":"next"}{"suggestion":"other"}',
    '{"suggestion":"first","suggestion":"second"}',
    '{"suggestion":"first","\\u0073uggestion":"second"}',
    '{"suggestion":null,"suggestion":"second"}',
    '{"suggestion":"next","extra":true}',
    '{"suggestion":"next","__proto__":{}}',
    '{"__proto__":{"suggestion":"next"}}',
    '{"suggestion":["next"]}',
    '{"suggestion":{"text":"next"}}',
    '{"suggestion":42}',
    '{"suggestion":true}',
    '[{"suggestion":"next"}]',
    '"next"',
    "null",
    "{}",
    '{"suggestion":""}',
    '{"suggestion":"   "}',
    JSON.stringify({ suggestion: "first\nsecond" }),
    JSON.stringify({ suggestion: "first\rsecond" }),
    JSON.stringify({ suggestion: "first\u2028second" }),
    JSON.stringify({ suggestion: "first\u2029second" }),
    JSON.stringify({ suggestion: "first\u0000second" }),
    JSON.stringify({ suggestion: "\ud800" }),
    JSON.stringify({ suggestion: "a".repeat(241) }),
    JSON.stringify({ suggestion: "\u{1f600}".repeat(241) }),
  ])("rejects malicious or out-of-contract JSON: %s", (content) => {
    expect(parsePrediction(content)).toMatchObject({ text: null, reason: expect.any(String) });
  });
});

describe("memory-window context projection", { retry: 0 }, () => {
  it("copies only role/content, preserves the existing summary, and never forwards pixels", () => {
    const image = Object.freeze({
      kind: "image" as const,
      id: "a".repeat(64),
      name: "secret-image.png",
      mime: "image/png" as const,
      bytes: 1,
      width: 1,
      height: 1,
    });
    const messages: readonly ChatMessage[] = Object.freeze([
      Object.freeze({
        role: "assistant",
        content: `${COMPACTION_SUMMARY_MARKER}Earlier context`,
        sourceAttachments: Object.freeze([image]),
      }) as unknown as ChatMessage,
      Object.freeze({
        role: "user",
        content: "Check this image",
        attachments: Object.freeze([image]),
        clientId: "private-id",
      }) as unknown as ChatMessage,
      Object.freeze({
        role: "assistant",
        content: "Checking",
        reasoning_content: "private reasoning",
        prefix: true,
        tool_calls: [{ function: { name: "read", arguments: "secret" } }],
      }),
      Object.freeze({ role: "tool", content: "private tool result", tool_call_id: "private" }),
      Object.freeze({ role: "assistant", content: "Done", name: "private-name" }),
    ]);
    const before = JSON.stringify(messages);
    const projected = projectPredictionContext(messages);
    expect(projected.reason).toBeUndefined();
    expect(projected.messages.some((m) => m.content?.includes("Earlier context"))).toBe(true);
    expect(projected.messages.some((m) => m.content?.includes(PREDICTION_IMAGE_MARKER))).toBe(true);
    for (const message of projected.messages) {
      expect(Object.keys(message).sort()).toEqual(["content", "role"]);
      expect(message.role).not.toBe("tool");
      expect(messages.includes(message)).toBe(false);
    }
    expect(JSON.stringify(projected.messages)).not.toMatch(/private|secret-image|jupiter-image/);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("projects runtime multimodal parts without leaking image URLs or metadata", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Explain this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,SECRET" } },
          { type: "input_image", image_url: "https://secret.invalid/pixel" },
        ],
      },
      { role: "assistant", content: "It is a diagram." },
    ] as unknown as ChatMessage[];
    const result = projectPredictionContext(messages);
    expect(result.messages.find((m) => m.role === "user")?.content).toBe(
      `Explain this\n${PREDICTION_IMAGE_MARKER}`,
    );
    expect(JSON.stringify(result)).not.toMatch(/SECRET|secret.invalid|image_url/);
  });

  it("keeps newest complete turns intact within 6000 tokens including system/wrappers", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "Existing summary" }];
    for (let i = 0; i < 100; i++) {
      messages.push(
        { role: "user", content: `Question ${i}: ${"token ".repeat(200)}` },
        { role: "assistant", content: `Answer ${i}: ${"word ".repeat(200)}` },
      );
    }
    const result = projectPredictionContext(messages);
    expect(result.reason).toBeUndefined();
    expect(result.estimatedTokens).toBe(estimatePredictionTokens(result.messages));
    expect(result.estimatedTokens).toBeLessThanOrEqual(PREDICTION_CONTEXT_TOKENS);
    expect(result.messages.some((m) => m.content === "Existing summary")).toBe(true);
    expect(result.messages.at(-2)?.content).toContain("Question 99");
    expect(result.messages.at(-1)?.content).toContain("Answer 99");
    expect(result.messages.some((m) => m.content?.startsWith("Question 0:"))).toBe(false);
    const turns = result.messages.filter((m) => m.role === "user" || m.role === "assistant");
    for (let i = 0; i < turns.length; i += 2) {
      expect(turns[i]?.role).toBe("user");
      expect(turns[i + 1]?.role).toBe("assistant");
    }
  });

  it.each(
    [
      [],
      [{ role: "assistant", content: "Orphan" }],
      [{ role: "user", content: "Pending" }],
      [...history, { role: "user", content: "New pending turn" }],
      [
        history[0],
        {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "x", arguments: "{}" } }],
        },
      ],
      [...history, { role: "tool", content: "Pending tool result" }],
    ].map((messages) => ({ messages })),
  )(
    "skips incomplete or absent latest rounds without asking on stale history",
    async ({ messages }) => {
      const mock = client();
      const result = await predictNextMessage({
        client: mock,
        model,
        history: messages as ChatMessage[],
      });
      expect(result.text).toBeNull();
      expect(result.reason).toBeDefined();
      expect(mock.chat).not.toHaveBeenCalled();
    },
  );

  it("skips an oversized necessary latest turn rather than truncating or falling back", async () => {
    const mock = client();
    const messages: ChatMessage[] = [
      ...history,
      { role: "user", content: "huge ".repeat(20_000) },
      history[1]!,
    ];
    const result = await predictNextMessage({ client: mock, model, history: messages });
    expect(result).toMatchObject({ text: null, reason: "context-too-long" });
    expect(mock.chat).not.toHaveBeenCalled();
    expect(messages[2]?.content).toBe("huge ".repeat(20_000));
  });
});

describe("exact preflight context guard", { retry: 0 }, () => {
  it("rejects a sampled whitespace sandwich whose exact text count exceeds 6000", async () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: " ".repeat(1100) + "中文内容需要逐字计算".repeat(1500) + " ".repeat(1100),
      },
      { role: "assistant", content: "Done" },
    ];
    const projected = projectPredictionContext(messages);
    expect(projected.reason).toBeUndefined();
    expect(projected.estimatedTokens).toBeLessThan(6000);
    expect(await tokenizer.countRequestTokens(projected.messages, [], true)).toBeGreaterThan(9000);
    const mock = client();
    await expect(
      predictNextMessage({ client: mock, model, history: messages }),
    ).resolves.toMatchObject({
      text: null,
      reason: "context-too-long",
    });
    expect(mock.chat).not.toHaveBeenCalled();
  });

  it.each([6000, 6001])(
    "checks the final projection including prompt/wrappers at %i",
    async (tokens) => {
      const count = vi.spyOn(tokenizer, "countRequestTokens").mockResolvedValue(tokens);
      const mock = client();
      const signal = new AbortController().signal;
      const result = await predictNextMessage({ client: mock, model, history, signal });
      expect(count).toHaveBeenCalledTimes(1);
      expect(count).toHaveBeenCalledWith(
        projectPredictionContext(history).messages,
        [],
        true,
        signal,
      );
      expect(mock.chat).toHaveBeenCalledTimes(tokens > 6000 ? 0 : 1);
      if (tokens > 6000) expect(result.reason).toBe("context-too-long");
      else expect(mock.chat.mock.calls[0]![0].messages).toEqual(count.mock.calls[0]![0]);
    },
  );

  it("cancels during async counting without starting a chat", async () => {
    const controller = new AbortController();
    const mock = client();
    vi.spyOn(tokenizer, "countRequestTokens").mockImplementation(
      async (_messages, _tools, _drop, signal) => {
        expect(signal).toBe(controller.signal);
        await Promise.resolve();
        controller.abort();
        signal?.throwIfAborted();
        return 100;
      },
    );
    await expect(
      predictNextMessage({ client: mock, model, history, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.chat).not.toHaveBeenCalled();
  });

  it("propagates a counter failure without issuing a request", async () => {
    const error = new Error("local count failed");
    vi.spyOn(tokenizer, "countRequestTokens").mockRejectedValue(error);
    const mock = client();
    await expect(predictNextMessage({ client: mock, model, history })).rejects.toBe(error);
    expect(mock.chat).not.toHaveBeenCalled();
  });

  it("allows the event loop to cancel real exact counting before any request", async () => {
    const controller = new AbortController();
    const mock = client();
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: " ".repeat(1100) + "中文内容需要逐字计算".repeat(1500) + " ".repeat(1100),
      },
      { role: "assistant", content: "Done" },
    ];
    const abort = setImmediate(() => controller.abort());
    try {
      await expect(
        predictNextMessage({ client: mock, model, history: messages, signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(mock.chat).not.toHaveBeenCalled();
    } finally {
      clearImmediate(abort);
    }
  });
});

describe("single-attempt prediction and accounting", { retry: 0 }, () => {
  it.each(["deepseek", "openai-compatible"] as const)(
    "uses portable JSON instructions for %s",
    async (dialect) => {
      const mock = client(response(), dialect);
      const signal = new AbortController().signal;
      const result = await predictNextMessage({ client: mock, model, history, signal });
      expect(result).toMatchObject({ text: "Add a regression test", usage, usageComplete: true });
      expect(result.costUsd).toBeCloseTo((10 * 0.007 + 90 * 0.22 + 20 * 0.66) / 1_000_000, 12);
      expect(mock.chat).toHaveBeenCalledTimes(1);
      const request = mock.chat.mock.calls[0]![0];
      expect(request).toMatchObject({
        model,
        tools: [],
        disableRetry: true,
        maxTokens: 512,
        signal,
      });
      expect(request.messages[0]?.content).toMatch(/JSON/);
      expect(request.messages[0]?.content).toMatch(/suggestion/);
      expect(request).not.toHaveProperty("responseFormat");
      expect(request).not.toHaveProperty("reasoningEffort");
      if (dialect === "deepseek") expect(request.thinking).toBe("disabled");
      else expect(request).not.toHaveProperty("thinking");
    },
  );

  it.each([
    { content: '{"suggestion":null}' },
    { content: "invalid" },
    { finishReason: "length" as const },
    { finishReason: "unknown" as const },
    { finishReason: "content_filter" as const },
    { finishReason: "tool_calls" as const },
    { toolCalls: [{ function: { name: "shell", arguments: "{}" } }] },
  ])("preserves billable usage/cost when output is unusable: %j", async (patch) => {
    const mock = client(response({ ...patch, usageComplete: false }));
    const result = await predictNextMessage({ client: mock, model, history });
    expect(result).toMatchObject({
      text: null,
      usage,
      usageComplete: false,
      reason: expect.any(String),
    });
    expect(result.costUsd).toBeGreaterThan(0);
    expect(mock.chat).toHaveBeenCalledTimes(1);
  });

  it("does not fabricate cache hits or mutate Usage when third-party cache-miss is absent", () => {
    vi.mocked(loadPricingOverride).mockReturnValue({
      custom: { inputCacheHit: 1, inputCacheMiss: 3, output: 5 },
    });
    const uncached = Usage.fromApi({ prompt_tokens: 100, completion_tokens: 20 }, false);
    expect(predictionCostUsd("custom", uncached, undefined, "gateway")).toBe(0.0004);
    expect(uncached.promptCacheHitTokens).toBe(0);
    expect(uncached.promptCacheMissTokens).toBe(0);
    const cached = Usage.fromApi(
      { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 10 },
      false,
    );
    expect(predictionCostUsd("custom", cached, undefined, "gateway")).toBe(0.00038);
    expect(cached.promptCacheMissTokens).toBe(0);
  });

  it("captures pricing before the request even if settings change before the response", async () => {
    vi.mocked(loadPricingOverride).mockReturnValue({
      custom: { inputCacheHit: 1, inputCacheMiss: 3, output: 5 },
    });
    const mock = client();
    mock.chat.mockImplementation(async () => {
      vi.mocked(loadPricingOverride).mockReturnValue({
        custom: { inputCacheHit: 100, inputCacheMiss: 300, output: 500 },
      });
      return response({
        usage: Usage.fromApi({ prompt_tokens: 100, completion_tokens: 20 }, false),
      });
    });
    const result = await predictNextMessage({
      client: { ...mock, providerId: "gateway" },
      model: "custom",
      history,
      configPath: "/mock/config.json",
    });
    expect(result.costUsd).toBe(0.0004);
    expect(loadPricingOverride).toHaveBeenCalledTimes(1);
    expect(loadPricingOverride).toHaveBeenCalledWith("/mock/config.json");
  });

  it.each([0, -1, 0.000001, Number.NaN])(
    "does not call when budget is invalid or below the upper bound: %s",
    async (remainingBudgetUsd) => {
      const mock = client();
      const result = await predictNextMessage({ client: mock, model, history, remainingBudgetUsd });
      expect(result.text).toBeNull();
      expect(mock.chat).not.toHaveBeenCalled();
    },
  );

  it("allows the exact conservative upper bound and checks cache-hit rates too", async () => {
    const bound = predictionMaxCostUsd(model, undefined, providerId)!;
    expect(bound).toBeCloseTo((6000 * 0.22 + 512 * 0.66) / 1_000_000, 12);
    const mock = client();
    await predictNextMessage({ client: mock, model, history, remainingBudgetUsd: bound });
    expect(mock.chat).toHaveBeenCalledTimes(1);
    vi.mocked(loadPricingOverride).mockReturnValue({
      expensive: { inputCacheHit: 10, inputCacheMiss: 1, output: 2 },
    });
    expect(predictionMaxCostUsd("expensive", undefined, "custom")).toBe(
      (6000 * 10 + 512 * 2) / 1_000_000,
    );
  });

  it.each([undefined, null, 1])(
    "unknown provider price is not inferred from the model alias; budget=%s",
    async (remainingBudgetUsd) => {
      const mock = { ...client(response(), "openai-compatible"), providerId: "unknown-gateway" };
      const result = await predictNextMessage({ client: mock, model, history, remainingBudgetUsd });
      expect(result.costUsd).toBeNull();
      if (remainingBudgetUsd != null) {
        expect(result).toMatchObject({ text: null, reason: "pricing-unknown" });
        expect(mock.chat).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ text: "Add a regression test", usage });
        expect(mock.chat).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("skips unknown models with a budget, including on the official provider", async () => {
    const mock = client();
    const result = await predictNextMessage({
      client: mock,
      model: "unknown",
      history,
      remainingBudgetUsd: 1,
    });
    expect(result).toMatchObject({ text: null, costUsd: null, reason: "pricing-unknown" });
    expect(mock.chat).not.toHaveBeenCalled();
  });

  it("propagates request failure once without exposing it as suggestion/reason text", async () => {
    const error = new Error("SECRET endpoint credentials");
    const mock = client();
    mock.chat.mockRejectedValue(error);
    await expect(predictNextMessage({ client: mock, model, history })).rejects.toBe(error);
    expect(mock.chat).toHaveBeenCalledTimes(1);
  });

  it("does not start a request with an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const mock = client();
    await expect(
      predictNextMessage({ client: mock, model, history, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.chat).not.toHaveBeenCalled();
  });

  it("keeps accounting if an abort races with a completed response", async () => {
    const controller = new AbortController();
    const mock = client();
    mock.chat.mockImplementation(async () => {
      controller.abort();
      return response();
    });
    const result = await predictNextMessage({
      client: mock,
      model,
      history,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ text: null, usage, usageComplete: true, reason: "aborted" });
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

describe("mocked fetch integration (never real API)", { retry: 0 }, () => {
  it("uses one text-only compatible chat request and accounts for omitted cache counters", async () => {
    vi.mocked(loadPricingOverride).mockReturnValue({
      custom: { inputCacheHit: 1, inputCacheMiss: 3, output: 5 },
    });
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"suggestion":"Continue"}' }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          }),
          { status: 200 },
        ),
    );
    const api = new DeepSeekClient({
      apiKey: "mock",
      baseUrl: "https://offline.invalid/v1",
      providerId: "gateway",
      fetch,
      retry: { maxAttempts: 4 },
    });
    const result = await predictNextMessage({ client: api, model: "custom", history });
    expect(result).toMatchObject({ text: "Continue", costUsd: 0.0004, usageComplete: true });
    expect(result.usage?.promptCacheMissTokens).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = JSON.parse(
      String((fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1]?.body),
    );
    expect(request.max_tokens).toBe(512);
    expect(request).not.toHaveProperty("thinking");
    expect(request).not.toHaveProperty("response_format");
  });

  it.each(["http", "network"])("does not retry a mocked %s failure", async (kind) => {
    const fetch = vi.fn(async () => {
      if (kind === "network") throw new Error("network failed");
      return new Response('{"error":{"message":"unavailable"}}', { status: 503 });
    });
    const api = new DeepSeekClient({
      apiKey: "mock",
      baseUrl: "https://offline.invalid",
      fetch,
      retry: { maxAttempts: 4 },
    });
    await expect(predictNextMessage({ client: api, model, history })).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("passes the host timeout to fetch and never retries cancellation", async () => {
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init!.signal!;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const api = new DeepSeekClient({
      apiKey: "mock",
      baseUrl: "https://offline.invalid",
      fetch,
      retry: { maxAttempts: 4 },
    });
    await expect(
      predictNextMessage({ client: api, model, history, signal: AbortSignal.timeout(30) }),
    ).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
