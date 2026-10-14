import { describe, expect, it } from "vitest";
import {
  MAX_PROVIDER_ERROR_BODY_BYTES,
  ProviderHttpError,
  extractProviderErrorDetail,
  readResponseTextLimited,
  sanitizeDiagnosticUrl,
  sanitizeProviderErrorText,
} from "../src/provider-http-error.js";

describe("provider HTTP error safety", () => {
  it("redacts opaque known secrets in literal and URL-encoded forms", () => {
    const secret = "opaque/SYNTHETIC+key=42";
    const encoded = encodeURIComponent(secret);
    const fullyEncoded = [...new TextEncoder().encode(secret)]
      .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
      .join("");
    const lowerEncoded = encoded.replace(/%[\dA-F]{2}/g, (s) => s.toLowerCase());
    for (const value of [
      secret,
      encoded,
      lowerEncoded,
      fullyEncoded,
      encodeURIComponent(encoded),
      encodeURIComponent(lowerEncoded),
    ]) {
      expect(
        sanitizeProviderErrorText(`request failed: ${value}`, { knownSecrets: [secret] }),
      ).toBe("request failed: [redacted]");
    }
  });

  it("redacts known secrets after control stripping and tolerates malformed Unicode", () => {
    const secret = "opaque\u0000SyntheticSecret";
    expect(sanitizeProviderErrorText(`failed ${secret}`, { knownSecrets: [secret] })).toBe(
      "failed [redacted]",
    );
    const malformed = "opaque\ud800SyntheticSecret";
    expect(sanitizeProviderErrorText(`failed ${malformed}`, { knownSecrets: [malformed] })).toBe(
      "failed [redacted]",
    );
    expect(sanitizeProviderErrorText("fail\u0091\u0092ure")).toBe("failure");
  });

  it("removes URL userinfo, encoded sensitive queries and fragments from error output", () => {
    const out = sanitizeProviderErrorText(
      "fetch https://user:SYNTHETICpass@relay.example/v1?%61pi%5Fkey=opaqueSynthetic&model=chat#fragmentSynthetic failed",
    );
    expect(out).toContain("relay.example/v1");
    expect(out).toContain("model=chat");
    for (const secret of ["user", "SYNTHETICpass", "opaqueSynthetic", "fragmentSynthetic"]) {
      expect(out).not.toContain(secret);
    }
  });

  it("never echoes invalid diagnostic URLs and strips terminal controls", () => {
    expect(sanitizeDiagnosticUrl("http://[invalid:SYNTHETICopaque")).toBe("[invalid URL]");
    expect(
      sanitizeDiagnosticUrl("\u001b[31mhttps://relay.example/v1?token=SYNTHETIC\u001b[0m"),
    ).toBe("[invalid URL]");
    expect(sanitizeProviderErrorText("failed http://[invalid:SYNTHETICopaque")).toBe(
      "failed [invalid URL]",
    );
    expect(
      sanitizeProviderErrorText("\u001b[31mfail\u001b[0m\u202e\u0000 Basic dXNlcjpTWU5USEVUSUM="),
    ).toBe("fail Basic [redacted]");
  });

  it("preserves benign diagnostic URLs and normal diagnostic text", () => {
    expect(sanitizeDiagnosticUrl("https://relay.example/v1?model=chat&limit=3")).toBe(
      "https://relay.example/v1?model=chat&limit=3",
    );
    const normal = "Basic arithmetic needs 42 tokens; model=chat; socket hang up";
    expect(sanitizeProviderErrorText(normal)).toBe(normal);
  });

  it("reads at most the configured response-body prefix", async () => {
    const result = await readResponseTextLimited(new Response("x".repeat(1_000_000)));
    expect(new TextEncoder().encode(result.text).byteLength).toBe(MAX_PROVIDER_ERROR_BODY_BYTES);
    expect(result.truncated).toBe(true);
  });

  it("extracts only supported JSON detail paths", () => {
    expect(extractProviderErrorDetail('{"error":{"message":"relay channel exhausted"}}')).toBe(
      "relay channel exhausted",
    );
    expect(extractProviderErrorDetail('{"debug":"internal stack"}')).toBe("");
  });

  it("drops HTML and strips terminal/control formatting", () => {
    expect(extractProviderErrorDetail("<!doctype html><title>proxy</title>")).toBe("");
    expect(extractProviderErrorDetail("\u001b[31mfailed\u001b[0m\u202esecret")).toBe(
      "failedsecret",
    );
  });

  it("redacts known and patterned credentials", () => {
    const secret = "sk-live-abcdefghijklmnop";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature";
    const detail = sanitizeProviderErrorText(
      `api key: ${secret}; Authorization: Bearer token-123; Basic dXNlcjpwYXNz; ${jwt}; cookie=session=abc`,
      { knownSecrets: [secret] },
    );
    expect(detail).not.toContain(secret);
    expect(detail).not.toContain("token-123");
    expect(detail).not.toContain("dXNlcjpwYXNz");
    expect(detail).not.toContain(jwt);
    expect(detail).not.toContain("session=abc");
  });

  it("keeps only safe structured fields on ProviderHttpError", () => {
    const secret = "sk-secret-abcdefghijklmnop";
    const error = new ProviderHttpError({
      status: 401,
      baseUrl: "https://relay.example/v1",
      rawBody: JSON.stringify({ error: { message: `invalid api key: ${secret}` } }),
      knownSecrets: [secret],
    });

    expect(error.message).not.toContain(secret);
    expect(error.stack).not.toContain(secret);
    expect(error.safeDetail).toContain("[redacted]");
    expect(Object.keys(error)).not.toContain("rawBody");
    expect(error.providerHost).toBe("relay.example");
    expect(error.retryable).toBe(false);
  });
});
