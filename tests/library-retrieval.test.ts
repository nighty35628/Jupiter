import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addLibrarySourceForWorkspace,
  extractLibraryFileContentForWorkspace,
  readLibrarySourceForWorkspace,
  searchLibrarySourcesForWorkspace,
} from "../src/desktop/library-store.js";
import { ToolRegistry } from "../src/tools.js";
import { registerLibraryTools } from "../src/tools/library.js";

describe("library retrieval", () => {
  let home: string;
  let workspace: string;
  let jupiterHome: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jupiter-library-retrieval-home-"));
    workspace = mkdtempSync(join(tmpdir(), "jupiter-library-retrieval-workspace-"));
    jupiterHome = join(home, ".jupiter");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("searches saved source content and reads the matched chunk", () => {
    const source = addLibrarySourceForWorkspace(
      workspace,
      {
        kind: "web",
        title: "Grounded notes",
        url: "https://example.test/grounding",
        contentText:
          "Notebook workflows need citations. Library grounding keeps answers tied to sources.",
      },
      { jupiterHome },
    );

    const result = searchLibrarySourcesForWorkspace(workspace, {
      query: "library citations",
      jupiterHome,
    });

    expect(result.results[0]?.sourceId).toBe(source.id);
    expect(result.results[0]?.chunkId).toBe(`${source.id}:0`);

    const read = readLibrarySourceForWorkspace(workspace, {
      sourceId: source.id,
      chunkId: `${source.id}:0`,
      jupiterHome,
    });
    expect(read.title).toBe("Grounded notes");
    expect(read.text).toContain("Library grounding keeps answers tied to sources");
  });

  it("extracts local text-like files into persisted source content", () => {
    const path = join(workspace, "brief.html");
    writeFileSync(
      path,
      "<!doctype html><title>Brief</title><main><h1>Research Brief</h1><p>Evidence body.</p></main>",
    );
    const source = addLibrarySourceForWorkspace(
      workspace,
      { kind: "file", title: "brief.html", path },
      { jupiterHome },
    );

    const updated = extractLibraryFileContentForWorkspace(workspace, source.id, { jupiterHome });

    expect(updated?.ingestStatus).toBe("done");
    expect(updated?.contentText).toContain("Research Brief");
    expect(updated?.contentText).toContain("Evidence body.");
  });

  it("registers model tools for searching and reading the workspace library", async () => {
    const source = addLibrarySourceForWorkspace(
      workspace,
      {
        kind: "file",
        title: "plan.md",
        path: join(workspace, "plan.md"),
        contentText: "The launch plan mentions cache-first research workflows.",
      },
      { jupiterHome },
    );
    const tools = new ToolRegistry();
    registerLibraryTools(tools, { workspaceDir: workspace, jupiterHome });

    const search = JSON.parse(
      await tools.dispatch("library_search", { query: "cache-first research" }),
    );
    expect(search.results[0]?.sourceId).toBe(source.id);

    const read = JSON.parse(
      await tools.dispatch("library_read", {
        sourceId: source.id,
        chunkId: search.results[0]?.chunkId,
      }),
    );
    expect(read.text).toContain("cache-first research workflows");
  });

  it("keeps library tools registered but refuses reads when retrieval is disabled", async () => {
    addLibrarySourceForWorkspace(
      workspace,
      {
        kind: "file",
        title: "plan.md",
        path: join(workspace, "plan.md"),
        contentText: "The launch plan mentions cache-first research workflows.",
      },
      { jupiterHome },
    );
    const tools = new ToolRegistry();
    registerLibraryTools(tools, {
      workspaceDir: workspace,
      jupiterHome,
      retrievalMode: () => "off",
    });

    expect(tools.has("library_search")).toBe(true);
    const search = JSON.parse(await tools.dispatch("library_search", { query: "launch" }));
    expect(search.error).toMatch(/disabled/i);
  });
});
