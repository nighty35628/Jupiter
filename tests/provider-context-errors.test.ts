import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { isCompactionContextError, providerContextBudget } from "../src/loop/compaction.js";
import { ProviderHttpError } from "../src/provider-http-error.js";

const request = {
  model: "synthetic-model",
  messages: [{ role: "user" as const, content: "test" }],
};
const secret = "opaque/SYNTHETIC+key=42";
const providerError = (body: unknown, status = 400) =>
  new ProviderHttpError({
    status,
    baseUrl: "https://synthetic.invalid/v1",
    rawBody: JSON.stringify(body),
    knownSecrets: [secret],
  });
async function streamError(client: DeepSeekClient): Promise<unknown> {
  try {
    for await (const _chunk of client.stream(request)) {
      /* drain */
    }
  } catch (error) {
    return error;
  }
  throw new Error("Expected stream failure");
}

describe("structured provider context errors", { retry: 0 }, () => {
  it.each(["chat", "stream"] as const)("keeps HTTP code-only evidence through %s", async (mode) => {
    const fetch = vi.fn(async () =>
      Response.json({ error: { code: " CONTEXT_LENGTH_EXCEEDED " } }, { status: 400 }),
    );
    const client = new DeepSeekClient({ apiKey: secret, fetch, retry: { maxAttempts: 1 } });
    const error =
      mode === "chat"
        ? await client.chat(request).catch((value) => value)
        : await streamError(client);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 400, code: "context_length_exceeded", source: "http" });
    expect(isCompactionContextError(error)).toBe(true);
    expect(providerContextBudget(error, { ...request })).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { error: { code: "context_length_exceeded" } },
    { error: { type: "context_length_exceeded" } },
    { code: "context_length_exceeded" },
  ])("normalizes supported machine-code paths (%j)", (body) => {
    const error = providerError(body);
    expect(error).toMatchObject({ code: "context_length_exceeded", source: "http" });
    expect(isCompactionContextError(error)).toBe(true);
  });

  it.each([undefined, 400, 401, 413, 429])(
    "keeps SSE provider identity and status %s, never malformed JSON",
    async (status) => {
      const fetch = vi.fn(
        async () =>
          new Response(
            `event: error\ndata: ${JSON.stringify({
              error: {
                code: "context_length_exceeded",
                status,
                message: `maximum context length is 4096 tokens; token=${secret}`,
              },
            })}\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      );
      const client = new DeepSeekClient({ apiKey: secret, fetch, retry: { maxAttempts: 1 } });
      const error = await streamError(client);
      expect(error).toMatchObject({
        name: "ProviderStreamError",
        code: "context_length_exceeded",
        source: "sse",
      });
      expect((error as Error).message).not.toMatch(/malformed JSON/);
      expect((error as Error).message).toContain("[redacted]");
      expect(
        `${(error as Error).message} ${(error as Error).stack} ${JSON.stringify(error)}`,
      ).not.toContain(secret);
      expect(isCompactionContextError(error)).toBe(
        status === undefined || status === 400 || status === 413,
      );
      const budget = providerContextBudget(error, { ...request });
      expect(budget).toEqual(
        status === undefined || status === 400 || status === 413
          ? { kind: "prompt", promptTokens: 4096 }
          : undefined,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("recognizes top-level codes in named SSE error events", async () => {
    const client = new DeepSeekClient({
      apiKey: secret,
      retry: { maxAttempts: 1 },
      fetch: async () =>
        new Response(
          'event: error\ndata: {"code":"context_length_exceeded","message":"Input too long"}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const error = await streamError(client);
    expect(error).toMatchObject({
      name: "ProviderStreamError",
      source: "sse",
      code: "context_length_exceeded",
    });
    expect(isCompactionContextError(error)).toBe(true);
  });

  it.each([
    providerError({ error: { message: "invalid max_tokens" } }),
    providerError({ error: { message: "request body exceeds 40 MiB image byte limit" } }, 413),
    providerError({ error: { message: "maximum input length is 41943040 bytes" } }, 413),
    providerError({ error: { message: "maximum input length is 40 MiB" } }, 413),
    providerError({ error: { code: "context_length_exceeded" } }, 401),
    providerError({ error: { code: "context_length_exceeded" } }, 403),
    providerError({ error: { code: "context_length_exceeded" } }, 429),
    Object.assign(new Error("context_length_exceeded"), { code: "context_length_exceeded" }),
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  ])("does not compact ordinary failures (%s)", (error) => {
    expect(isCompactionContextError(error)).toBe(false);
    expect(providerContextBudget(error, { ...request })).toBeUndefined();
  });

  it("allows local context recovery but never learns a server limit from it", () => {
    const error = Object.assign(new Error("maximum context length is 256 tokens"), {
      status: 400,
      code: "CONTEXT_WINDOW_EXCEEDED",
    });
    expect(isCompactionContextError(error)).toBe(true);
    expect(providerContextBudget(error, { ...request })).toBeUndefined();
    const auth = providerError({ error: { message: "maximum context length is 256 tokens" } }, 401);
    expect(providerContextBudget(auth, { ...request })).toBeUndefined();
  });

  it.each([secret, encodeURIComponent(secret), "sk-secret-abcdefghijklmnop"])(
    "never retains a secret in a machine-code field (%s)",
    (code) => {
      const error = providerError({ error: { code, message: "failed" } });
      expect(error).toHaveProperty("code", undefined);
      expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toContain(code);
    },
  );
});
