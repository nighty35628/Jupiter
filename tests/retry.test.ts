import { describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../src/retry.js";

function makeFetch(responses: Array<Response | Error | (() => Response | Error)>): {
  fn: typeof fetch;
  calls: number;
} {
  let i = 0;
  const fn = vi.fn(async () => {
    const r = responses[i++] ?? responses[responses.length - 1]!;
    const resolved = typeof r === "function" ? r() : r;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  }) as unknown as typeof fetch;
  return {
    fn,
    get calls() {
      return (fn as any).mock.calls.length as number;
    },
  };
}

const BASE: Parameters<typeof fetchWithRetry>[3] = { initialBackoffMs: 1, maxBackoffMs: 50 };

describe("fetchWithRetry", () => {
  it("returns immediately on success", async () => {
    const f = makeFetch([new Response("ok", { status: 200 })]);
    const r = await fetchWithRetry(f.fn, "https://x", {}, BASE);
    expect(r.status).toBe(200);
    expect(f.calls).toBe(1);
  });

  it("retries on 429 and succeeds", async () => {
    const f = makeFetch([
      new Response("", { status: 429 }),
      new Response("", { status: 429 }),
      new Response("ok", { status: 200 }),
    ]);
    const r = await fetchWithRetry(f.fn, "https://x", {}, BASE);
    expect(r.status).toBe(200);
    expect(f.calls).toBe(3);
  });

  it("retries on 503 and eventually surfaces the failure", async () => {
    const f = makeFetch([
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    ]);
    const r = await fetchWithRetry(f.fn, "https://x", {}, { ...BASE, maxAttempts: 3 });
    expect(r.status).toBe(503);
    expect(f.calls).toBe(3);
  });

  it("does NOT retry on 401 Unauthorized", async () => {
    const f = makeFetch([new Response("bad key", { status: 401 })]);
    const r = await fetchWithRetry(f.fn, "https://x", {}, BASE);
    expect(r.status).toBe(401);
    expect(f.calls).toBe(1);
  });

  it("does NOT retry on 400 Bad Request", async () => {
    const f = makeFetch([new Response("oops", { status: 400 })]);
    const r = await fetchWithRetry(f.fn, "https://x", {}, BASE);
    expect(r.status).toBe(400);
    expect(f.calls).toBe(1);
  });

  it("retries on network error and recovers", async () => {
    const f = makeFetch([new TypeError("fetch failed"), new Response("ok", { status: 200 })]);
    const r = await fetchWithRetry(f.fn, "https://x", {}, BASE);
    expect(r.status).toBe(200);
    expect(f.calls).toBe(2);
  });

  it("gives up after maxAttempts and rethrows the last network error", async () => {
    const err = new TypeError("dns lookup failed");
    const f = makeFetch([err, err, err]);
    await expect(
      fetchWithRetry(f.fn, "https://x", {}, { ...BASE, maxAttempts: 3 }),
    ).rejects.toThrow(/dns lookup failed/);
    expect(f.calls).toBe(3);
  });

  it("does NOT retry when request is aborted", async () => {
    const ctrl = new AbortController();
    const abortErr = new Error("user aborted");
    abortErr.name = "AbortError";
    const f = makeFetch([abortErr]);
    await expect(
      fetchWithRetry(f.fn, "https://x", { signal: ctrl.signal }, { ...BASE, signal: ctrl.signal }),
    ).rejects.toThrow();
    expect(f.calls).toBe(1);
  });

  it("honours Retry-After header within the cap", async () => {
    const f = makeFetch([
      new Response("", {
        status: 429,
        headers: { "Retry-After": "0.05" },
      }),
      new Response("ok", { status: 200 }),
    ]);
    const started = Date.now();
    const r = await fetchWithRetry(f.fn, "https://x", {}, BASE);
    const elapsed = Date.now() - started;
    expect(r.status).toBe(200);
    // Retry-After of 0.05s = 50ms. Allow some scheduler slack.
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("fires onRetry callback between attempts", async () => {
    const onRetry = vi.fn();
    const f = makeFetch([new Response("", { status: 429 }), new Response("ok", { status: 200 })]);
    await fetchWithRetry(f.fn, "https://x", {}, { ...BASE, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0].reason).toMatch(/http 429/);
  });

  it("maxAttempts=1 effectively disables retry", async () => {
    const f = makeFetch([new Response("", { status: 503 })]);
    const r = await fetchWithRetry(f.fn, "https://x", {}, { ...BASE, maxAttempts: 1 });
    expect(r.status).toBe(503);
    expect(f.calls).toBe(1);
  });
});
