import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type JupiterConfig, resolveDeepSeekSearchCredential, writeConfig } from "../src/config.js";
import {
  DEEPSEEK_NATIVE_SEARCH_ENDPOINT,
  DEEPSEEK_NATIVE_SEARCH_MAX_TOKENS,
  DEEPSEEK_NATIVE_SEARCH_MAX_USES,
  DEEPSEEK_NATIVE_SEARCH_MODEL,
  deepSeekNativeCredentialStatus,
  webSearch,
} from "../src/tools/web.js";

const ENV_NAMES = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_API_BASE_URL",
  "DEEPSEEK_SEARCH_API_KEY",
] as const;

let dir: string;
let configPath: string;
let originalFetch: typeof fetch;
let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jupiter-deepseek-search-"));
  configPath = join(dir, "config.json");
  originalFetch = globalThis.fetch;
  originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function configure(patch: JupiterConfig): void {
  writeConfig(patch, configPath);
}

function nativePayload(content: unknown, usage?: Record<string, number>): object {
  return { content, usage };
}

describe("DeepSeek native search", () => {
  it("sends the fixed official request and parses only structured result blocks", async () => {
    configure({ deepseekSearchApiKey: "search-key", baseUrl: "https://gateway.example/v1" });
    const report = vi.fn();
    globalThis.fetch = vi.fn(async () =>
      Response.json(
        nativePayload(
          [
            {
              type: "text",
              text: "untrusted prose https://ignored.example",
              citations: [
                { url: "https://a.example", cited_text: "excerpt A" },
                { url: "https://a.example", cited_text: "later excerpt" },
              ],
            },
            {
              type: "web_search_tool_result",
              content: [
                { type: "web_search_result", url: "https://a.example", title: "A" },
                { type: "web_search_result", url: "https://a.example", title: "duplicate" },
                { type: "web_search_result", url: "ftp://invalid.example", title: "invalid" },
                { type: "web_search_result", url: "https://b.example", title: "B" },
              ],
            },
          ],
          {
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
        ),
      ),
    ) as typeof fetch;

    const results = await webSearch("jupiter updates", {
      engine: "deepseek-native",
      topK: 5,
      configPath,
      onAuxiliaryUsage: report,
    });

    expect(results).toEqual([
      { title: "A", url: "https://a.example", snippet: "excerpt A" },
      { title: "B", url: "https://b.example", snippet: "" },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(url).toBe(DEEPSEEK_NATIVE_SEARCH_ENDPOINT);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init?.headers).toMatchObject({
      "x-api-key": "search-key",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
    expect(init?.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: DEEPSEEK_NATIVE_SEARCH_MODEL,
      max_tokens: DEEPSEEK_NATIVE_SEARCH_MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Perform a web search for the query: jupiter updates" }],
        },
      ],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: DEEPSEEK_NATIVE_SEARCH_MAX_USES,
        },
      ],
    });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek-native",
        operation: "web_search",
        model: DEEPSEEK_NATIVE_SEARCH_MODEL,
        promptTokens: 15,
        completionTokens: 4,
        cacheHitTokens: 3,
        cacheMissTokens: 12,
        requestId: expect.any(String),
      }),
    );
  });

  it.each([
    "https://gateway.example/v1",
    "https://resource.openai.azure.com",
    "https://open.bigmodel.cn/api/paas/v4",
    "https://api.deepseek.com.evil.example",
    "http://api.deepseek.com",
    "https://api.deepseek.com:444",
    "https://user:pass@api.deepseek.com",
  ])("does not reuse the main key for non-official endpoint %s", (baseUrl) => {
    configure({ baseUrl, apiKey: "main-key" });
    expect(resolveDeepSeekSearchCredential(configPath)).toEqual({
      state: "needs_dedicated_key",
    });
  });

  it("reuses the main key only for default or strict official endpoints", () => {
    configure({ apiKey: "main-key" });
    expect(resolveDeepSeekSearchCredential(configPath)).toMatchObject({
      state: "ready_reusing_main_key",
      apiKey: "main-key",
      source: "main",
    });
    configure({ baseUrl: "https://api.deepseek.com/v1", apiKey: "main-key" });
    expect(resolveDeepSeekSearchCredential(configPath)).toMatchObject({
      state: "ready_reusing_main_key",
      apiKey: "main-key",
    });
  });

  it("allows a dedicated key regardless of the main model endpoint", () => {
    configure({
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "glm-key",
      deepseekSearchApiKey: "search-key",
    });
    expect(resolveDeepSeekSearchCredential(configPath)).toMatchObject({
      state: "ready_with_dedicated_key",
      apiKey: "search-key",
      source: "dedicated",
    });
  });

  it("fails before networking when a custom endpoint has no dedicated search key", async () => {
    configure({ baseUrl: "https://gateway.example/v1", apiKey: "main-key" });
    globalThis.fetch = vi.fn() as typeof fetch;
    await expect(webSearch("query", { engine: "deepseek-native", configPath })).rejects.toThrow(
      /dedicated DEEPSEEK_SEARCH_API_KEY/,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, /rejected the API key/],
    [403, /rejected the API key/],
    [429, /rate limit exceeded/],
    [503, /service error \(503\)/],
  ] as const)("surfaces HTTP %i without fallback", async (status, expected) => {
    configure({ deepseekSearchApiKey: "search-key" });
    globalThis.fetch = vi.fn(async () => new Response("error", { status })) as typeof fetch;
    await expect(webSearch("query", { engine: "deepseek-native", configPath })).rejects.toThrow(
      expected,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]).toBe(DEEPSEEK_NATIVE_SEARCH_ENDPOINT);
  });

  it("distinguishes structured empty results from malformed or prose-only responses", async () => {
    configure({ deepseekSearchApiKey: "search-key" });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(nativePayload([{ type: "web_search_tool_result", content: [] }])),
      )
      .mockResolvedValueOnce(Response.json(nativePayload([{ type: "text", text: "only prose" }])))
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }));

    await expect(webSearch("empty", { engine: "deepseek-native", configPath })).resolves.toEqual(
      [],
    );
    await expect(webSearch("prose", { engine: "deepseek-native", configPath })).rejects.toThrow(
      /no web_search_tool_result blocks/,
    );
    await expect(webSearch("bad", { engine: "deepseek-native", configPath })).rejects.toThrow(
      /malformed JSON/,
    );
  });

  it("honors cancellation before dispatch", async () => {
    configure({ deepseekSearchApiKey: "search-key" });
    globalThis.fetch = vi.fn() as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await expect(
      webSearch("query", {
        engine: "deepseek-native",
        configPath,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("scopes the last failure to the same config and unchanged credential", async () => {
    configure({ deepseekSearchApiKey: "first-search-key" });
    const otherConfigPath = join(dir, "other-config.json");
    writeConfig({ deepseekSearchApiKey: "other-search-key" }, otherConfigPath);
    globalThis.fetch = vi.fn(async () => new Response("error", { status: 429 })) as typeof fetch;

    await expect(webSearch("query", { engine: "deepseek-native", configPath })).rejects.toThrow(
      /rate limit exceeded/,
    );
    expect(deepSeekNativeCredentialStatus(configPath)).toMatchObject({
      state: "last_request_failed",
      keySource: "dedicated",
    });
    expect(deepSeekNativeCredentialStatus(otherConfigPath)).toMatchObject({
      state: "ready_with_dedicated_key",
    });

    configure({ deepseekSearchApiKey: "rotated-search-key" });
    expect(deepSeekNativeCredentialStatus(configPath)).toMatchObject({
      state: "ready_with_dedicated_key",
    });
  });
});
