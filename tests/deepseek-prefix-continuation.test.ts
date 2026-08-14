import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient, chatCompletionsUrl } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ToolRegistry } from "../src/tools.js";

interface Reply {
  content: string;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
}

function fakeChat(replies: Reply[]) {
  const requests: Array<{ url: string; body: Record<string, any> }> = [];
  let index = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ url: String(input), body });
    const reply = replies[index++] ?? replies.at(-1)!;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: reply.content },
            finish_reason: reply.finishReason,
          },
        ],
        usage: {
          prompt_tokens: reply.promptTokens,
          completion_tokens: reply.completionTokens,
          total_tokens: reply.promptTokens + reply.completionTokens,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: reply.promptTokens,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

describe("DeepSeek Beta prefix continuation", () => {
  it("resolves standard and beta URLs for root and /v1 base URLs", () => {
    expect(chatCompletionsUrl("https://api.deepseek.com")).toBe(
      "https://api.deepseek.com/chat/completions",
    );
    expect(chatCompletionsUrl("https://api.deepseek.com", true)).toBe(
      "https://api.deepseek.com/beta/chat/completions",
    );
    expect(chatCompletionsUrl("https://api.deepseek.com/v1", true)).toBe(
      "https://api.deepseek.com/beta/chat/completions",
    );
  });

  it("continues one truncated official V4 response as one assistant message", async () => {
    const upstream = fakeChat([
      { content: "part one", finishReason: "length", promptTokens: 100, completionTokens: 10 },
      { content: " part two", finishReason: "stop", promptTokens: 110, completionTokens: 5 },
    ]);
    const tools = new ToolRegistry();
    tools.register({ name: "noop", readOnly: true, fn: () => "ok" });
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch: upstream.fetch }),
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
      tools,
      model: "deepseek-v4-pro",
      stream: false,
      autoContinueDeepSeek: true,
    });
    const events = [];
    for await (const event of loop.step("write a long answer")) events.push(event);

    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[1]!.url).toBe("https://api.deepseek.com/beta/chat/completions");
    expect(upstream.requests[0]!.body.tools).toHaveLength(1);
    expect(upstream.requests[1]!.body.tools).toBeUndefined();
    expect(upstream.requests[1]!.body.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "part one",
      prefix: true,
    });
    expect(events.filter((event) => event.role === "assistant_final")).toHaveLength(1);
    expect(events.find((event) => event.role === "assistant_final")?.content).toBe(
      "part one part two",
    );
    expect(loop.log.toFullHistory().filter((message) => message.role === "assistant")).toEqual([
      expect.objectContaining({ content: "part one part two" }),
    ]);
    expect(loop.log.toFullHistory().some((message) => message.prefix === true)).toBe(false);
    expect(loop.stats.turns[0]!.usage.promptTokens).toBe(210);
    expect(loop.stats.turns[0]!.usage.completionTokens).toBe(15);
    expect(loop.stats.turns[0]!.contextPromptTokens).toBe(110);
    expect(loop.stats.turns[0]!.usageComplete).toBe(true);
    expect(loop.stats.summary().lastPromptTokens).toBe(110);
  });

  it("skips continuation when the first response leaves too little context", async () => {
    const upstream = fakeChat([
      {
        content: "partial",
        finishReason: "length",
        promptTokens: 1_045_000,
        completionTokens: 1_000,
      },
    ]);
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch: upstream.fetch }),
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "deepseek-v4-flash",
      stream: false,
      autoContinueDeepSeek: true,
    });
    const events = [];
    for await (const event of loop.step("hello")) events.push(event);

    expect(
      upstream.requests.some((request) => request.url.endsWith("/beta/chat/completions")),
    ).toBe(false);
    expect(events.some((event) => event.role === "warning")).toBe(true);
  });

  it("never enables Beta continuation for a custom gateway", async () => {
    const upstream = fakeChat([
      { content: "partial", finishReason: "length", promptTokens: 100, completionTokens: 10 },
    ]);
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({
        apiKey: "sk-test",
        baseUrl: "https://gateway.example/v1",
        fetch: upstream.fetch,
      }),
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "deepseek-v4-pro",
      stream: false,
      autoContinueDeepSeek: true,
    });
    for await (const _event of loop.step("hello")) {
      // drain
    }
    expect(upstream.requests).toHaveLength(1);
  });

  it("makes only one Beta attempt and preserves the first response on failure", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "kept" }, finish_reason: "length" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: { message: "beta unavailable" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch, retry: { maxAttempts: 4 } }),
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "deepseek-v4-pro",
      stream: false,
      autoContinueDeepSeek: true,
    });
    const events = [];
    for await (const event of loop.step("hello")) events.push(event);

    expect(calls).toBe(2);
    expect(events.find((event) => event.role === "assistant_final")?.content).toBe("kept");
    expect(loop.stats.turns[0]!.usageComplete).toBe(false);
  });

  it("does not commit a continuation after the logical session binding changes", async () => {
    const upstream = fakeChat([
      { content: "first", finishReason: "length", promptTokens: 100, completionTokens: 10 },
      { content: " stale", finishReason: "stop", promptTokens: 110, completionTokens: 5 },
    ]);
    let loop: CacheFirstLoop;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await upstream.fetch(input, init);
      if (String(input).endsWith("/beta/chat/completions")) {
        loop.rebindSession(null, { logicalSessionChanged: true });
      }
      return response;
    }) as unknown as typeof globalThis.fetch;
    loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch }),
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "deepseek-v4-pro",
      stream: false,
      autoContinueDeepSeek: true,
    });
    const events = [];
    for await (const event of loop.step("hello")) events.push(event);

    expect(events.some((event) => event.role === "assistant_final")).toBe(false);
    expect(loop.log.toFullHistory().some((message) => message.role === "assistant")).toBe(false);
  });
});
