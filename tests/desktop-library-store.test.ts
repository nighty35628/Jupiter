import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addLibrarySourceForWorkspace,
  listLibrarySourcesForWorkspace,
  removeLibrarySourceForWorkspace,
  updateLibrarySourceContentForWorkspace,
  workspaceLibraryDir,
} from "../src/desktop/library-store.js";

describe("desktop library store", () => {
  let home: string;
  let workspace: string;
  let jupiterHome: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jupiter-library-home-"));
    workspace = mkdtempSync(join(tmpdir(), "jupiter-library-workspace-"));
    jupiterHome = join(home, ".jupiter");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("persists workspace library sources and dedupes by identity", () => {
    const first = addLibrarySourceForWorkspace(
      workspace,
      {
        kind: "web",
        title: "NotebookLM",
        url: "https://notebooklm.google/",
        snippet: "AI notebook source grounding.",
        contentText: "extracted body",
        contentFetchedAt: 1_000,
      },
      { jupiterHome },
    );
    const second = addLibrarySourceForWorkspace(
      workspace,
      {
        kind: "web",
        title: "NotebookLM duplicate",
        url: "https://notebooklm.google/",
      },
      { jupiterHome },
    );

    expect(second.id).toBe(first.id);
    const sources = listLibrarySourcesForWorkspace(workspace, { jupiterHome });
    expect(sources).toHaveLength(1);
    expect(sources[0]?.contentText).toBe("extracted body");
    expect(
      readFileSync(join(workspaceLibraryDir(workspace, { jupiterHome }), "sources.json"), "utf8"),
    ).toContain("NotebookLM");
    expect(
      existsSync(
        join(workspaceLibraryDir(workspace, { jupiterHome }), "content", `${first.id}.txt`),
      ),
    ).toBe(true);
  });

  it("updates and removes persisted source content", () => {
    const source = addLibrarySourceForWorkspace(
      workspace,
      {
        kind: "file",
        title: "notes.md",
        path: "notes.md",
      },
      { jupiterHome },
    );

    updateLibrarySourceContentForWorkspace(
      workspace,
      source.id,
      {
        contentText: "local file text",
        contentFetchedAt: 2_000,
        contentTruncated: false,
      },
      { jupiterHome },
    );
    expect(listLibrarySourcesForWorkspace(workspace, { jupiterHome })[0]?.contentText).toBe(
      "local file text",
    );

    expect(removeLibrarySourceForWorkspace(workspace, source.id, { jupiterHome })).toBe(true);
    expect(listLibrarySourcesForWorkspace(workspace, { jupiterHome })).toEqual([]);
    expect(
      existsSync(
        join(workspaceLibraryDir(workspace, { jupiterHome }), "content", `${source.id}.txt`),
      ),
    ).toBe(false);
  });
});
