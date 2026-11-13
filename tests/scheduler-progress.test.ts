import { describe, expect, it } from "vitest";
import { ScheduledProgressMonitor } from "../src/scheduler/progress.js";

describe("scheduled progress watchdog", () => {
  it("pauses repeated identical results and keeps a bounded audit trail", () => {
    const monitor = new ScheduledProgressMonitor(() => 100);
    for (let index = 0; index < 5; index++)
      monitor.observe({ type: "tool.result", name: "read_file", result: "unchanged", ok: true });
    expect(monitor.progress.pauseReason).toContain("Repeated");
    expect(monitor.progress.recentActions).toHaveLength(5);
  });
  it("pauses consecutive failures but resets after successful progress", () => {
    const monitor = new ScheduledProgressMonitor();
    for (let index = 0; index < 2; index++)
      monitor.observe({ type: "tool.result", name: "run_command", result: `${index}`, ok: false });
    monitor.observe({ type: "tool.result", name: "read_file", result: "new evidence", ok: true });
    expect(monitor.progress.pauseReason).toBeUndefined();
    for (let index = 0; index < 3; index++)
      monitor.observe({ type: "tool.result", result: `${index}`, ok: false });
    expect(monitor.progress.pauseReason).toContain("failures");
  });
  it("does not treat model chatter as verified progress", () => {
    let now = 0;
    const monitor = new ScheduledProgressMonitor(() => now);
    now = 61_000;
    monitor.observe({ type: "model.final" });
    expect(monitor.checkStagnation(1)).toContain("No verified progress");
  });
  it("restores checkpoints without replaying old desktop actions", () => {
    const monitor = new ScheduledProgressMonitor(() => 20, {
      updatedAt: 10,
      currentStep: "old",
      recentActions: [{ at: 10, text: "click" }],
      checkpoints: [
        { at: 10, step: "stage one", evidence: ["file created"], remaining: ["verify"] },
      ],
    });
    expect(monitor.progress.checkpoints[0]?.remaining).toEqual(["verify"]);
    expect(monitor.progress.recentActions).toEqual([]);
  });
});
