import { describe, expect, it, vi } from "vitest";
import { registerScheduledCheckpoint } from "../src/scheduler/checkpoint.js";
import { registerScheduledScopeGuard } from "../src/scheduler/scope-guard.js";
import { ToolRegistry } from "../src/tools.js";

const goal = {
  objective: "Write report",
  completionCriteria: ["Report complete"],
  allowedScope: "Reports only",
};
function fixture() {
  const registry = new ToolRegistry({ rateLimit: false });
  const execute = vi.fn(() => "done");
  registry.register({ name: "write_report", fn: execute });
  const review = vi.fn(async () => ({ allowed: true, reason: "Within scope" }));
  const block = vi.fn();
  const guard = registerScheduledScopeGuard(registry, { goal: () => goal, review, block });
  const persist = vi.fn();
  registerScheduledCheckpoint(registry, (checkpoint) => {
    persist(checkpoint);
    guard.checkpoint();
  });
  return { registry, execute, review, block, persist };
}
describe("scheduled scope boundaries", () => {
  it("refuses an out-of-scope action before the tool executes and fences subsequent calls", async () => {
    const f = fixture();
    f.review.mockResolvedValueOnce({ allowed: false, reason: "Outside Reports folder" });
    expect(await f.registry.dispatch("write_report", {})).toContain("Outside");
    await f.registry.dispatch("write_report", {});
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.block).toHaveBeenCalledTimes(1);
    expect(f.review).toHaveBeenCalledTimes(1);
  });
  it("pauses before the thirteenth action if no stage checkpoint was produced", async () => {
    const f = fixture();
    for (let index = 0; index < 13; index++) await f.registry.dispatch("write_report", {});
    expect(f.execute).toHaveBeenCalledTimes(12);
    expect(f.block).toHaveBeenCalledWith(expect.stringContaining("checkpoint"));
  });
  it("records a schema-validated stage and resets the stage action budget", async () => {
    const f = fixture();
    for (let index = 0; index < 12; index++) await f.registry.dispatch("write_report", {});
    await f.registry.dispatch("scheduled_checkpoint", {
      step: "Report drafted",
      evidence: ["File read back"],
      remaining: ["Review"],
    });
    await f.registry.dispatch("write_report", {});
    expect(f.persist).toHaveBeenCalledWith(expect.objectContaining({ remaining: ["Review"] }));
    expect(f.execute).toHaveBeenCalledTimes(13);
    expect(f.block).not.toHaveBeenCalled();
  });
  it("fails closed when the scope reviewer cannot return a valid decision", async () => {
    const f = fixture();
    f.review.mockRejectedValueOnce(new Error("provider unavailable"));
    await f.registry.dispatch("write_report", {});
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.block).toHaveBeenCalledWith("provider unavailable");
  });
});
