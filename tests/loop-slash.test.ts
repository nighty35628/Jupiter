import { describe, expect, it } from "vitest";
import {
  MAX_LOOP_INTERVAL_MS,
  MIN_LOOP_INTERVAL_MS,
  formatDuration,
  formatLoopStatus,
  parseLoopCommand,
  parseLoopInterval,
} from "../src/cli/ui/loop.js";

describe("parseLoopInterval", () => {
  it("treats a bare number as seconds", () => {
    expect(parseLoopInterval("45")).toEqual({ ms: 45_000 });
  });

  it("supports `s` / `m` / `h` units", () => {
    expect(parseLoopInterval("30s")).toEqual({ ms: 30_000 });
    expect(parseLoopInterval("5m")).toEqual({ ms: 300_000 });
    expect(parseLoopInterval("2h")).toEqual({ ms: 7_200_000 });
  });

  it("supports the long-form `min` / `hrs` aliases", () => {
    expect(parseLoopInterval("5min")).toEqual({ ms: 300_000 });
    expect(parseLoopInterval("2hrs")).toEqual({ ms: 7_200_000 });
  });

  it("supports fractional values", () => {
    expect(parseLoopInterval("1.5m")).toEqual({ ms: 90_000 });
  });

  it("is case-insensitive on the unit", () => {
    expect(parseLoopInterval("30S")).toEqual({ ms: 30_000 });
    expect(parseLoopInterval("5M")).toEqual({ ms: 300_000 });
  });

  it("returns null for empty / non-numeric / unknown unit", () => {
    expect(parseLoopInterval("")).toBeNull();
    expect(parseLoopInterval("   ")).toBeNull();
    expect(parseLoopInterval("foo")).toBeNull();
    expect(parseLoopInterval("5d")).toBeNull(); // days unsupported
    expect(parseLoopInterval("abc5m")).toBeNull();
  });

  it("rejects intervals below the floor (5s)", () => {
    expect(parseLoopInterval("1s")).toBeNull();
    expect(parseLoopInterval("3")).toBeNull();
  });

  it("accepts the floor exactly", () => {
    const r = parseLoopInterval("5s");
    expect(r?.ms).toBe(MIN_LOOP_INTERVAL_MS);
  });

  it("rejects intervals above the ceiling (6h)", () => {
    expect(parseLoopInterval("12h")).toBeNull();
  });

  it("accepts the ceiling exactly", () => {
    const r = parseLoopInterval("6h");
    expect(r?.ms).toBe(MAX_LOOP_INTERVAL_MS);
  });

  it("rejects zero / negative", () => {
    expect(parseLoopInterval("0")).toBeNull();
    expect(parseLoopInterval("-30s")).toBeNull();
  });
});

describe("parseLoopCommand", () => {
  it("empty args → status (caller prints active-loop info)", () => {
    expect(parseLoopCommand([])).toEqual({ kind: "status" });
  });

  it("single 'stop' / 'off' / 'cancel' → stop", () => {
    expect(parseLoopCommand(["stop"])).toEqual({ kind: "stop" });
    expect(parseLoopCommand(["off"])).toEqual({ kind: "stop" });
    expect(parseLoopCommand(["cancel"])).toEqual({ kind: "stop" });
    expect(parseLoopCommand(["STOP"])).toEqual({ kind: "stop" });
  });

  it("interval + prompt → start", () => {
    expect(parseLoopCommand(["30s", "npm", "test"])).toEqual({
      kind: "start",
      intervalMs: 30_000,
      prompt: "npm test",
    });
  });

  it("interval + slash-command prompt is allowed (loop a slash)", () => {
    // /loop 1m /status — refresh status every minute.
    expect(parseLoopCommand(["1m", "/status"])).toEqual({
      kind: "start",
      intervalMs: 60_000,
      prompt: "/status",
    });
  });

  it("malformed interval → error with usage hint", () => {
    const r = parseLoopCommand(["foo", "bar"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain("usage");
      expect(r.message).toContain("/loop stop");
    }
  });

  it("interval present but prompt missing → error", () => {
    const r = parseLoopCommand(["30s"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain("prompt is missing");
    }
  });

  it("preserves prompt whitespace via single-space rejoin", () => {
    // commander-style splitting collapses runs of whitespace into single
    // tokens; we accept that rejoining with a single space is "good
    // enough" since the prompts are natural-language anyway.
    expect(parseLoopCommand(["30s", "run", "the", "tests"])).toEqual({
      kind: "start",
      intervalMs: 30_000,
      prompt: "run the tests",
    });
  });
});

describe("formatDuration", () => {
  it("returns `<N>s` for under a minute", () => {
    expect(formatDuration(28_000)).toBe("28s");
  });

  it("returns `<m>m<s>s` for under an hour", () => {
    expect(formatDuration(263_000)).toBe("4m23s");
    expect(formatDuration(120_000)).toBe("2m"); // exactly 2 minutes drops the trailing 0s
  });

  it("returns `<h>h<m>m` for over an hour", () => {
    expect(formatDuration(3_900_000)).toBe("1h5m");
    expect(formatDuration(3_600_000)).toBe("1h"); // exactly 1h
  });

  it("falls back to ms for sub-second values", () => {
    expect(formatDuration(750)).toBe("750ms");
  });
});

describe("formatLoopStatus", () => {
  it("includes the prompt preview, countdown, and iter count", () => {
    const out = formatLoopStatus("npm test", 28_000, 3);
    expect(out).toContain("loop:");
    expect(out).toContain("`npm test`");
    expect(out).toContain("next in 28s");
    expect(out).toContain("iter 3");
  });

  it("clips long prompts to ~36 chars with an ellipsis", () => {
    const long = "rerun the entire test suite and produce a coverage report for review";
    const out = formatLoopStatus(long, 60_000, 1);
    expect(out).toContain("…");
    // The `…` should appear after some prefix of the prompt and before `·`.
    const match = out.match(/loop: `(.+?)` · /);
    expect(match).not.toBeNull();
    expect(match![1]!.length).toBeLessThanOrEqual(36);
    expect(match![1]!.endsWith("…")).toBe(true);
  });

  it("shows `firing now` when nextFireMs is 0 or negative", () => {
    expect(formatLoopStatus("x", 0, 1)).toContain("firing now");
    expect(formatLoopStatus("x", -100, 1)).toContain("firing now");
  });
});
