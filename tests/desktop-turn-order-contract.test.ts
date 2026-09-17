import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop turn completion ordering contract", () => {
  it("emits one completion event only after Stop hooks and lease release", () => {
    const source = readFileSync("src/cli/commands/desktop.ts", "utf8");
    const start = source.indexOf("  async function runTurn(");
    const end = source.indexOf("  async function switchWorkspace(", start);
    const runTurn = source.slice(start, end);
    const completions = [...runTurn.matchAll(/type: "\$turn_complete"/g)].map(
      (match) => match.index ?? -1,
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(completions).toHaveLength(1);
    expect(runTurn).toContain("if (tab.turnAdmission.isCurrent(generation) && !tab.switching) {");
    expect(completions[0]).toBeGreaterThan(runTurn.indexOf('event: "Stop"'));
    expect(completions[0]).toBeGreaterThan(runTurn.indexOf("tab.turnAdmission.finish(generation)"));
  });

  it("resumes only the current retryable API failure without rewinding the turn", () => {
    const source = readFileSync("src/cli/commands/desktop.ts", "utf8");
    const start = source.indexOf('    if (msg.cmd === "retry_api") {');
    const end = source.indexOf('    if (msg.cmd === "rollback_to_turn") {', start);
    const handler = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(handler).toContain("tab.turnAdmission.running");
    expect(handler).toContain("tab.runtime.loop.canRetryFailedModelRequest()");
    expect(handler).toContain("tab.runtime.loop.lastUserText()");
    expect(handler).toContain("{ resumeApiFailure: true }");
    expect(handler).not.toContain("retryLastUser");
  });
});
