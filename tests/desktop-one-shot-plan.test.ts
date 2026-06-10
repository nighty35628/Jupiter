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

  it("builds a plan-only prompt that writes a spec and waits for the next turn", () => {
    const prompt = buildOneShotPlanPrompt("实现设置入口");

    expect(prompt).toContain("Plan-only mode");
    expect(prompt).toContain("Do not call `submit_plan`");
    expect(prompt).toContain("SPEC");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).toContain("Wait for the user's next message");
    expect(prompt).not.toContain("After the user approves the plan, continue executing");
    expect(prompt).toContain("实现设置入口");
  });
});
