import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { DEEPSEEK_CONTEXT_TOKENS } from "../src/telemetry/stats.js";
import { countRequestTokens } from "../src/tokenizer.js";
import { ToolRegistry } from "../src/tools.js";
import type { ChatMessage, ChatRequestOptions } from "../src/types.js";

interface Wire {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  thinking?: { type: string };
  reasoning_effort?: string;
  tools?: unknown[];
}
const messages: ChatMessage[] = [{ role: "user", content: "Synthetic budget check." }];
let home: string;
const loops: CacheFirstLoop[] = [];
const MODEL = "wire-small-fixture";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "jupiter-budget-wire-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});
afterEach(() => {
  for (const loop of loops.splice(0)) loop.dispose();
  delete DEEPSEEK_CONTEXT_TOKENS[MODEL];
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function ok(content = "ok", finish = "stop"): Response {
  return Response.json({
    choices: [{ message: { content }, finish_reason: finish }],
    usage: { prompt_tokens: 30, completion_tokens: 5 },
  });
}
function sse(content = "ok", finish = "stop"): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }], usage: { prompt_tokens: 30, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
function client(
  fetch: typeof globalThis.fetch,
  opts: Partial<ConstructorParameters<typeof DeepSeekClient>[0]> = {},
): DeepSeekClient {
  return new DeepSeekClient({
    baseUrl: "https://api.deepseek.com",
    apiKey: `synthetic-${home}`,
    fetch,
    rateLimit: { rpm: 0 },
    retry: { maxAttempts: 1 },
    ...opts,
  });
}

describe("request budget wire integration", { retry: 0 }, () => {
  for (const stream of [false, true]) {
    it.each([
      ["disabled", "max", 8192],
      ["enabled", "high", 65536],
      ["enabled", "max", 131072],
      [undefined, undefined, 65536],
    ] as const)(
      `sends the reserved output for thinking=%s effort=%s (stream=${stream})`,
      async (thinking, reasoningEffort, output) => {
        const wires: Wire[] = [];
        const provider = client(
          vi.fn(async (_url, init) => {
            wires.push(JSON.parse(String(init?.body)) as Wire);
            return stream ? sse() : ok();
          }),
        );
        const request = { model: "deepseek-flash", messages, thinking, reasoningEffort };
        const budget = provider.getRequestBudget(request);
        if (stream)
          for await (const _chunk of provider.stream(request)) {
            /* drain */
          }
        else await provider.chat(request);
        expect(wires).toHaveLength(1);
        expect(wires[0]!.max_tokens).toBe(output);
        expect(budget.outputReserveTokens).toBe(wires[0]!.max_tokens);
        expect(budget.contextWindowTokens).toBe(1048576);
        expect(budget.safetyTokens).toBe(4096);
        expect(budget.inputLimit).toBe(1048576 - output - 4096);
        if (thinking === "disabled") expect(wires[0]).not.toHaveProperty("reasoning_effort");
      },
    );
  }

  it.each(["openai-compatible", "deepseek"] as const)(
    "keeps unknown third-party output defaults off the %s wire without discovery",
    async (dialect) => {
      const calls: Array<{ url: string; wire: Wire }> = [];
      const provider = client(
        vi.fn(async (url, init) => {
          calls.push({ url: String(url), wire: JSON.parse(String(init?.body)) as Wire });
          return ok();
        }),
        { baseUrl: `https://unknown.example/${home.split("/").at(-1)}`, dialect },
      );
      const request = {
        model: "deepseek-flash",
        messages,
        thinking: "enabled" as const,
        reasoningEffort: "max" as const,
      };
      expect(provider.getRequestBudget(request)).toMatchObject({
        estimated: true,
        maxTokens: undefined,
      });
      await provider.chat(request);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toMatch(/\/chat\/completions$/);
      expect(calls[0]!.wire).not.toHaveProperty("max_tokens");
      expect(calls[0]!.wire.model).toBe("deepseek-flash");
    },
  );

  it("consumes only explicit /models metadata, isolated by endpoint, dialect and credentials", async () => {
    const baseUrl = `https://metadata-wire.example/${home.split("/").at(-1)}`;
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ data: [{ id: MODEL, context_window: 16384, max_output_tokens: 1024 }] }),
    );
    const provider = client(fetch, { baseUrl, dialect: "deepseek" });
    expect(provider.getRequestBudget({ model: MODEL }).source).toBe("fallback");
    expect(fetch).not.toHaveBeenCalled();
    await provider.listModels();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(`${baseUrl}/models`);
    expect(fetch.mock.calls[0]![1]?.method).toBe("GET");
    expect(provider.getRequestBudget({ model: MODEL, maxTokens: 5000 })).toMatchObject({
      source: "metadata",
      contextWindowTokens: 16384,
      maxTokens: 1024,
    });
    expect(
      client(fetch, { baseUrl, dialect: "deepseek" }).getRequestBudget({ model: MODEL }).source,
    ).toBe("metadata");
    for (const changed of [
      { baseUrl: `${baseUrl}/other`, dialect: "deepseek" as const },
      { baseUrl, dialect: "openai-compatible" as const },
      { baseUrl, dialect: "deepseek" as const, apiKey: "changed-synthetic-key" },
    ]) {
      expect(client(fetch, changed).getRequestBudget({ model: MODEL }).source).toBe("fallback");
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["deepseek-v4-flash", "deepseek-chat"])(
    "uses canonical official metadata for the alias actually sent on the wire: %s",
    async (model) => {
      const wires: Wire[] = [];
      const provider = client(
        vi.fn(async (_url, init) => {
          if (init?.method === "GET")
            return Response.json({
              data: [{ id: "deepseek-flash", context_window: 16384, max_output_tokens: 1024 }],
            });
          wires.push(JSON.parse(String(init?.body)) as Wire);
          return ok();
        }),
      );
      await provider.listModels();
      await provider.chat({ model, messages });
      expect(wires[0]!.model).toBe("deepseek-flash");
      expect(wires[0]!.max_tokens).toBe(1024);
      expect(provider.getRequestBudget({ model }).contextWindowTokens).toBe(16384);
    },
  );

  it("does not commit an aborted /models response", async () => {
    const controller = new AbortController();
    const provider = client(
      vi.fn(async () => {
        controller.abort();
        return Response.json({ data: [{ id: MODEL, context_window: 4096 }] });
      }),
    );
    await provider.listModels({ signal: controller.signal });
    expect(provider.getRequestBudget({ model: MODEL }).source).toBe("fallback");
  });

  it("does not learn the local guard's sampled/counting limit as a provider specification", async () => {
    DEEPSEEK_CONTEXT_TOKENS[MODEL] = 64;
    const fetch = vi.fn(async () => ok());
    const provider = client(fetch);
    const learn = vi.spyOn(provider, "learnContextLimit");
    const before = provider.getRequestBudget({ model: MODEL });
    await expect(
      provider.chat({
        model: MODEL,
        messages: [{ role: "user", content: "long synthetic content ".repeat(200) }],
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED" });
    expect(fetch).not.toHaveBeenCalled();
    expect(learn).not.toHaveBeenCalled();
    expect(provider.getRequestBudget({ model: MODEL })).toEqual(before);
    await provider.chat({ model: MODEL, messages: [{ role: "user", content: "short" }] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicitly declared custom prompt cap without granting a built-in name a larger unknown window", () => {
    DEEPSEEK_CONTEXT_TOKENS[MODEL] = 200000;
    const provider = client(
      vi.fn(async () => ok()),
      { baseUrl: `https://legacy-wire.example/${home.split("/").at(-1)}` },
    );
    expect(provider.getRequestBudget({ model: MODEL }).inputLimit).toBe(200000);
    expect(provider.getRequestBudget({ model: "deepseek-flash" }).contextWindowTokens).toBe(131072);
  });

  it("guards input plus reserved output, even when input alone fits the metadata window", async () => {
    const requestMessages: ChatMessage[] = [
      { role: "user", content: "synthetic padding ".repeat(600) },
    ];
    const promptTokens = await countRequestTokens(requestMessages, undefined, true);
    const contextWindow = promptTokens + 512;
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "GET"
        ? Response.json({
            data: [{ id: MODEL, context_window: contextWindow, max_output_tokens: 1024 }],
          })
        : ok(),
    );
    const provider = client(fetch, {
      baseUrl: `https://guard-wire.example/${home.split("/").at(-1)}`,
      dialect: "deepseek",
    });
    await provider.listModels();
    const learn = vi.spyOn(provider, "learnContextLimit");
    expect(promptTokens).toBeLessThan(contextWindow);
    await expect(
      provider.chat({ model: MODEL, messages: requestMessages, maxTokens: 1024 }),
    ).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(learn).not.toHaveBeenCalled();
  });

  it.each([4096, 16384])(
    "sends a usable request-local default under official metadata C=%i",
    async (window) => {
      const wires: Wire[] = [];
      const provider = client(
        vi.fn(async (_url, init) => {
          if (init?.method === "GET")
            return Response.json({
              data: [{ id: "deepseek-flash", context_window: window, max_output_tokens: 393216 }],
            });
          wires.push(JSON.parse(String(init?.body)) as Wire);
          return ok();
        }),
      );
      await provider.listModels();
      expect(provider.getRequestBudget({ model: "deepseek-flash" })).toMatchObject({
        maxTokens: window / 4,
        outputClamped: true,
      });
      await provider.chat({ model: "deepseek-flash", messages });
      expect(wires[0]!.max_tokens).toBe(window / 4);
      expect(
        provider.getRequestBudget({ model: "deepseek-flash", maxTokens: 1000 }).outputClamped,
      ).toBe(false);
    },
  );

  it("budgets official compatibility mode against the thinking fields actually sent", async () => {
    let wire: Wire | undefined;
    const provider = client(
      vi.fn(async (_url, init) => {
        wire = JSON.parse(String(init?.body)) as Wire;
        return ok();
      }),
      { dialect: "openai-compatible" },
    );
    await provider.chat({
      model: "deepseek-flash",
      messages,
      thinking: "disabled",
      reasoningEffort: "max",
    });
    // The official server defaults to thinking/high when neither wire field is present.
    const actualDefault =
      wire?.thinking?.type === "disabled"
        ? 8192
        : wire?.reasoning_effort === "max"
          ? 131072
          : 65536;
    expect(wire?.max_tokens).toBe(actualDefault);
  });

  it.each([false, true])(
    "passes the actual output budget to prefix continuation (stream=%s)",
    async (stream) => {
      const wires: Wire[] = [];
      const provider = client(
        vi.fn(async (_url, init) => {
          const wire = JSON.parse(String(init?.body)) as Wire;
          wires.push(wire);
          const finish = wires.length === 1 ? "length" : "stop";
          return stream ? sse("part", finish) : ok("part", finish);
        }),
      );
      const seen: ChatRequestOptions[] = [];
      const originalChat = provider.chat.bind(provider);
      vi.spyOn(provider, "chat").mockImplementation((opts) => {
        seen.push(opts);
        return originalChat(opts);
      });
      const originalStream = provider.stream.bind(provider);
      vi.spyOn(provider, "stream").mockImplementation((opts) => {
        seen.push(opts);
        return originalStream(opts);
      });
      const tools = new ToolRegistry();
      tools.register({ name: "unused_read_only_tool", readOnly: true, fn: () => "unused" });
      const loop = new CacheFirstLoop({
        client: provider,
        prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
        tools,
        model: "deepseek-flash",
        stream,
        thinkingEnabled: false,
        autoContinueDeepSeek: true,
      });
      loops.push(loop);
      await loop.run("Continue the synthetic answer.");
      expect(wires).toHaveLength(2);
      expect(wires[0]!.max_tokens).toBe(8192);
      expect(wires[0]!.tools).toHaveLength(1);
      expect(wires[1]!.max_tokens).toBeLessThanOrEqual(wires[0]!.max_tokens!);
      expect(wires[1]!.messages.at(-1)).toMatchObject({ prefix: true, content: "part" });
      expect(wires[1]).not.toHaveProperty("tools");
      expect(seen[1]).toMatchObject({ betaPrefix: true, disableRetry: true });
      expect(seen[1]!.tools ?? []).toEqual([]);
    },
  );
});
