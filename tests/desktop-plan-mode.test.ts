import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOneShotPlanPrompt } from "../desktop/src/one-shot-plan";

describe("desktop one-shot plan routing", () => {
  it("uses a prompt that prevents direct implementation and defers execution to a later user turn", () => {
    const prompt = buildOneShotPlanPrompt("做一个倒计时网页");

    expect(prompt).toContain("Do not call `submit_plan`");
    expect(prompt).toContain("write a complete SPEC");
    expect(prompt).toContain("Wait for the user's next message");
    expect(prompt).toContain("做一个倒计时网页");
  });

  it("routes ordinary sends through plan-only only when the one-shot flag is armed", () => {
    const app = readFileSync("desktop/src/App.tsx", "utf8");

    expect(app).toContain("const planFirst = oneShotPlanArmed;");
    expect(app).not.toContain('state.settings?.editMode === "plan"');
    expect(app).toContain("planOneShot: planFirst");
  });

  it("keeps hidden attachment mentions out of the reconciled user-facing message", () => {
    const app = readFileSync("desktop/src/App.tsx", "utf8");
    const desktop = readFileSync("src/cli/commands/desktop.ts", "utf8");

    expect(app).toContain("displayText,");
    expect(desktop).toContain("text: opts.displayText ?? text");
  });

  it("keeps the backend guard read-only for the entire one-shot plan turn", () => {
    const desktop = readFileSync("src/cli/commands/desktop.ts", "utf8");

    expect(desktop).toContain("if (opts.planOneShot) beginOneShotPlanGuard(tab);");
    expect(desktop).not.toContain("allowExecutionAfterApproval");
    expect(desktop).not.toContain("tab.oneShotPlanPreviousPlanMode = false");
  });
});
