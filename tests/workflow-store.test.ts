import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkflowStore } from "../src/workflows/store.js";
import type { WorkflowRun } from "../src/workflows/types.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jupiter-workflow-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function sampleRun(id = "run-1"): WorkflowRun {
  return {
    id,
    workflowId: "deep-fact-check",
    workflowVersion: 1,
    title: "Deep Fact Check",
    status: "running",
    phase: "scope",
    input: { prompt: "verify this" },
    startedAt: "2026-06-11T00:00:00.000Z",
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    agents: [],
    logs: [],
    sources: [],
  };
}

describe("workflow store", () => {
  it("creates and reads workflow runs", async () => {
    const store = createWorkflowStore(root);
    await store.createRun(sampleRun());

    expect(await store.getRun("run-1")).toEqual(sampleRun());
  });

  it("updates runs and preserves failed partial state", async () => {
    const store = createWorkflowStore(root);
    await store.createRun(sampleRun());

    await store.updateRun("run-1", {
      status: "failed",
      completedAt: "2026-06-11T00:01:00.000Z",
      error: "network unavailable",
      logs: [{ ts: "2026-06-11T00:00:30.000Z", message: "one agent failed" }],
    });

    expect(await store.getRun("run-1")).toMatchObject({
      id: "run-1",
      status: "failed",
      error: "network unavailable",
      logs: [{ ts: "2026-06-11T00:00:30.000Z", message: "one agent failed" }],
    });
  });

  it("lists recent runs newest first", async () => {
    const store = createWorkflowStore(root);
    await store.createRun(sampleRun("older"));
    await store.createRun({
      ...sampleRun("newer"),
      startedAt: "2026-06-11T00:02:00.000Z",
    });

    expect((await store.listRuns()).map((run) => run.id)).toEqual(["newer", "older"]);
  });

  it("returns null for missing runs", async () => {
    const store = createWorkflowStore(root);

    expect(await store.getRun("missing")).toBeNull();
  });
});
