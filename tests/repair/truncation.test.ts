import { describe, expect, it } from "vitest";
import { repairTruncatedJson } from "../../src/repair/truncation.js";

describe("repairTruncatedJson", () => {
  it("returns parseable JSON unchanged", () => {
    const r = repairTruncatedJson('{"a":1}');
    expect(r.changed).toBe(false);
    expect(r.repaired).toBe('{"a":1}');
  });

  it("closes unbalanced braces", () => {
    const r = repairTruncatedJson('{"a":1');
    expect(r.changed).toBe(true);
    expect(() => JSON.parse(r.repaired)).not.toThrow();
  });

  it("closes nested unbalanced structures", () => {
    const r = repairTruncatedJson('{"a":{"b":[1,2');
    expect(() => JSON.parse(r.repaired)).not.toThrow();
  });

  it("closes unterminated string", () => {
    const r = repairTruncatedJson('{"a":"he');
    expect(() => JSON.parse(r.repaired)).not.toThrow();
    expect(JSON.parse(r.repaired).a.startsWith("he")).toBe(true);
  });

  it("fills dangling key with null", () => {
    const r = repairTruncatedJson('{"a":');
    expect(() => JSON.parse(r.repaired)).not.toThrow();
    expect(JSON.parse(r.repaired)).toEqual({ a: null });
  });

  it("handles empty input", () => {
    const r = repairTruncatedJson("");
    expect(r.repaired).toBe("{}");
  });

  it("drops trailing comma", () => {
    const r = repairTruncatedJson('{"a":1,');
    expect(() => JSON.parse(r.repaired)).not.toThrow();
    expect(JSON.parse(r.repaired)).toEqual({ a: 1 });
  });
});
