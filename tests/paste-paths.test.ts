import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertPastedPathsToMentions } from "../src/cli/ui/paste-paths.js";

describe("convertPastedPathsToMentions", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jupiter-paste-paths-"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "paper.md"), "hello");
    writeFileSync(join(root, "src.ts"), "export {};");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("converts pasted workspace paths into relative @mentions", () => {
    expect(convertPastedPathsToMentions(join(root, "docs", "paper.md"), root)).toBe(
      "@docs/paper.md",
    );
  });

  it("converts multiple pasted file paths into a compact mention list", () => {
    const content = `${join(root, "docs", "paper.md")}\n${join(root, "src.ts")}`;

    expect(convertPastedPathsToMentions(content, root)).toBe("@docs/paper.md @src.ts");
  });

  it("accepts normal file URLs", () => {
    const url = `file://${join(root, "docs", "paper.md")}`;

    expect(convertPastedPathsToMentions(url, root)).toBe("@docs/paper.md");
  });

  it("leaves macOS file-reference URLs for platform-specific desktop resolution", () => {
    expect(convertPastedPathsToMentions("file:///.file/id=6571367.16939185", root)).toBeNull();
  });

  it("does not convert paths outside the workspace", () => {
    expect(convertPastedPathsToMentions("/etc/hosts", root)).toBeNull();
  });

  it("does not produce unparseable mentions for paths with spaces", () => {
    writeFileSync(join(root, "docs", "with space.md"), "hello");

    expect(convertPastedPathsToMentions(join(root, "docs", "with space.md"), root)).toBeNull();
  });

  it("leaves ordinary prose unchanged", () => {
    expect(convertPastedPathsToMentions("please read docs/paper.md soon", root)).toBeNull();
  });
});
