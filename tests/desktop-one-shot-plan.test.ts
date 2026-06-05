import { describe, expect, it } from "vitest";
import { buildOneShotPlanPrompt, parseOneShotPlanCommand } from "../desktop/src/one-shot-plan";

describe("desktop one-shot plan mode", () => {
  it("parses bare /plan as arming the next normal message", () => {
    expect(parseOneShotPlanCommand("/plan")).toEqual({ type: "arm" });
  });

  it("parses /plan <task> as an immediate planned task", () => {
    expect(parseOneShotPlanCommand("/plan 重构侧栏")).toEqual({
      type: "send",
      text: "重构侧栏",
    });
  });

  it("supports cancelling an armed one-shot plan", () => {
    expect(parseOneShotPlanCommand("/plan off")).toEqual({ type: "cancel" });
    expect(parseOneShotPlanCommand("/plan cancel")).toEqual({ type: "cancel" });
  });

  it("builds a model-only prompt that requires submit_plan before execution", () => {
    const prompt = buildOneShotPlanPrompt("实现设置入口");

    expect(prompt).toContain("One-shot Plan mode");
    expect(prompt).toContain("submit_plan");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).toContain("实现设置入口");
  });
});
