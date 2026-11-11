import { describe, expect, it } from "vitest";
import { resolveRequestBudget } from "../src/context-budget.js";
import { resolveModelCapability } from "../src/provider-capabilities.js";

const official = { baseUrl: "https://api.deepseek.com", model: "deepseek-flash" };

describe("pure request budgets", { retry: 0 }, () => {
  it.each([
    ["disabled", "max", 8192],
    ["enabled", "low", 65536],
    ["enabled", "high", 65536],
    ["enabled", "max", 131072],
    [undefined, undefined, 65536],
  ] as const)("resolves official defaults for %s / %s", (thinking, reasoningEffort, output) => {
    const budget = resolveRequestBudget({ ...official, thinking, reasoningEffort });
    expect(budget).toMatchObject({
      contextWindowTokens: 1048576,
      maxTokens: output,
      outputReserveTokens: output,
      safetyTokens: 4096,
      inputLimit: 1048576 - output - 4096,
      source: "official",
      estimated: false,
    });
  });

  it.each([4096, 16384, 131072, 1048576])("fits an explicit output into C=%i", (window) => {
    const budget = resolveRequestBudget({
      ...official,
      contextWindowTokens: window,
      maxTokens: 393216,
      inputTokenLimit: 50000,
    });
    expect(budget.safetyTokens).toBe(Math.min(4096, Math.floor(window * 0.02)));
    expect(budget.inputLimit).toBe(
      Math.min(50000, window - budget.outputReserveTokens - budget.safetyTokens),
    );
    expect(budget.inputLimit).toBeGreaterThanOrEqual(0);
    expect(
      budget.inputLimit + budget.outputReserveTokens + budget.safetyTokens,
    ).toBeLessThanOrEqual(window);
    expect(budget.maxTokens).toBeLessThanOrEqual(393216);
    expect(budget.source).toBe("override");
  });

  it("keeps a legacy input cap separate from C and does not subtract R twice", () => {
    const budget = resolveRequestBudget({ ...official, inputTokenLimit: 4000, maxTokens: 2000 });
    expect(budget.contextWindowTokens).toBe(1048576);
    expect(budget.inputLimit).toBe(4000);
    expect(resolveRequestBudget({ ...official, inputTokenLimit: 1000000 }).inputLimit).toBe(978944);
  });

  it("clamps output to provider and per-request caps without mutating capabilities", () => {
    const capability = Object.freeze({ contextWindowTokens: 16384, maxOutputTokens: 4096 });
    const options = { ...official, capability, maxTokens: 9000 };
    expect(resolveRequestBudget({ ...options, outputTokenCap: 2048 }).maxTokens).toBe(2048);
    expect(resolveRequestBudget(options).maxTokens).toBe(4096);
    expect(capability).toEqual({ contextWindowTokens: 16384, maxOutputTokens: 4096 });
    expect(resolveRequestBudget({ ...official, maxTokens: 500000 }).maxTokens).toBe(393216);
  });

  it("applies client-owned prompt evidence without learning it as a model specification", () => {
    const options = { ...official, inputTokenLimit: 1000000, maxTokens: 2048 };
    const limited = resolveRequestBudget({ ...options, serverInputTokenLimit: 4096 });
    expect(limited.inputLimit).toBe(4096);
    expect(limited.inputTokenLimit).toBe(4096);
    expect(limited.contextWindowTokens).toBe(1048576);
    expect(resolveRequestBudget(options).inputLimit).toBe(1000000);
  });

  it("accommodates a declared legacy prompt cap only when the total window is unknown", () => {
    const options = {
      baseUrl: "https://relay.example/v1",
      model: "custom",
      inputTokenLimit: 200000,
      inputTokenLimitExplicit: true,
    };
    const inferred = resolveRequestBudget(options);
    expect(inferred).toMatchObject({
      source: "fallback",
      estimated: true,
      inputLimit: 200000,
      maxTokens: undefined,
    });
    expect(inferred.contextWindowTokens).toBe(212288);
    expect(resolveRequestBudget({ ...options, inputTokenLimitExplicit: false }).inputLimit).toBe(
      120259,
    );
    expect(
      resolveRequestBudget({ ...options, capability: { contextWindowTokens: 131072 } }).inputLimit,
    ).toBe(120259);
    expect(
      resolveRequestBudget({ ...options, contextWindowTokens: 16384, maxTokens: 1024 }).inputLimit,
    ).toBe(15033);
    expect(
      resolveRequestBudget({ ...options, serverContextWindowTokens: 16384, maxTokens: 1024 }),
    ).toMatchObject({ source: "server", inputLimit: 15033 });
  });

  it("does not infer a million-token third-party window from a built-in model-name cap", () => {
    expect(
      resolveRequestBudget({
        baseUrl: "https://relay.example/v1",
        model: "deepseek-flash",
        inputTokenLimit: 1000000,
      }),
    ).toMatchObject({ source: "fallback", contextWindowTokens: 131072, inputLimit: 120259 });
  });

  it("uses server provenance and never expands a known smaller window", () => {
    expect(
      resolveRequestBudget({ ...official, serverContextWindowTokens: 16384, maxTokens: 1024 }),
    ).toMatchObject({ source: "server", contextWindowTokens: 16384, inputLimit: 15033 });
    expect(resolveRequestBudget({ ...official, serverContextWindowTokens: 2000000 }).source).toBe(
      "official",
    );
    expect(
      resolveRequestBudget({
        ...official,
        capability: { contextWindowTokens: 4096 },
        serverContextWindowTokens: 16384,
        maxTokens: 1024,
      }),
    ).toMatchObject({ source: "metadata", contextWindowTokens: 4096, inputLimit: 2991 });
    expect(
      resolveRequestBudget({
        baseUrl: "https://relay.example/v1",
        model: "custom",
        serverContextWindowTokens: 200000,
        maxTokens: 1024,
      }),
    ).toMatchObject({ source: "server", contextWindowTokens: 200000, estimated: false });
  });

  it.each([4096, 16384])(
    "keeps useful input under an official default larger than C=%i",
    (window) => {
      for (const limits of [
        { contextWindowTokens: window },
        { capability: { contextWindowTokens: window } },
        { serverContextWindowTokens: window },
      ]) {
        const budget = resolveRequestBudget({ ...official, ...limits });
        expect(budget).toMatchObject({
          maxTokens: window / 4,
          outputClamped: true,
          outputSource: "default",
        });
        expect(budget.inputLimit).toBe(window - window / 4 - Math.floor(window * 0.02));
        expect(budget.inputLimit).toBeGreaterThan(0);
      }
    },
  );

  it("reports an incompatible explicit output as a request-local cap rather than silently exhausting input", () => {
    const budget = resolveRequestBudget({
      ...official,
      contextWindowTokens: 4096,
      maxTokens: 8192,
    });
    expect(budget).toMatchObject({
      maxTokens: 1024,
      outputSource: "explicit",
      outputClamped: true,
      inputLimit: 2991,
    });
    expect(resolveRequestBudget({ ...official, maxTokens: 8192 }).outputClamped).toBe(false);
  });

  it("prefers explicit C over current endpoint metadata, then official specifications", () => {
    const capability = { contextWindowTokens: 16384, maxOutputTokens: 2048 };
    expect(resolveRequestBudget({ ...official, capability }).source).toBe("metadata");
    expect(resolveRequestBudget({ ...official, capability }).contextWindowTokens).toBe(16384);
    expect(
      resolveRequestBudget({ ...official, capability, contextWindowTokens: 4096 })
        .contextWindowTokens,
    ).toBe(4096);
  });

  it("keeps official endpoint limits independent of wire presets, but gates Beta on DeepSeek", () => {
    expect(resolveRequestBudget({ ...official, dialect: "openai-compatible" })).toMatchObject({
      source: "official",
      contextWindowTokens: 1048576,
    });
    expect(
      resolveModelCapability(official.baseUrl, official.model, "openai-compatible")
        .supportsPrefixContinuation,
    ).toBe(false);
    expect(
      resolveModelCapability("https://relay.example/v1", official.model, "deepseek"),
    ).toMatchObject({
      officialDeepSeekV4: false,
      supportsPrefixContinuation: false,
      thinkingLevels: ["off", "low", "high", "max"],
    });
  });

  it("does not grant unknown models at the official endpoint a known model's limits", () => {
    expect(resolveRequestBudget({ ...official, model: "unknown-model" })).toMatchObject({
      source: "fallback",
      estimated: true,
      maxTokens: undefined,
    });
  });

  it("uses endpoint metadata defaults without forcing an output cap for absent defaults", () => {
    const options = {
      baseUrl: "https://relay.example/v1",
      model: "model",
      capability: {
        contextWindowTokens: 16384,
        maxOutputTokens: 8192,
        defaultOutputTokens: { nonThinking: 1000, thinking: 2000, maxThinking: 4000 },
      },
    };
    expect(resolveRequestBudget({ ...options, thinking: "disabled" })).toMatchObject({
      maxTokens: 1000,
      outputSource: "default",
      estimated: false,
    });
    expect(resolveRequestBudget({ ...options, reasoningEffort: "max" }).maxTokens).toBe(4000);
    expect(resolveRequestBudget({ ...options, outputTokenCap: 500 }).maxTokens).toBe(500);
    expect(
      resolveRequestBudget({
        ...options,
        capability: { contextWindowTokens: 16384, maxOutputTokens: 8192 },
      }).maxTokens,
    ).toBeUndefined();
  });

  it.each([
    "deepseek-flash",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
    "deepseek-chat",
    "deepseek-reasoner",
    "deepseek-v4-pro",
  ])("uses official alias limits only at the strict official endpoint: %s", (model) => {
    expect(resolveRequestBudget({ ...official, model }).contextWindowTokens).toBe(1048576);
    const custom = resolveRequestBudget({
      baseUrl: "https://relay.example/v1",
      model,
      dialect: "deepseek",
    });
    expect(custom).toMatchObject({
      contextWindowTokens: 131072,
      source: "fallback",
      estimated: true,
    });
    expect(custom.maxTokens).toBeUndefined();
    expect(
      resolveModelCapability("https://relay.example/v1", model, "deepseek").contextWindowTokens,
    ).toBeUndefined();
  });

  it.each([
    "http://api.deepseek.com",
    "https://api.deepseek.com:444",
    "https://user:pass@api.deepseek.com",
    "https://api.deepseek.com.evil.example",
    "invalid",
  ])("does not trust an official-looking endpoint: %s", (baseUrl) => {
    expect(resolveRequestBudget({ ...official, baseUrl, dialect: "deepseek" }).source).toBe(
      "fallback",
    );
  });

  it("preserves optional third-party maxTokens while marking an output reserve as estimated", () => {
    const options = {
      baseUrl: "https://relay.example/v1",
      model: "model",
      capability: { contextWindowTokens: 4096 },
    };
    const unknown = resolveRequestBudget(options);
    expect(unknown.maxTokens).toBeUndefined();
    expect(unknown.outputReserveTokens).toBe(1024);
    expect(unknown.estimated).toBe(true);
    expect(resolveRequestBudget({ ...options, maxTokens: 1500 })).toMatchObject({
      maxTokens: 1500,
      outputReserveTokens: 1500,
      estimated: false,
    });
    expect(resolveRequestBudget({ ...options, outputTokenCap: 500 }).maxTokens).toBe(500);
  });

  it.each([0, 1, 2, 10, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "never returns NaN or negative limits for small/invalid C=%s",
    (window) => {
      const budget = resolveRequestBudget({
        ...official,
        contextWindowTokens: window,
        maxTokens: 500000,
      });
      for (const value of [
        budget.contextWindowTokens,
        budget.outputReserveTokens,
        budget.safetyTokens,
        budget.inputLimit,
      ]) {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
      expect(
        budget.inputLimit + budget.outputReserveTokens + budget.safetyTokens,
      ).toBeLessThanOrEqual(budget.contextWindowTokens);
    },
  );
});
