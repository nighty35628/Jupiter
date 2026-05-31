import { describe, expect, it } from "vitest";
import {
  PASTE_SENTINEL_BASE,
  PASTE_SENTINEL_RANGE,
  type PasteEntry,
  bufferHasPaste,
  decodePasteSentinel,
  encodePasteSentinel,
  expandPasteSentinels,
  formatBytesShort,
  isPasteSentinel,
  listPasteIdsInBuffer,
  makePasteEntry,
} from "../src/cli/ui/paste-sentinels.js";

describe("paste sentinel encoding", () => {
  it("encode/decode round-trip across the full id range", () => {
    for (const id of [0, 1, 7, 42, 128, 255]) {
      const ch = encodePasteSentinel(id);
      expect(ch.length).toBe(1);
      expect(ch.charCodeAt(0)).toBe(PASTE_SENTINEL_BASE + id);
      expect(decodePasteSentinel(ch)).toBe(id);
      expect(isPasteSentinel(ch)).toBe(true);
    }
  });

  it("decode returns null for non-sentinel chars", () => {
    expect(decodePasteSentinel("a")).toBeNull();
    expect(decodePasteSentinel(" ")).toBeNull();
    expect(decodePasteSentinel("\n")).toBeNull();
    expect(decodePasteSentinel("中")).toBeNull();
    expect(decodePasteSentinel("")).toBeNull();
  });

  it("encode rejects ids outside [0, 256)", () => {
    expect(() => encodePasteSentinel(-1)).toThrow();
    expect(() => encodePasteSentinel(PASTE_SENTINEL_RANGE)).toThrow();
    expect(() => encodePasteSentinel(999)).toThrow();
  });
});

describe("makePasteEntry — line + char counts", () => {
  it("counts lines via \\n split (single-line content = 1 line)", () => {
    const e = makePasteEntry(0, "hello world");
    expect(e.lineCount).toBe(1);
    expect(e.charCount).toBe(11);
  });

  it("multi-line content counts each \\n as a delimiter", () => {
    const e = makePasteEntry(3, "line1\nline2\nline3");
    expect(e.lineCount).toBe(3);
  });

  it("trailing newline still counts as one line (split('\\n') has empty tail)", () => {
    const e = makePasteEntry(0, "line1\n");
    expect(e.lineCount).toBe(2);
  });
});

describe("expandPasteSentinels — round-trip back to full content", () => {
  function makeReg(entries: PasteEntry[]): Map<number, PasteEntry> {
    const m = new Map<number, PasteEntry>();
    for (const e of entries) m.set(e.id, e);
    return m;
  }

  it("expands a buffer with one sentinel back to typed-prose + paste content", () => {
    const reg = makeReg([makePasteEntry(0, "ERROR\nstack\ntrace")]);
    const buf = `prefix ${encodePasteSentinel(0)} suffix`;
    expect(expandPasteSentinels(buf, reg)).toBe("prefix ERROR\nstack\ntrace suffix");
  });

  it("expands multiple sentinels in source order", () => {
    const reg = makeReg([makePasteEntry(0, "AAA"), makePasteEntry(1, "BBB")]);
    const buf = `${encodePasteSentinel(0)} between ${encodePasteSentinel(1)}`;
    expect(expandPasteSentinels(buf, reg)).toBe("AAA between BBB");
  });

  it("unknown sentinels (id not in registry) collapse to empty string", () => {
    const reg = makeReg([]);
    const buf = `before ${encodePasteSentinel(7)} after`;
    expect(expandPasteSentinels(buf, reg)).toBe("before  after");
  });

  it("buffer with no sentinels passes through unchanged", () => {
    const reg = makeReg([]);
    expect(expandPasteSentinels("just typed text", reg)).toBe("just typed text");
  });
});

describe("bufferHasPaste / listPasteIdsInBuffer", () => {
  it("bufferHasPaste returns false for sentinel-free text", () => {
    expect(bufferHasPaste("plain text")).toBe(false);
    expect(bufferHasPaste("")).toBe(false);
  });

  it("bufferHasPaste returns true once any sentinel appears", () => {
    expect(bufferHasPaste(`x${encodePasteSentinel(0)}`)).toBe(true);
  });

  it("listPasteIdsInBuffer returns ids in source order", () => {
    const buf = `${encodePasteSentinel(2)}.${encodePasteSentinel(5)}.${encodePasteSentinel(0)}`;
    expect(listPasteIdsInBuffer(buf)).toEqual([2, 5, 0]);
  });

  it("listPasteIdsInBuffer is empty for sentinel-free text", () => {
    expect(listPasteIdsInBuffer("hi")).toEqual([]);
  });
});

describe("formatBytesShort", () => {
  it("under 1 KB prints as bytes", () => {
    expect(formatBytesShort(0)).toBe("0B");
    expect(formatBytesShort(900)).toBe("900B");
  });
  it("under 10 KB shows one decimal place", () => {
    expect(formatBytesShort(1024)).toBe("1.0KB");
    expect(formatBytesShort(5120)).toBe("5.0KB");
  });
  it("10 KB and above drops the decimal", () => {
    expect(formatBytesShort(15 * 1024)).toBe("15KB");
  });
  it("MB format kicks in past 1 MB", () => {
    expect(formatBytesShort(2 * 1024 * 1024)).toBe("2.0MB");
  });
});
