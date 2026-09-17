import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";

function okResponse(extra: Record<string, unknown> = {}): Response {
  return Response.json({
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    ...extra,
  });
}

describe("provider client wire contract", () => {
  it("strips DeepSeek-only fields from OpenAI-compatible requests", async () => {
    let payload: Record<string, any> | undefined;
    const client = new DeepSeekClient({
      apiKey: "custom-key",
      baseUrl: "https://relay.example/v1",
      dialect: "openai-compatible",
      providerId: "custom-relay",
      retry: { maxAttempts: 1 },
      fetch: async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        return okResponse();
      },
    });

    const response = await client.chat({
      model: "relay-model",
      messages: [
        { role: "assistant", content: "prior", reasoning_content: "private", prefix: true },
        { role: "user", content: "next" },
      ],
      thinking: "enabled",
      reasoningEffort: "high",
    });

    expect(payload).not.toHaveProperty("thinking");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("extra_body");
    expect(payload?.messages[0]).toEqual({ role: "assistant", content: "prior" });
    expect(response.usage.promptCacheMissTokens).toBe(0);
  });

  it("keeps DeepSeek extensions for an explicit DeepSeek-compatible gateway", async () => {
    let payload: Record<string, any> | undefined;
    const client = new DeepSeekClient({
      apiKey: "gateway-key",
      baseUrl: "https://gateway.example/v1",
      dialect: "deepseek",
      retry: { maxAttempts: 1 },
      fetch: async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        return okResponse();
      },
    });

    await client.chat({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "test" }],
      thinking: "enabled",
      reasoningEffort: "max",
    });

    expect(payload?.thinking).toEqual({ type: "enabled" });
    expect(payload?.reasoning_effort).toBe("max");
  });

  it("does not retry ambiguous network failures for custom providers", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("connection reset");
    });
    const client = new DeepSeekClient({
      apiKey: "custom-key",
      baseUrl: "https://relay.example/v1",
      dialect: "openai-compatible",
      retry: { maxAttempts: 6, retryNetworkErrors: false, retryableStatuses: [429] },
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.chat({ model: "relay-model", messages: [{ role: "user", content: "test" }] }),
    ).rejects.toThrow(/connection reset/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed successful responses instead of committing empty output", async () => {
    const client = new DeepSeekClient({
      apiKey: "custom-key",
      baseUrl: "https://relay.example/v1",
      dialect: "openai-compatible",
      retry: { maxAttempts: 1 },
      fetch: async () => Response.json({ choices: [] }),
    });
    await expect(
      client.chat({ model: "relay-model", messages: [{ role: "user", content: "test" }] }),
    ).rejects.toThrow(/without a Chat Completions choice/);
  });
});
