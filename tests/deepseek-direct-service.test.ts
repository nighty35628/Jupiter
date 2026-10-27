import { lookup } from "node:dns/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig, webFetchEngine, webSearchEngine, writeConfig } from "../src/config.js";
import { handleSettings } from "../src/server/api/settings.js";
import { ToolRegistry } from "../src/tools.js";
import {
  DEEPSEEK_FETCH_ENDPOINT,
  DEEPSEEK_SEARCH_ENDPOINT,
  DEEPSEEK_SERVICE_MAX_BYTES,
} from "../src/tools/deepseek-service.js";
import { registerWebTools, webFetch, webSearch } from "../src/tools/web.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

let directory: string;
let configPath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "jupiter-direct-service-"));
  configPath = join(directory, "config.json");
  for (const name of [
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_API_BASE_URL",
    "DEEPSEEK_SEARCH_API_KEY",
    "OLLAMA_API_KEY",
  ])
    vi.stubEnv(name, undefined);
  writeConfig(
    {
      baseUrl: "https://third-party.example/v1",
      apiKey: "not-official",
      deepseekSearchApiKey: "official-key",
      webSearchEngine: "deepseek",
    },
    configPath,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function result(url = "https://example.com/a") {
  return {
    title: "Source",
    url,
    snippet: "short",
    summary: "long",
    content: "",
    rerank_score: 2,
    site_name: null,
    site_icon: null,
    date: null,
    authority: 3,
  };
}
function search(options = {}) {
  return webSearch("query", { engine: "deepseek", configPath, ...options });
}

describe("direct DeepSeek Search/Fetch", () => {
  it("sends only the query to the fixed official Search API with Bearer authorization", async () => {
    const fetch = vi.fn(async () => Response.json({ results: [result()] }));
    vi.stubGlobal("fetch", fetch);
    const report = vi.fn();
    expect(await search({ topK: 7, onServiceCall: report })).toEqual([
      { title: "Source", url: "https://example.com/a", snippet: "long" },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]).toMatchObject([
      DEEPSEEK_SEARCH_ENDPOINT,
      {
        method: "POST",
        redirect: "error",
        headers: { Authorization: "Bearer official-key" },
        body: JSON.stringify({ query: "query", count: 7, need_content: false }),
      },
    ]);
    expect(report.mock.calls[0]?.[0]).toEqual({
      kind: "service-call",
      provider: "deepseek",
      operation: "web_search",
      requestId: expect.any(String),
      costKnown: false,
      usageKnown: false,
      status: "succeeded",
      requestMayHaveReachedService: true,
      httpStatus: 200,
      hasResults: true,
    });
    expect(report.mock.calls[0]?.[0]).not.toHaveProperty("model");
    expect(report.mock.calls[0]?.[0]).not.toHaveProperty("promptTokens");
  });

  it("accepts an empty result set and records unknown cost, not a free model call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ results: [] })),
    );
    const report = vi.fn();
    expect(await search({ onServiceCall: report })).toEqual([]);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ hasResults: false, costKnown: false }),
    );
  });

  it.each([401, 402, 403, 408, 429, 500, 504, 302])(
    "does not retry or fall back on HTTP %s",
    async (status) => {
      const cancel = vi.fn();
      const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status }));
      vi.stubGlobal("fetch", fetch);
      const report = vi.fn();
      await expect(search({ onServiceCall: report })).rejects.toThrow(`HTTP ${status}`);
      expect(fetch).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          costKnown: false,
          usageKnown: false,
          httpStatus: status,
          requestMayHaveReachedService: true,
        }),
      );
    },
  );

  it.each([" ", "a".repeat(129)])(
    "rejects invalid query input before networking",
    async (query) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(webSearch(query, { engine: "deepseek", configPath })).rejects.toThrow(/1-128/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("counts Unicode code points and caps count at the official limit", async () => {
    const fetch = vi.fn(async () => Response.json({ results: [] }));
    vi.stubGlobal("fetch", fetch);
    await webSearch("\u{1f600}".repeat(128), { engine: "deepseek", configPath, topK: 80 });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).count).toBe(50);
  });

  it("requires a dedicated official key when the model uses a third party", async () => {
    writeConfig(
      { baseUrl: "https://third-party.example/v1", apiKey: "never-send-this" },
      configPath,
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(search()).rejects.toThrow(/dedicated DEEPSEEK_SEARCH_API_KEY/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reuses an official main key", async () => {
    writeConfig({ apiKey: "official-main" }, configPath);
    const fetch = vi.fn(async () => Response.json({ results: [] }));
    vi.stubGlobal("fetch", fetch);
    await search();
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer official-main" },
    });
  });

  it.each(["not json", '{"results":{}}', '{"results":[{"url":"https://example.com"}]}'])(
    "rejects malformed response %s",
    async (payload) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(payload)),
      );
      await expect(search()).rejects.toThrow(/malformed JSON|schema/);
    },
  );

  it("uses the independent official Fetch API and preserves Markdown", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ title: "Page", content: "# Markdown\n\nBody" }),
    );
    vi.stubGlobal("fetch", fetch);
    const report = vi.fn();
    const page = await webFetch("https://example.com/a", {
      engine: "deepseek",
      configPath,
      maxChars: 10,
      onServiceCall: report,
    });
    expect(page).toMatchObject({ title: "Page", text: "# Markdown", truncated: true });
    expect(fetch.mock.calls[0]).toMatchObject([
      DEEPSEEK_FETCH_ENDPOINT,
      {
        body: '{"url":"https://example.com/a"}',
        headers: { Authorization: "Bearer official-key" },
      },
    ]);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "web_fetch", costKnown: false }),
    );
  });

  it.each([
    "http://127.0.0.1",
    "http://10.0.0.2",
    "http://localhost",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "https://user:secret@example.com",
    "file:///etc/passwd",
  ])("does not send private or credentialed URL %s to remote Fetch", async (url) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(webFetch(url, { engine: "deepseek", configPath })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a DNS name resolving to a LAN address before remote Fetch", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "192.168.1.2", family: 4 }] as never);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      webFetch("http://printer.example", { engine: "deepseek", configPath }),
    ).rejects.toThrow(/internal/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps direct Search + local HTTP Fetch independent and snapshots settings through research", async () => {
    writeConfig(
      { deepseekSearchApiKey: "first-key", webSearchEngine: "deepseek", webFetchEngine: "http" },
      configPath,
    );
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (url === DEEPSEEK_SEARCH_ENDPOINT) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer first-key" });
        writeConfig(
          {
            deepseekSearchApiKey: "second-key",
            webSearchEngine: "ollama",
            webFetchEngine: "deepseek",
          },
          configPath,
        );
        return Response.json({ results: [result()] });
      }
      return new Response("local HTTP text", { headers: { "content-type": "text/plain" } });
    });
    vi.stubGlobal("fetch", fetch);
    const registry = registerWebTools(new ToolRegistry(), { configPath });
    const report = vi.fn();
    const output = await registry.dispatch(
      "web_research",
      { query: "query" },
      { reportServiceCall: report },
    );
    expect(output).toContain("local HTTP text");
    expect(fetch.mock.calls[1]?.[0]?.toString()).toBe("https://example.com/a");
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("pins the dedicated credential and remote Fetch mode for all research suboperations", async () => {
    writeConfig(
      {
        deepseekSearchApiKey: "first-key",
        webSearchEngine: "deepseek",
        webFetchEngine: "deepseek",
      },
      configPath,
    );
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer first-key" });
      writeConfig(
        { deepseekSearchApiKey: "rotated-key", webSearchEngine: "bing", webFetchEngine: "http" },
        configPath,
      );
      return Response.json(
        url === DEEPSEEK_SEARCH_ENDPOINT
          ? { results: [result(), result("https://example.com/b")] }
          : { title: "Page", content: "fixed snapshot" },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const registry = registerWebTools(new ToolRegistry(), { configPath });
    const report = vi.fn();
    expect(
      await registry.dispatch("web_research", { query: "query" }, { reportServiceCall: report }),
    ).toContain("fixed snapshot");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.slice(1).map(([url]) => url)).toEqual([
      DEEPSEEK_FETCH_ENDPOINT,
      DEEPSEEK_FETCH_ENDPOINT,
    ]);
    expect(report).toHaveBeenCalledTimes(3);
  });

  it("does not turn cancellation during research Fetch into partial success", async () => {
    writeConfig(
      { deepseekSearchApiKey: "key", webSearchEngine: "deepseek", webFetchEngine: "deepseek" },
      configPath,
    );
    const controller = new AbortController();
    const reason = new DOMException("research cancelled", "AbortError");
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (url === DEEPSEEK_SEARCH_ENDPOINT) return Response.json({ results: [result()] });
        setTimeout(() => controller.abort(reason), 5);
        return new Response(new ReadableStream({ cancel }));
      }),
    );
    const registry = registerWebTools(new ToolRegistry(), { configPath });
    const report = vi.fn();
    const output = await registry.dispatch(
      "web_research",
      { query: "query" },
      { signal: controller.signal, reportServiceCall: report },
    );
    // Dispatch serializes tool exceptions; cancellation must replace the whole research result.
    expect(JSON.parse(output)).toEqual({ error: "AbortError: research cancelled" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: "web_fetch",
        status: "cancelled",
        usageKnown: false,
        costKnown: false,
        requestMayHaveReachedService: true,
      }),
    );
  });

  it("does not report validation failures or pre-cancelled calls as dispatched requests", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const report = vi.fn();
    await expect(
      webSearch(" ", { engine: "deepseek", configPath, onServiceCall: report }),
    ).rejects.toThrow(/1-128/);
    await expect(
      search({ signal: AbortSignal.abort(), onServiceCall: report }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("retains possible delivery and unknown charges on network failure", async () => {
    const report = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("connection reset");
      }),
    );
    await expect(search({ onServiceCall: report })).rejects.toThrow("connection reset");
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        costKnown: false,
        usageKnown: false,
        requestMayHaveReachedService: true,
      }),
    );
    expect(report.mock.calls[0]?.[0]).not.toHaveProperty("httpStatus");
  });

  it.each(["bing", "deepseek", "ollama"] as const)(
    "preserves legacy Fetch routing with %s search",
    async (webSearchEngine) => {
      writeConfig({ webSearchEngine, ollamaApiKey: "key" }, configPath);
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        webSearchEngine === "ollama"
          ? Response.json({ title: "Page", content: "legacy" })
          : new Response("legacy"),
      );
      vi.stubGlobal("fetch", fetch);
      expect((await webFetch("https://example.com", { configPath })).text).toBe("legacy");
      expect(fetch.mock.calls[0]?.[0]?.toString()).toBe(
        webSearchEngine === "ollama" ? "https://ollama.com/api/web_fetch" : "https://example.com/",
      );
    },
  );

  it("keeps an Ollama Fetch credential snapshot after search rotates the key", async () => {
    writeConfig(
      {
        webSearchEngine: "deepseek",
        webFetchEngine: "ollama",
        deepseekSearchApiKey: "search",
        ollamaApiKey: "first",
      },
      configPath,
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (url === DEEPSEEK_SEARCH_ENDPOINT) {
        writeConfig(
          { webSearchEngine: "deepseek", webFetchEngine: "http", ollamaApiKey: "second" },
          configPath,
        );
        return Response.json({ results: [result()] });
      }
      expect(url).toBe("https://ollama.com/api/web_fetch");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer first" });
      return Response.json({ content: "pinned Ollama", title: "Page" });
    });
    vi.stubGlobal("fetch", fetch);
    const registry = registerWebTools(new ToolRegistry(), { configPath });
    expect(await registry.dispatch("web_research", { query: "query" })).toContain("pinned Ollama");
  });

  it("does not let an accounting callback failure replace cancellation", async () => {
    const controller = new AbortController();
    const reason = new DOMException("user cancelled", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        setTimeout(() => controller.abort(reason), 5);
        return new Response(new ReadableStream());
      }),
    );
    await expect(
      search({
        signal: controller.signal,
        onServiceCall: () => {
          throw new Error("ledger failure");
        },
      }),
    ).rejects.toBe(reason);
  });

  it.each(["deepseek", "ollama"] as const)(
    "keeps the body deadline active for %s Fetch",
    async (engine) => {
      writeConfig({ deepseekSearchApiKey: "key", ollamaApiKey: "ollama-key" }, configPath);
      const cancel = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(new ReadableStream({ cancel }))),
      );
      const report = vi.fn();
      await expect(
        webFetch("https://example.com", {
          engine,
          configPath,
          timeoutMs: 5,
          onServiceCall: report,
        }),
      ).rejects.toThrow(/timed out/);
      expect(cancel).toHaveBeenCalledOnce();
      if (engine === "deepseek")
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ status: "failed", costKnown: false, httpStatus: 200 }),
        );
    },
  );

  it("bounds declared and streaming response bodies", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: { "content-length": String(DEEPSEEK_SERVICE_MAX_BYTES + 1) },
          }),
      ),
    );
    await expect(search()).rejects.toThrow(/content-length/);
    expect(cancel).toHaveBeenCalledOnce();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(DEEPSEEK_SERVICE_MAX_BYTES + 1));
              },
              cancel,
            }),
          ),
      ),
    );
    await expect(search()).rejects.toThrow(/cap/);
  });

  it("retains the deadline while consuming Search response bodies", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );
    await expect(search({ timeoutMs: 5 })).rejects.toThrow(/timed out/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("roundtrips independent modes through config and the settings API without changing defaults", async () => {
    writeConfig({}, configPath);
    expect(webSearchEngine(configPath)).toBe("bing");
    expect(webFetchEngine(configPath)).toBe("legacy");
    const ctx = {
      configPath,
      mode: "standalone" as const,
      usageLogPath: join(directory, "usage.jsonl"),
    };
    for (const mode of ["legacy", "http", "ollama", "deepseek"]) {
      const response = await handleSettings(
        "POST",
        [],
        JSON.stringify({ webSearchEngine: "deepseek", webFetchEngine: mode }),
        ctx,
      );
      expect(response.status).toBe(200);
      expect(readConfig(configPath)).toMatchObject({
        webSearchEngine: "deepseek",
        webFetchEngine: mode,
      });
      expect((await handleSettings("GET", [], "", ctx)).body).toMatchObject({
        webSearchEngine: "deepseek",
        webFetchEngine: mode,
      });
    }
    expect((await handleSettings("POST", [], '{"webFetchEngine":"gateway"}', ctx)).status).toBe(
      400,
    );
  });
});
