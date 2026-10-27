import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { loadModel, readConfig, writeConfig } from "../src/config.js";
import { resolveProviderSnapshot } from "../src/provider-runtime.js";

const aliases = [
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-chat",
  "deepseek-reasoner",
];
const official = "https://api.deepseek.com/v1";
const relay = "https://relay.example/v1";
let home: string;
let configPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "jupiter-model-update-"));
  configPath = join(home, "config.json");
  vi.stubEnv("DEEPSEEK_BASE_URL", "");
  vi.stubEnv("DEEPSEEK_API_BASE_URL", "");
  vi.stubEnv("OPENAI_BASE_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function fakeProvider(stream = false) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        stream
          ? 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
          : JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { headers: { "content-type": stream ? "text/event-stream" : "application/json" } },
      ),
  );
}

describe("latest official DeepSeek model migration", { retry: 0 }, () => {
  it.each(aliases)(
    "loads %s as the current Flash ID without rewriting saved configuration",
    (model) => {
      writeConfig({ baseUrl: official, model }, configPath);
      expect(loadModel(configPath)).toBe("deepseek-flash");
      expect(readConfig(configPath).model).toBe(model);
      expect(resolveProviderSnapshot({ configPath }).model).toBe("deepseek-flash");
    },
  );

  it.each(aliases)(
    "retains a third-party model namespace even with DeepSeek protocol: %s",
    (model) => {
      writeConfig({ baseUrl: relay, model, providerDialect: "deepseek" }, configPath);
      const snapshot = resolveProviderSnapshot({ configPath });
      expect(loadModel(configPath)).toBe(model);
      expect(snapshot.model).toBe(model);
    },
  );

  it("uses the actual endpoint override and environment when normalizing a saved model", () => {
    writeConfig({ baseUrl: official, model: "deepseek-v4-flash" }, configPath);
    expect(resolveProviderSnapshot({ configPath, baseUrl: relay }).model).toBe("deepseek-v4-flash");
    vi.stubEnv("DEEPSEEK_BASE_URL", relay);
    expect(loadModel(configPath)).toBe("deepseek-v4-flash");
    writeConfig({ baseUrl: relay, model: "deepseek-v4-flash" }, configPath);
    vi.stubEnv("DEEPSEEK_BASE_URL", official);
    expect(loadModel(configPath)).toBe("deepseek-flash");
  });

  it.each([false, true])(
    "sends the current Flash ID on the actual HTTP %s path",
    async (stream) => {
      const fetch = fakeProvider(stream);
      const client = new DeepSeekClient({ apiKey: "synthetic", baseUrl: official, fetch });
      const request = {
        model: "deepseek-v4-flash-vision-exp",
        messages: [{ role: "user" as const, content: "hello" }],
      };
      if (stream)
        for await (const _chunk of client.stream(request)) {
          /* consume the real stream parser */
        }
      else await client.chat(request);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).model).toBe("deepseek-flash");
      expect(request.model).toBe("deepseek-v4-flash-vision-exp");
      expect(client.supportsImages("deepseek-flash")).toBe(true);
    },
  );

  it("does not rename a third-party HTTP model even when the protocol is DeepSeek", async () => {
    const fetch = fakeProvider();
    const client = new DeepSeekClient({
      apiKey: "synthetic",
      baseUrl: relay,
      dialect: "deepseek",
      fetch,
    });
    await client.chat({ model: "deepseek-v4-flash", messages: [] });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).model).toBe("deepseek-v4-flash");
  });

  it.each([official, relay])(
    "normalizes and deduplicates fetched model choices only on the official endpoint (%s)",
    async (baseUrl) => {
      const ids = [
        "deepseek-v4-flash",
        "deepseek-flash",
        "deepseek-v4-flash-vision-exp",
        "deepseek-v4-pro",
        "future-model",
      ];
      const client = new DeepSeekClient({
        apiKey: "synthetic",
        baseUrl,
        fetch: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                object: "list",
                data: ids.map((id) => ({ id, object: "model", owned_by: "provider" })),
              }),
            ),
        ),
      });
      const list = await client.listModels();
      expect(list?.data.map((model) => model.id)).toEqual(
        baseUrl === official ? ["deepseek-flash", "deepseek-v4-pro", "future-model"] : ids,
      );
    },
  );
});
