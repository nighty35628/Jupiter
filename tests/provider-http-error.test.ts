import { describe, expect, it } from "vitest";
import {
  MAX_PROVIDER_ERROR_BODY_BYTES,
  ProviderHttpError,
  extractProviderErrorDetail,
  readResponseTextLimited,
  sanitizeProviderErrorText,
} from "../src/provider-http-error.js";

describe("provider HTTP error safety", () => {
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
