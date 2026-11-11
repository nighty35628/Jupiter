import { describe, expect, it } from "vitest";
import { resolveRequestBudget } from "../src/context-budget.js";
import {
  ProviderModelMetadataCache,
  createProviderModelMetadataIdentity,
  getProviderModelMetadata,
  recordProviderModelMetadata,
} from "../src/provider-model-metadata.js";

const provider = {
  baseUrl: "https://metadata-test.example/v1",
  dialect: "deepseek" as const,
  apiKey: "synthetic-test-key",
};
const identity = createProviderModelMetadataIdentity(provider);
const response = {
  data: [{ id: "deepseek-flash", context_window: 4096, max_output_tokens: 1024 }],
};

describe("bounded explicit model metadata", { retry: 0 }, () => {
  it("records only sanitized token limits and exposes a capability-compatible value", () => {
    const cache = new ProviderModelMetadataCache();
    cache.record(identity, {
      data: [{ ...response.data[0], owned_by: "private", secret: "do not cache" }],
    });
    const capability = cache.get(identity, "deepseek-flash");
    expect(capability).toEqual({ contextWindowTokens: 4096, maxOutputTokens: 1024 });
    expect(
      resolveRequestBudget({
        baseUrl: provider.baseUrl,
        model: "deepseek-flash",
        capability,
        maxTokens: 2000,
      }),
    ).toMatchObject({
      source: "metadata",
      contextWindowTokens: 4096,
      maxTokens: 1024,
      inputLimit: 2991,
    });
  });

  it.each([
    0,
    -1,
    0.5,
    "4096",
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("ignores invalid metadata limits: %s", (value) => {
    const cache = new ProviderModelMetadataCache();
    cache.record(identity, {
      data: [
        { id: "bad", context_window: value, max_output_tokens: value },
        { id: "partial", context_window: value, max_output_tokens: 2048 },
      ],
    });
    expect(cache.get(identity, "bad")).toBeUndefined();
    expect(cache.get(identity, "partial")).toEqual({ maxOutputTokens: 2048 });
  });

  it("isolates endpoint, path, dialect, credentials, and generation", () => {
    const cache = new ProviderModelMetadataCache();
    cache.record(identity, response);
    const variants = [
      createProviderModelMetadataIdentity({ ...provider, baseUrl: "https://other.example/v1" }),
      createProviderModelMetadataIdentity({
        ...provider,
        baseUrl: "https://metadata-test.example/v2",
      }),
      { ...identity, dialect: "openai-compatible" as const },
      createProviderModelMetadataIdentity({ ...provider, apiKey: "different-synthetic-key" }),
      { ...identity, generation: 2 },
    ];
    for (const variant of variants) expect(cache.get(variant, "deepseek-flash")).toBeUndefined();
    cache.record(variants[3]!, { data: [{ id: "deepseek-flash", context_window: 16384 }] });
    cache.record(identity, response);
    expect(cache.get(variants[3]!, "deepseek-flash")?.contextWindowTokens).toBe(16384);
  });

  it("does not keep plaintext credentials in the identity", () => {
    expect(JSON.stringify(identity)).not.toContain("synthetic-test-key");
    expect(identity.credentialHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createProviderModelMetadataIdentity({
        baseUrl: "https://METADATA-test.example:443/v1/",
        dialect: "deepseek",
        apiKey: "synthetic-test-key",
      }),
    ).toEqual(identity);
  });

  it("bounds endpoints by recency and bounds models within each response", () => {
    const cache = new ProviderModelMetadataCache({ maxEndpoints: 2, maxModelsPerEndpoint: 2 });
    const second = { ...identity, credentialHash: "second" };
    const third = { ...identity, credentialHash: "third" };
    cache.record(identity, response);
    cache.record(second, response);
    cache.get(identity, "deepseek-flash");
    cache.record(third, {
      data: [
        { id: "a", context_window: 4096 },
        { id: "b", context_window: 4096 },
        { id: "c", context_window: 4096 },
      ],
    });
    expect(cache.get(second, "deepseek-flash")).toBeUndefined();
    expect(cache.get(identity, "deepseek-flash")).toBeDefined();
    expect(cache.get(third, "a")).toBeDefined();
    expect(cache.get(third, "b")).toBeDefined();
    expect(cache.get(third, "c")).toBeUndefined();
  });

  it("replaces explicit snapshots, but does not clear metadata on a malformed result", () => {
    const cache = new ProviderModelMetadataCache();
    cache.record(identity, response);
    cache.record(identity, { data: "malformed" });
    expect(cache.get(identity, "deepseek-flash")).toBeDefined();
    cache.record(identity, { data: [{ id: "deepseek-flash" }] });
    expect(cache.get(identity, "deepseek-flash")).toBeUndefined();
  });

  it("returns copies and never treats per-request caps as endpoint metadata", () => {
    const cache = new ProviderModelMetadataCache();
    cache.record(identity, { data: [{ ...response.data[0], maxTokens: 20, outputTokenCap: 20 }] });
    const first = cache.get(identity, "deepseek-flash")!;
    Object.assign(first, { contextWindowTokens: 1 });
    expect(cache.get(identity, "deepseek-flash")).toEqual({
      contextWindowTokens: 4096,
      maxOutputTokens: 1024,
    });
  });

  it("expires metadata without timers or automatic discovery", () => {
    let now = 0;
    const cache = new ProviderModelMetadataCache({ ttlMs: 100, now: () => now });
    cache.record(identity, response);
    now = 99;
    expect(cache.get(identity, "deepseek-flash")).toBeDefined();
    now = 100;
    expect(cache.get(identity, "deepseek-flash")).toBeUndefined();
  });

  it("never invents official fields for unknown models or absent metadata", () => {
    const cache = new ProviderModelMetadataCache();
    const official = createProviderModelMetadataIdentity({
      ...provider,
      baseUrl: "https://api.deepseek.com",
    });
    cache.record(official, { data: [{ id: "unknown" }, { id: "deepseek-flash" }] });
    expect(cache.get(official, "unknown")).toBeUndefined();
    expect(cache.get(official, "deepseek-flash")).toBeUndefined();
    expect(cache.get(identity, "unknown")).toBeUndefined();
  });

  it("offers shared record/get accessors without performing any fetch", () => {
    recordProviderModelMetadata(identity, response);
    expect(getProviderModelMetadata(identity, "deepseek-flash")).toEqual({
      contextWindowTokens: 4096,
      maxOutputTokens: 1024,
    });
  });

  it("does not add endpoint validation or leak credentials embedded in legacy URLs", () => {
    for (const baseUrl of [
      "http://provider.invalid/v1",
      "invalid",
      "https://user:secret@host.example/v1?token=secret",
    ]) {
      const captured = createProviderModelMetadataIdentity({ ...provider, baseUrl });
      expect(JSON.stringify(captured)).not.toContain("secret");
      const cache = new ProviderModelMetadataCache();
      cache.record(captured, response);
      expect(cache.get(captured, "deepseek-flash")).toBeDefined();
    }
  });
});
