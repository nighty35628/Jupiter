import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";

function makeStreamThatErrors(error: Error): typeof fetch {
  return vi.fn(async () => {
    let callCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        callCount++;
        if (callCount === 1) {
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
          );
          return;
        }
        controller.error(error);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

describe("DeepSeekClient.stream() mid-stream error wrapping", { retry: 0 }, () => {
  it("wraps body-reader errors with phase and original code", async () => {
    const err = Object.assign(new Error("terminated"), { code: "UND_ERR_ABORTED" });
    const fetch = makeStreamThatErrors(err);
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch,
      timeoutMs: 60_000,
      retry: { maxAttempts: 1 },
    });

    const chunks: any[] = [];
    const consume = async () => {
      for await (const chunk of client.stream({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }
    };

    await expect(consume()).rejects.toMatchObject({
      message: expect.stringContaining("terminated"),
      phase: "stream_body_read",
      code: "UND_ERR_ABORTED",
    });
    expect(chunks).toHaveLength(1);
  });

  it("falls back to stream_body_read without code when error lacks one", async () => {
    const fetch = makeStreamThatErrors(new Error("network dropped"));
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch,
      timeoutMs: 60_000,
      retry: { maxAttempts: 1 },
    });

    const consume = async () => {
      for await (const _ of client.stream({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hi" }],
      })) {
        /* drain */
      }
    };

    await expect(consume()).rejects.toMatchObject({
      phase: "stream_body_read",
      code: undefined,
    });
  });

  it("preserves reader error name, status and code, sanitizing the wrapper and cause", async () => {
    const secret = "opaque/SYNTHETIC+key=42";
    const error = Object.assign(new Error(`connection failed: ${secret}`), {
      name: "UpstreamReadError",
      status: 502,
      code: "ECONNRESET",
    });
    const fetch = makeStreamThatErrors(error);
    const client = new DeepSeekClient({ apiKey: secret, fetch, retry: { maxAttempts: 1 } });
    let failure: unknown;
    try {
      for await (const _chunk of client.stream({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "test" }],
      })) {
        /* drain */
      }
    } catch (value) {
      failure = value;
    }
    expect(failure).toMatchObject({
      name: "UpstreamReadError",
      status: 502,
      code: "ECONNRESET",
      phase: "stream_body_read",
      cause: { name: "UpstreamReadError", status: 502, code: "ECONNRESET" },
    });
    expect(
      `${(failure as Error).message} ${(failure as Error).stack} ${JSON.stringify(failure)} ${(failure as Error).cause}`,
    ).not.toContain(secret);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not turn a reader AbortError into an ordinary stream error", async () => {
    const error = Object.assign(new Error("cancelled"), { name: "AbortError", code: "ABORT_ERR" });
    const fetch = makeStreamThatErrors(error);
    const client = new DeepSeekClient({ apiKey: "synthetic", fetch, retry: { maxAttempts: 1 } });
    await expect(
      (async () => {
        for await (const _chunk of client.stream({
          model: "deepseek-chat",
          messages: [{ role: "user", content: "test" }],
        })) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
