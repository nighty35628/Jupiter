import { describe, expect, it } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { ProviderHttpError } from "../src/provider-http-error.js";

const request = {
  model: "deepseek-v4-flash",
  messages: [{ role: "user" as const, content: "hello" }],
};

describe("DeepSeekClient HTTP errors", () => {
  it("throws a structured, redacted error for non-streaming requests", async () => {
    const apiKey = "sk-live-abcdefghijklmnop";
    const client = new DeepSeekClient({
      apiKey,
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: `invalid api key: ${apiKey}` } }), {
          status: 401,
        }),
      retry: { maxAttempts: 1 },
    });

    const error = await client.chat(request).catch((value) => value);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as ProviderHttpError).status).toBe(401);
  });

  it("throws the same safe error type before consuming a failed stream", async () => {
    const apiKey = "sk-stream-abcdefghijklmnop";
    const client = new DeepSeekClient({
      apiKey,
      baseUrl: "https://relay.example/v1",
      fetch: async () =>
        new Response(`Authorization: Bearer ${apiKey}`, {
          status: 503,
        }),
      retry: { maxAttempts: 1 },
    });

    let error: unknown;
    try {
      for await (const _chunk of client.stream(request)) {
        // No chunks are expected from a failed HTTP response.
      }
    } catch (value) {
      error = value;
    }
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as ProviderHttpError).providerHost).toBe("relay.example");
  });
});
