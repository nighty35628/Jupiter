import { describe, expect, it } from "vitest";
import {
  effortArgsHintFor,
  effortArgumentChoicesFor,
  effortChoicesForBaseUrl,
} from "../src/cli/ui/effort-choices.js";
import {
  displayReasoningSelection,
  parseReasoningSelection,
} from "../src/provider-capabilities.js";

describe("effortChoicesForBaseUrl", () => {
  it("returns the full set for api.deepseek.com", () => {
    expect(effortChoicesForBaseUrl("https://api.deepseek.com")).toEqual([
      "off",
      "low",
      "high",
      "max",
    ]);
    expect(effortChoicesForBaseUrl("https://api.deepseek.com/v1")).toEqual([
      "off",
      "low",
      "high",
      "max",
    ]);
    expect(effortChoicesForBaseUrl("https://api.deepseek.com", "glm-5")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("drops `max` for non-DeepSeek endpoints (vLLM / Azure / OpenAI-compat reject it)", () => {
    expect(effortChoicesForBaseUrl("http://localhost:8080/v1")).toEqual(["low", "medium", "high"]);
    expect(effortChoicesForBaseUrl("https://api.openai.com/v1")).toEqual(["low", "medium", "high"]);
    expect(effortChoicesForBaseUrl("https://my-azure.openai.azure.com")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("treats null / undefined / empty baseUrl as non-DeepSeek", () => {
    expect(effortChoicesForBaseUrl(undefined)).toEqual(["low", "medium", "high"]);
    expect(effortChoicesForBaseUrl(null)).toEqual(["low", "medium", "high"]);
    expect(effortChoicesForBaseUrl("")).toEqual(["low", "medium", "high"]);
  });

  it("rejects deepseek-spoofing hosts (substring match would be wrong)", () => {
    expect(effortChoicesForBaseUrl("https://fake-deepseek.com")).toEqual(["low", "medium", "high"]);
    expect(effortChoicesForBaseUrl("https://api.deepseek.com.evil.tld")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("formats argsHint with the supplied choices", () => {
    expect(effortArgsHintFor(["off", "low", "high", "max"])).toBe("<off|medium|high|max>");
    expect(effortArgsHintFor(["low", "medium", "high"])).toBe("<low|medium|high>");
  });

  it("renames only the first official DeepSeek tier without changing its stored value", () => {
    const deepSeekChoices = ["off", "low", "high", "max"] as const;
    const standardChoices = ["low", "medium", "high"] as const;

    expect(effortArgumentChoicesFor(deepSeekChoices)).toEqual(["off", "medium", "high", "max"]);
    expect(displayReasoningSelection("low", deepSeekChoices)).toBe("medium");
    expect(parseReasoningSelection("medium", deepSeekChoices)).toBe("low");
    expect(displayReasoningSelection("low", standardChoices)).toBe("low");
    expect(parseReasoningSelection("medium", standardChoices)).toBe("medium");
  });
});
