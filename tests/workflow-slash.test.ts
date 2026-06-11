import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleSlash } from "../src/cli/ui/slash/dispatch.js";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../src/index.js";
import type { WorkflowAgentInput } from "../src/workflows/runner.js";
import type { WorkflowRun } from "../src/workflows/types.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jupiter-workflow-slash-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeLoop(): CacheFirstLoop {
  return new CacheFirstLoop({
    client: new DeepSeekClient({ apiKey: "sk-test" }),
    prefix: new ImmutablePrefix({ system: "s", toolSpecs: [] }),
    stream: false,
  });
}

function seedRun(run: Partial<WorkflowRun> = {}): WorkflowRun {
  const full: WorkflowRun = {
    id: "wf-1",
    workflowId: "release-readiness-check",
    workflowVersion: 1,
    title: "Release Readiness Check",
    status: "running",
    phase: "scope",
    input: { prompt: "check release" },
    startedAt: "2026-06-11T00:00:00.000Z",
    tokenUsage: { prompt: 12, completion: 8, total: 20 },
    agents: [
      {
        id: "agent-1",
        label: "Scope",
        status: "running",
        phase: "scope",
        tokenUsage: { prompt: 12, completion: 8, total: 20 },
      },
    ],
    logs: [{ ts: "2026-06-11T00:00:01.000Z", message: "checking release files" }],
    sources: [],
    ...run,
  };
  const dir = join(root, ".jupiter", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runs.json"), JSON.stringify({ runs: [full] }, null, 2));
  return full;
}

describe("/workflow slash commands", () => {
  it("lists built-in workflow templates", () => {
    const result = handleSlash("workflows", [], makeLoop(), { workflowRoot: root });

    expect(result.info).toContain("Built-in workflows");
    expect(result.info).toContain("release-readiness-check");
    expect(result.info).toContain("Deep Fact Check");
  });

  it("shows workflow run status", () => {
    seedRun();

    const result = handleSlash("workflow", ["status"], makeLoop(), { workflowRoot: root });

    expect(result.info).toContain("Workflow runs");
    expect(result.info).toContain("wf-1");
    expect(result.info).toContain("running");
    expect(result.info).toContain("20t");
  });

  it("opens a workflow run", () => {
    seedRun({ status: "completed", phase: "completed" });

    const result = handleSlash("workflow", ["open", "wf-1"], makeLoop(), { workflowRoot: root });

    expect(result.info).toContain("Release Readiness Check");
    expect(result.info).toContain("completed");
    expect(result.info).toContain("checking release files");
  });

  it("cancels a running workflow run", () => {
    seedRun();

    const result = handleSlash("workflow", ["cancel", "wf-1"], makeLoop(), { workflowRoot: root });

    expect(result.info).toContain("canceled wf-1");
    expect(
      handleSlash("workflow", ["open", "wf-1"], makeLoop(), { workflowRoot: root }).info,
    ).toContain("canceled");
  });

  it("starts a research workflow in the background", async () => {
    const posted: string[] = [];
    const result = handleSlash(
      "workflow",
      ["start", "open-source-project-selection", "compare", "browser", "automation"],
      makeLoop(),
      {
        workflowRoot: root,
        postInfo: (text) => posted.push(text),
        workflowExecuteAgent: async (input: WorkflowAgentInput) => ({
          summary: `${input.phase} checked`,
          tokenUsage: { prompt: 3, completion: 2, total: 5 },
          sources: [{ title: input.phase, url: `https://example.com/${input.phase}` }],
        }),
      },
    );

    expect(result.info).toContain("started");
    const id = result.info?.match(/wf-[a-z0-9-]+/)?.[0];
    expect(id).toBeTruthy();

    const run = await waitForRun(id!);
    expect(run.status).toBe("completed");
    expect(run.workflowId).toBe("open-source-project-selection");
    expect(run.sources.length).toBeGreaterThan(0);
    expect(posted.at(-1)).toContain("completed");
  });
});

async function waitForRun(id: string): Promise<WorkflowRun> {
  const file = join(root, ".jupiter", "workflows", "runs.json");
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { runs?: WorkflowRun[] };
      const run = parsed.runs?.find((entry) => entry.id === id);
      if (run?.status === "completed" || run?.status === "failed") return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`workflow run did not finish: ${id}`);
}
