import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectMemoryEntriesForWorkspace,
  deleteMemoryEntryForWorkspace,
  readMemoryEntryDetail,
  saveStructuredMemoryForWorkspace,
} from "../src/desktop/memory-browser.js";
import { MemoryStore, projectHash } from "../src/memory/user.js";

describe("desktop memory browser", () => {
  let root: string;
  let jupiterHome: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jupiter-memory-project-"));
    jupiterHome = join(mkdtempSync(join(tmpdir(), "jupiter-memory-home-")), ".jupiter");
    mkdirSync(jupiterHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(jupiterHome, { recursive: true, force: true });
  });

  it("lists project JUPITER.md, global JUPITER.md, and structured memory entries", () => {
    writeFileSync(join(root, "JUPITER.md"), "project note", "utf8");
    writeFileSync(join(jupiterHome, "JUPITER.md"), "global note", "utf8");
    const store = new MemoryStore({ homeDir: jupiterHome, projectRoot: root });
    store.write({
      name: "cli_pref",
      scope: "global",
      type: "user",
      description: "Use concise CLI output",
      body: "Keep command output short.",
    });
    store.write({
      name: "build_cmd",
      scope: "project",
      type: "project",
      description: "Use npm run verify",
      body: "Run npm run verify before release.",
    });

    const entries = collectMemoryEntriesForWorkspace(root, { jupiterHome });

    expect(entries.map((e) => `${e.kind}:${e.scope}:${e.name}`)).toEqual([
      "project_file:project:JUPITER.md",
      "global_file:global:JUPITER.md",
      "structured:global:cli_pref",
      "structured:project:build_cmd",
    ]);
    expect(entries.every((e) => existsSync(e.path))).toBe(true);
    expect(entries.find((e) => e.name === "cli_pref")!.type).toBe("user");
  });

  it("also lists migrated Claude global memory", () => {
    const home = dirname(jupiterHome);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "claude global note", "utf8");

    const entries = collectMemoryEntriesForWorkspace(root, { jupiterHome });

    expect(entries.map((e) => `${e.kind}:${e.scope}:${e.name}`)).toContain(
      "global_file:global:CLAUDE.md",
    );
    const detail = readMemoryEntryDetail(
      { path: entries.find((e) => e.name === "CLAUDE.md")!.path },
      root,
      { jupiterHome },
    );
    expect(detail.body).toBe("claude global note");
  });

  it("deletes structured memories through the browser service and refreshes the index", () => {
    const store = new MemoryStore({ homeDir: jupiterHome, projectRoot: root });
    store.write({
      name: "delete_me",
      scope: "global",
      type: "user",
      description: "Temporary memory",
      body: "Delete this later.",
    });
    store.write({
      name: "keep_me",
      scope: "global",
      type: "user",
      description: "Persistent memory",
      body: "Keep this.",
    });
    const target = collectMemoryEntriesForWorkspace(root, { jupiterHome }).find(
      (entry) => entry.name === "delete_me",
    )!;

    const deleted = deleteMemoryEntryForWorkspace({ path: target.path }, root, {
      jupiterHome,
    });

    expect(deleted).toBe(true);
    expect(
      collectMemoryEntriesForWorkspace(root, { jupiterHome }).map((e) => e.name),
    ).not.toContain("delete_me");
    const index = readFileSync(join(jupiterHome, "memory", "global", "MEMORY.md"), "utf8");
    expect(index).not.toContain("delete_me.md");
    expect(index).toContain("keep_me.md");
  });

  it("saves structured memories through the browser service and refreshes the index", () => {
    const saved = saveStructuredMemoryForWorkspace(
      {
        name: "response_style",
        scope: "project",
        type: "user",
        description: "Prefer compact release notes",
        body: "Keep release notes concise and grouped by user-visible change.",
        priority: "high",
        expires: "project_end",
      },
      root,
      { jupiterHome },
    );

    expect(saved).toMatchObject({
      kind: "structured",
      scope: "project",
      name: "response_style",
      description: "Prefer compact release notes",
      type: "user",
      priority: "high",
      expires: "project_end",
      body: "Keep release notes concise and grouped by user-visible change.",
    });
    const entries = collectMemoryEntriesForWorkspace(root, { jupiterHome });
    expect(entries.find((e) => e.name === "response_style")).toMatchObject({
      kind: "structured",
      priority: "high",
      expires: "project_end",
    });
    const index = readFileSync(join(jupiterHome, "memory", projectHash(root), "MEMORY.md"), "utf8");
    expect(index).toContain("[response_style](response_style.md)");
  });

  it("reads details only for listed memory files", () => {
    writeFileSync(join(root, "JUPITER.md"), "project note", "utf8");
    const entries = collectMemoryEntriesForWorkspace(root, { jupiterHome });

    const detail = readMemoryEntryDetail({ path: entries[0]!.path }, root, {
      jupiterHome,
    });

    expect(detail).toMatchObject({
      kind: "project_file",
      scope: "project",
      name: "JUPITER.md",
      body: "project note",
    });
    expect(() =>
      readMemoryEntryDetail({ path: join(jupiterHome, "not-listed.md") }, root, {
        jupiterHome,
      }),
    ).toThrow(/not available/);
  });
});
