import { describe, expect, it } from "vitest";
import { shellSplit } from "../src/mcp/shell-split.js";

describe("shellSplit", () => {
  it("splits a simple space-separated command", () => {
    expect(shellSplit("npx -y @scope/pkg /tmp")).toEqual(["npx", "-y", "@scope/pkg", "/tmp"]);
  });

  it("collapses runs of spaces and tabs", () => {
    expect(shellSplit("a   b\tc")).toEqual(["a", "b", "c"]);
  });

  it("respects double quotes around paths with spaces", () => {
    expect(shellSplit('npx pkg "my dir/with spaces"')).toEqual([
      "npx",
      "pkg",
      "my dir/with spaces",
    ]);
  });

  it("respects single quotes and keeps inner backslashes literal", () => {
    expect(shellSplit("cmd 'a\\b c'")).toEqual(["cmd", "a\\b c"]);
  });

  it("processes backslash escapes inside double quotes", () => {
    expect(shellSplit('cmd "a\\"b"')).toEqual(["cmd", 'a"b']);
  });

  it("passes backslashes through literally OUTSIDE quotes (so Windows paths don't mangle)", () => {
    // Critical for `jupiter chat --mcp "... C:\\path\\to\\dir"`. Users
    // who want to escape a space outside quotes can quote the arg.
    expect(shellSplit("cmd C:\\path\\to\\file.exe")).toEqual(["cmd", "C:\\path\\to\\file.exe"]);
  });

  it("throws on unterminated double quote", () => {
    expect(() => shellSplit('cmd "unterminated')).toThrow(/unterminated/);
  });

  it("throws on unterminated single quote", () => {
    expect(() => shellSplit("cmd 'still open")).toThrow(/unterminated/);
  });

  it("returns empty array on whitespace-only input", () => {
    expect(shellSplit("   ")).toEqual([]);
    expect(shellSplit("")).toEqual([]);
  });
});
