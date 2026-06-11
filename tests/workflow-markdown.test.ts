import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listLibrarySourcesForWorkspace } from "../src/desktop/library-store.js";
import { formatWorkflowRunMarkdown, saveWorkflowRunToLibrary } from "../src/workflows/markdown.js";
import type { WorkflowRun } from "../src/workflows/types.js";

let root: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jupiter-workflow-markdown-"));
  home = await mkdtemp(join(tmpdir(), "jupiter-workflow-library-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("workflow markdown actions", () => {
  it("formats a completed workflow run as markdown", () => {
    const markdown = formatWorkflowRunMarkdown(sampleRun());

    expect(markdown).toContain("# Release Readiness Check");
    expect(markdown).toContain("Status: completed");
    expect(markdown).toContain("Total tokens: 42");
    expect(markdown).toContain("Version checked");
    expect(markdown).toContain("https://example.com/release");
  });

  it("saves a workflow report into the workspace library", async () => {
    await mkdir(join(root, ".jupiter", "workflows"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Demo\n");

    const saved = await saveWorkflowRunToLibrary(root, sampleRun(), { jupiterHome: home });
    const report = await readFile(saved.reportPath, "utf8");
    const sources = listLibrarySourcesForWorkspace(root, { jupiterHome: home });

    expect(report).toContain("# Release Readiness Check");
    expect(saved.source.title).toContain("Release Readiness Check");
    expect(sources.some((source) => source.id === saved.source.id)).toBe(true);
  });
});

function sampleRun(): WorkflowRun {
  return {
    id: "wf-1",
    workflowId: "release-readiness-check",
    workflowVersion: 1,
    title: "Release Readiness Check",
    status: "completed",
    phase: "completed",
    input: { prompt: "release check" },
    startedAt: "2026-06-11T00:00:00.000Z",
    completedAt: "2026-06-11T00:00:05.000Z",
    tokenUsage: { prompt: 20, completion: 22, total: 42 },
    agents: [
      {
        id: "a1",
        label: "Version",
        status: "completed",
        phase: "version-changelog",
        summary: "Version checked",
        tokenUsage: { prompt: 20, completion: 22, total: 42 },
      },
    ],
    logs: [{ ts: "2026-06-11T00:00:01.000Z", message: "checking version" }],
    sources: [{ title: "Release notes", url: "https://example.com/release" }],
    result: { summary: "Ready with caveats." },
  };
}
