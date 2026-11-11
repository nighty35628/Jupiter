import { describe, expect, it } from "vitest";
import { Usage } from "../src/client.js";
import { resolveRequestBudget } from "../src/context-budget.js";
import { planPrefixContinuation } from "../src/loop/continuation.js";
import type { ChatMessage } from "../src/types.js";

const options = {
  enabled: true,
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  finishReason: "length" as const,
  messages: [{ role: "user", content: "continue" }] as ChatMessage[],
  assistantContent: "partial",
  reasoningContent: "reasoning",
  toolCalls: [],
  usage: new Usage(100, 10),
};

describe("budget-safe prefix continuation", { retry: 0 }, () => {
  it("uses the provider maximum rather than the old 384000 approximation", () => {
    expect(planPrefixContinuation(options)?.maxTokens).toBe(393216);
  });

  it.each([4096, 16384, 131072, 1048576])("recalculates a continuation against C=%i", (window) => {
    const budget = resolveRequestBudget({
      ...options,
      contextWindowTokens: window,
      maxTokens: 2048,
    });
    const plan = planPrefixContinuation({ ...options, budget });
    expect(plan).not.toBeNull();
    expect(plan!.maxTokens).toBeLessThanOrEqual(2048);
    expect(110 + plan!.maxTokens + budget.safetyTokens).toBeLessThanOrEqual(window);
    expect(plan!.messages).toEqual([
      ...options.messages,
      {
        role: "assistant",
        content: "partial",
        reasoning_content: "reasoning",
        prefix: true,
      },
    ]);
    expect(options.messages).toHaveLength(1);
  });

  it("respects legacy prompt caps and leaves the source budget unchanged", () => {
    const budget = Object.freeze(
      resolveRequestBudget({ ...options, inputTokenLimit: 105, maxTokens: 2048 }),
    );
    expect(planPrefixContinuation({ ...options, budget })).toBeNull();
    expect(budget.maxTokens).toBe(2048);
  });

  it("shrinks output at the remaining boundary and stops below the continuation minimum", () => {
    const budget = resolveRequestBudget({ ...options, contextWindowTokens: 4096, maxTokens: 2048 });
    expect(
      planPrefixContinuation({ ...options, budget, usage: new Usage(2200, 100) })?.maxTokens,
    ).toBe(1715);
    expect(planPrefixContinuation({ ...options, budget, usage: new Usage(3000, 100) })).toBeNull();
  });

  it("never enables continuation on a relay even with the DeepSeek dialect", () => {
    expect(
      planPrefixContinuation({
        ...options,
        baseUrl: "https://relay.example/v1",
        dialect: "deepseek",
      }),
    ).toBeNull();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("rejects invalid usage %s", (tokens) => {
    expect(planPrefixContinuation({ ...options, usage: new Usage(tokens, 10) })).toBeNull();
  });

  it("does not continue a tool call or change the input messages", () => {
    const toolCalls = [
      { id: "call", type: "function" as const, function: { name: "noop", arguments: "{}" } },
    ];
    expect(planPrefixContinuation({ ...options, toolCalls })).toBeNull();
    expect(planPrefixContinuation({ ...options, finishReason: "stop" })).toBeNull();
    expect(options.messages).toEqual([{ role: "user", content: "continue" }]);
  });
});
