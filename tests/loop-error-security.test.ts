import { describe, expect, it } from "vitest";
import { formatLoopError, is4xxError, is5xxError } from "../src/loop/errors.js";
import { ProviderHttpError } from "../src/provider-http-error.js";

describe("loop diagnostic security", { retry: 0 }, () => {
  it("does not echo an invalid upstream URL in the 5xx fallback", () => {
    const out = formatLoopError(new Error("DeepSeek 503: unavailable"), undefined, {
      upstreamHost: "http://[invalid:opaqueSynthetic",
    });
    expect(out).toContain("503");
    expect(out).toContain("upstream");
    expect(out).not.toContain("opaqueSynthetic");
  });

  it("sanitizes unclassified errors without mutating AbortError or classification", () => {
    const err = new Error(
      "fetch https://user:syntheticPass@relay.example?token=opaqueSynthetic#privateSynthetic aborted",
    );
    err.name = "AbortError";
    const original = err.message;
    const out = formatLoopError(err);
    expect(out).toContain("relay.example");
    expect(out).not.toContain("opaqueSynthetic");
    expect(out).not.toContain("syntheticPass");
    expect(err.message).toBe(original);
    expect(err.name).toBe("AbortError");
    expect(is4xxError(err)).toBe(false);
    expect(is5xxError(err)).toBe(false);
  });

  it.each([401, 429, 503, 520])("retains structured status/retry metadata for %s", (status) => {
    const err = new ProviderHttpError({
      status,
      baseUrl: "https://user:syntheticPass@relay.example/v1?key=opaqueSynthetic",
      rawBody: "channel exhausted",
    });
    expect(err.status).toBe(status);
    expect(err.retryable).toBe(status === 429 || status >= 500);
    expect(is4xxError(err)).toBe(status >= 400 && status < 500);
    expect(is5xxError(err)).toBe(status >= 500 && status <= 599);
    expect(formatLoopError(err)).toContain(String(status));
    expect(formatLoopError(err)).toContain("channel exhausted");
  });
});
