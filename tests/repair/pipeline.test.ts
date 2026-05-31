import { describe, expect, it } from "vitest";
import { ToolCallRepair } from "../../src/repair/index.js";
import type { ToolCall } from "../../src/types.js";

function call(id: string, name: string, args: string): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

describe("ToolCallRepair pipeline", () => {
  it("merges scavenged calls with declared calls", () => {
    const repair = new ToolCallRepair({ allowedToolNames: new Set(["search"]) });
    const declared = [call("c1", "search", '{"q":"a"}')];
    const reasoning = `I should also run {"name": "search", "arguments": {"q": "b"}}`;
    const { calls, report } = repair.process(declared, reasoning);
    expect(calls.length).toBe(2);
    expect(report.scavenged).toBe(1);
  });

  it("repairs truncated arguments JSON", () => {
    const repair = new ToolCallRepair({ allowedToolNames: new Set(["search"]) });
    const declared = [call("c1", "search", '{"q":"abc')];
    const { calls, report } = repair.process(declared, null);
    expect(calls.length).toBe(1);
    expect(() => JSON.parse(calls[0]!.function.arguments)).not.toThrow();
    expect(report.truncationsFixed).toBe(1);
  });

  it("breaks call storms", () => {
    const repair = new ToolCallRepair({
      allowedToolNames: new Set(["x"]),
      stormWindow: 6,
      stormThreshold: 3,
    });
    for (let i = 0; i < 2; i++) {
      repair.process([call(`c${i}`, "x", "{}")], null);
    }
    const { calls, report } = repair.process([call("c3", "x", "{}")], null);
    expect(calls.length).toBe(0);
    expect(report.stormsBroken).toBe(1);
  });

  it("dedupes scavenge vs declared by signature", () => {
    const repair = new ToolCallRepair({ allowedToolNames: new Set(["search"]) });
    const declared = [call("c1", "search", '{"q":"a"}')];
    const reasoning = `noted: {"name":"search","arguments":{"q":"a"}}`;
    const { calls, report } = repair.process(declared, reasoning);
    expect(calls.length).toBe(1);
    expect(report.scavenged).toBe(0);
  });

  it("scavenges DSML tool calls from the content channel (regular turn, not just reasoning)", () => {
    // R1 sometimes emits the DSML envelope in the content stream
    // instead of the proper tool_calls field. Before this wire-up,
    // the model's intent was silently dropped.
    const repair = new ToolCallRepair({
      allowedToolNames: new Set(["filesystem_read_file"]),
    });
    const content = [
      "I'll read the file next.",
      '<｜DSML｜invoke name="filesystem_read_file">',
      '  <｜DSML｜parameter name="path" string="true">README.md</｜DSML｜parameter>',
      "</｜DSML｜invoke>",
    ].join("\n");
    const { calls, report } = repair.process([], null, content);
    expect(calls.length).toBe(1);
    expect(calls[0]!.function.name).toBe("filesystem_read_file");
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ path: "README.md" });
    expect(report.scavenged).toBe(1);
  });

  it("does not double-count when DSML appears in both reasoning and content", () => {
    const repair = new ToolCallRepair({ allowedToolNames: new Set(["search"]) });
    const dsml =
      '<｜DSML｜invoke name="search"><｜DSML｜parameter name="q" string="true">ts</｜DSML｜parameter></｜DSML｜invoke>';
    const { calls, report } = repair.process([], dsml, dsml);
    expect(calls.length).toBe(1);
    expect(report.scavenged).toBe(1);
  });

  it("resetStorm clears the repeat-window so post-reset calls aren't suppressed", () => {
    const repair = new ToolCallRepair({
      allowedToolNames: new Set(["x"]),
      stormWindow: 6,
      stormThreshold: 3,
    });
    // Build up to the storm threshold — third identical call would be suppressed.
    for (let i = 0; i < 2; i++) {
      repair.process([call(`c${i}`, "x", "{}")], null);
    }
    // Mid-turn reset (what step() does on each new user message).
    repair.resetStorm();
    // With a fresh window the next call passes through — no suppression.
    const { calls, report } = repair.process([call("c-after", "x", "{}")], null);
    expect(calls.length).toBe(1);
    expect(report.stormsBroken).toBe(0);
  });
});
