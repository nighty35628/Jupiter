import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_WORKFLOWS } from "../src/workflows/catalog.js";
import type { WorkflowRun } from "../src/workflows/types.js";
import { createWorkspaceWorkflowAgentExecutor } from "../src/workflows/workspace-executor.js";
import {
  buildWorkspaceAgentPrompt,
  getWorkspaceWorkflowPlan,
  isWorkspaceWorkflow,
} from "../src/workflows/workspace.js";

const BATCH_2_IDS = ["code-change-plan-review", "working-tree-review", "bug-reproduction"] as const;

const BATCH_3_IDS = [
  "dependency-license-audit",
  "release-readiness-check",
  "cross-platform-compatibility-review",
  "workspace-health-check",
] as const;

const BATCH_4_WORKSPACE_IDS = ["decision-record-generator"] as const;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jupiter-workspace-workflows-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("workspace workflow definitions", () => {
  it("defines Batch 2, 3, and workspace Batch 4 plans", () => {
    for (const id of [...BATCH_2_IDS, ...BATCH_3_IDS, ...BATCH_4_WORKSPACE_IDS]) {
      const plan = getWorkspaceWorkflowPlan(id);

      expect(plan).not.toBeNull();
      expect(plan?.checks.length).toBeGreaterThanOrEqual(3);
      expect(plan?.outputSchema.required).toEqual(
        expect.arrayContaining(["summary", "findings", "risks", "nextSteps"]),
      );
      expect(plan?.recommendedTools).toContain("workspace_read");
    }
  });

  it("uses concrete plan checks as catalog phases for non-research workflows", () => {
    for (const id of [...BATCH_2_IDS, ...BATCH_3_IDS, ...BATCH_4_WORKSPACE_IDS]) {
      const template = BUILT_IN_WORKFLOWS.find((workflow) => workflow.id === id);
      const plan = getWorkspaceWorkflowPlan(id);

      expect(isWorkspaceWorkflow(id)).toBe(true);
      expect(template?.phases.map((phase) => phase.id)).toEqual(
        plan?.checks.map((check) => check.id),
      );
      expect(template?.phases.map((phase) => phase.id)).not.toContain("parallel-checks");
    }
  });

  it("builds self-contained workspace prompts", () => {
    const plan = getWorkspaceWorkflowPlan("working-tree-review")!;
    const prompt = buildWorkspaceAgentPrompt(plan.checks[0]!, {
      userPrompt: "review my changes",
      workflowTitle: plan.title,
      workspaceDir: "/repo",
    });

    expect(prompt).toContain("review my changes");
    expect(prompt).toContain("/repo");
    expect(prompt).toContain("workspace evidence");
    expect(prompt).toContain("file references");
  });
});

describe("workspace workflow executor", () => {
  it("summarizes workspace evidence with file sources", async () => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "demo", license: "GPL-3.0-or-later", scripts: { test: "vitest" } }),
    );
    await writeFile(join(root, "README.md"), "# Demo\n");
    await writeFile(join(root, "LICENSE"), "GPL-3.0-or-later\n");

    const plan = getWorkspaceWorkflowPlan("workspace-health-check")!;
    const executor = createWorkspaceWorkflowAgentExecutor({
      plan,
      userPrompt: "check workspace health",
      workspaceDir: root,
    });

    const result = await executor({
      run: sampleRun("workspace-health-check"),
      label: plan.checks[0]!.id,
      phase: plan.checks[0]!.id,
      input: { prompt: "check workspace health" },
    });

    expect(result.summary).toContain("package.json");
    expect(result.summary).toContain("README.md");
    expect(result.summary).toContain("LICENSE");
    expect(result.sources).toEqual(
      expect.arrayContaining([
        { title: "package.json", path: join(root, "package.json") },
        { title: "README.md", path: join(root, "README.md") },
      ]),
    );
    expect(result.tokenUsage.total).toBeGreaterThan(0);
  });
});

function sampleRun(workflowId: string): WorkflowRun {
  return {
    id: "wf-1",
    workflowId,
    workflowVersion: 1,
    title: workflowId,
    status: "running",
    phase: null,
    input: { prompt: "check" },
    startedAt: "2026-06-11T00:00:00.000Z",
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    agents: [],
    logs: [],
    sources: [],
  };
}
