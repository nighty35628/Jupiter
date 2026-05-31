import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectMemoryEntriesForWorkspace,
  readMemoryEntryDetail,
} from "../src/desktop/memory-browser.js";
import { MemoryStore } from "../src/memory/user.js";

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

  it("reads details only for listed memory files", () => {
    writeFileSync(join(root, "JUPITER.md"), "project note", "utf8");
    const entries = collectMemoryEntriesForWorkspace(root, { jupiterHome });

    const detail = readMemoryEntryDetail({ path: entries[0]!.path }, root, { jupiterHome });

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
