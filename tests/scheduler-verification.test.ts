import { describe, expect, it } from "vitest";
import type { ScheduledTask } from "../src/scheduler/types.js";
import { verifyScheduledGoal } from "../src/scheduler/verification.js";

const task = {
  goal: {
    objective: "Report",
    allowedScope: "Workspace",
    completionCriteria: ["Exists", "Validated"],
  },
} as ScheduledTask;
const evidence = [
  { id: "tool-1", text: "file exists" },
  { id: "tool-2", text: "validation passed" },
];
const good = () => ({
  criteria: [
    { index: 0, met: true, evidence: "file exists", evidenceIds: ["tool-1"] },
    { index: 1, met: true, evidence: "checks passed", evidenceIds: ["tool-2"] },
  ],
  remaining: [] as string[],
  scopeRespected: true,
});

describe("scheduled goal verification", () => {
  it("requires observed receipts for every criterion", () => {
    expect(verifyScheduledGoal(JSON.stringify(good()), task, evidence).verified).toBe(true);
    expect(verifyScheduledGoal(JSON.stringify(good()), task, []).verified).toBe(false);
  });
  it("rejects missing and duplicate criteria instead of accepting a success claim", () => {
    const audit = good();
    audit.criteria[1]!.index = 0;
    expect(() => verifyScheduledGoal(JSON.stringify(audit), task, evidence)).toThrow(
      /every criterion/,
    );
    audit.criteria.pop();
    expect(() => verifyScheduledGoal(JSON.stringify(audit), task, evidence)).toThrow();
  });
  it("keeps the goal incomplete for outstanding work and scope violations", () => {
    const audit = good();
    audit.remaining = ["review final output"];
    expect(verifyScheduledGoal(JSON.stringify(audit), task, evidence).verified).toBe(false);
    audit.remaining = [];
    audit.scopeRespected = false;
    expect(verifyScheduledGoal(JSON.stringify(audit), task, evidence).verified).toBe(false);
  });
  it("rejects malformed audit data and unsupported receipt references", () => {
    expect(() => verifyScheduledGoal("Done!", task, evidence)).toThrow();
    const audit = good();
    audit.criteria[0]!.evidenceIds = ["fabricated"];
    expect(verifyScheduledGoal(JSON.stringify(audit), task, evidence).verified).toBe(false);
  });
});
