import { describe, expect, it } from "vitest";
import { detectBangCommand, formatBangUserMessage } from "../src/cli/ui/bang.js";

describe("detectBangCommand", () => {
  it("returns the command body for a `!`-prefixed input", () => {
    expect(detectBangCommand("!ls src/")).toBe("ls src/");
    expect(detectBangCommand("!git status")).toBe("git status");
  });

  it("trims whitespace after the bang", () => {
    expect(detectBangCommand("!  ls")).toBe("ls");
    expect(detectBangCommand("!ls  ")).toBe("ls");
  });

  it("returns null for non-bang input", () => {
    expect(detectBangCommand("ls src/")).toBeNull();
    expect(detectBangCommand("hello world")).toBeNull();
    expect(detectBangCommand("/help")).toBeNull();
    expect(detectBangCommand("")).toBeNull();
  });

  it("returns null for `!` alone (no command body)", () => {
    expect(detectBangCommand("!")).toBeNull();
    expect(detectBangCommand("!   ")).toBeNull();
  });

  it("does NOT trigger when `!` appears mid-string", () => {
    // Only leading `!` counts. Otherwise commands like `cat foo!bar`
    // would be incorrectly intercepted.
    expect(detectBangCommand("echo !hello")).toBeNull();
    expect(detectBangCommand("what is ! for?")).toBeNull();
  });

  it("accepts a command with embedded `!` (not leading)", () => {
    // The bang is at position 0; the trailing ! in `echo hi!` is
    // part of the command body and passes through intact.
    expect(detectBangCommand("!echo hi!")).toBe("echo hi!");
  });

  it("handles multi-word commands with flags and quotes", () => {
    expect(detectBangCommand('!grep -R "foo bar" src/')).toBe('grep -R "foo bar" src/');
  });
});

describe("formatBangUserMessage", () => {
  it("prepends a `[!cmd]` header so the model can distinguish bang runs from its own tool output", () => {
    const out = formatBangUserMessage("ls", "$ ls\n[exit 0]\nfile1 file2");
    expect(out.startsWith("[!ls]\n")).toBe(true);
    expect(out).toContain("$ ls");
    expect(out).toContain("[exit 0]");
    expect(out).toContain("file1 file2");
  });

  it("preserves the output verbatim after the header", () => {
    const rawOutput = "line1\nline2\n\n[…truncated…]";
    const formatted = formatBangUserMessage("cmd", rawOutput);
    expect(formatted).toBe(`[!cmd]\n${rawOutput}`);
  });
});
