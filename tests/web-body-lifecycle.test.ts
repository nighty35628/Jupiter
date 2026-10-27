import { afterEach, describe, expect, it, vi } from "vitest";
import { webFetch } from "../src/tools/web.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

afterEach(() => vi.unstubAllGlobals());

async function outcome(promise: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    promise.then(
      () => "success",
      (error: Error) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve("still pending"), 100)),
  ]);
}

describe("web fetch body lifecycle regressions", () => {
  it("keeps the deadline active after headers, even with a stuck stream cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );
    const result = await outcome(webFetch("https://example.com", { timeoutMs: 10 }));
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/timed out/i);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("propagates caller cancellation while consuming the body", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        setTimeout(() => controller.abort(), 10);
        return new Response(new ReadableStream({ cancel }));
      }),
    );
    const result = await outcome(webFetch("https://example.com", { signal: controller.signal }));
    expect(result).toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not start networking for an already aborted caller", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      webFetch("https://example.com", { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an oversized stream without awaiting a stuck cancel", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1));
              },
              cancel,
            }),
          ),
      ),
    );
    expect(await outcome(webFetch("https://example.com"))).toBeInstanceOf(Error);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
