import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupJupiterStorage, scanJupiterStorage } from "../src/desktop/storage-manager.js";

describe("desktop storage manager", () => {
  let home: string;
  let jupiterHome: string;
  let workspace: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jupiter-storage-home-"));
    jupiterHome = join(home, ".jupiter");
    workspace = mkdtempSync(join(tmpdir(), "jupiter-storage-workspace-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("classifies safe caches separately from optional user data and review-only workspace data", () => {
    mkdirSync(join(jupiterHome, "cache"), { recursive: true });
    writeFileSync(join(jupiterHome, "cache", "search.tmp"), "cache bytes");
    mkdirSync(join(jupiterHome, "sessions", "archive"), { recursive: true });
    writeFileSync(join(jupiterHome, "sessions", "archive", "old.jsonl"), '{"role":"user"}\n');
    mkdirSync(join(jupiterHome, "library", "abc", "content"), { recursive: true });
    writeFileSync(join(jupiterHome, "library", "abc", "sources.json"), "[]");
    writeFileSync(join(jupiterHome, "library", "abc", "content", "a.txt"), "library cache");
    mkdirSync(join(workspace, ".jupiter"), { recursive: true });
    writeFileSync(join(workspace, ".jupiter", "state.json"), "{}");

    const scan = scanJupiterStorage({
      jupiterHome,
      workspaceDir: workspace,
      recentWorkspaces: [workspace],
    });

    expect(scan.totalBytes).toBeGreaterThan(0);
    expect(scan.items.find((item) => item.id === "safe:jupiter-cache")?.tier).toBe("safe");
    expect(scan.items.find((item) => item.id === "optional:archived-sessions")?.tier).toBe(
      "optional",
    );
    expect(scan.items.find((item) => item.id === "optional:library-data")?.tier).toBe("optional");
    const workspaceItem = scan.items.find((item) => item.id.startsWith("review:workspace-meta:"));
    expect(workspaceItem?.tier).toBe("review");
    expect(workspaceItem?.cleanup).toBe("none");
  });

  it("cleans only ids from the current scan and never accepts raw paths", () => {
    mkdirSync(join(jupiterHome, "cache"), { recursive: true });
    writeFileSync(join(jupiterHome, "cache", "search.tmp"), "cache bytes");
    mkdirSync(join(jupiterHome, "sessions", "archive"), { recursive: true });
    writeFileSync(join(jupiterHome, "sessions", "archive", "old.jsonl"), '{"role":"user"}\n');
    const protectedFile = join(home, "protected.txt");
    writeFileSync(protectedFile, "do not delete");

    const result = cleanupJupiterStorage({
      jupiterHome,
      workspaceDir: workspace,
      recentWorkspaces: [],
      itemIds: ["safe:jupiter-cache", protectedFile, "review:workspace-meta:nope"],
    });

    expect(result.freedBytes).toBeGreaterThan(0);
    expect(existsSync(join(jupiterHome, "cache"))).toBe(false);
    expect(existsSync(join(jupiterHome, "sessions", "archive", "old.jsonl"))).toBe(true);
    expect(readFileSync(protectedFile, "utf8")).toBe("do not delete");
    expect(result.results.find((item) => item.id === protectedFile)?.status).toBe("skipped");
    expect(result.results.find((item) => item.id === "review:workspace-meta:nope")?.status).toBe(
      "skipped",
    );
  });
});
