import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_WORKFLOWS } from "../src/workflows/catalog.js";
import { runWorkflow } from "../src/workflows/runner.js";
import { createWorkflowStore } from "../src/workflows/store.js";
import type { WorkflowEventType } from "../src/workflows/types.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jupiter-workflow-runner-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("workflow runner", () => {
  it("emits lifecycle events and aggregates token usage", async () => {
    const store = createWorkflowStore(root);
    const events: WorkflowEventType[] = [];
    const run = await runWorkflow({
      template: BUILT_IN_WORKFLOWS[0]!,
      input: { prompt: "verify this" },
      store,
      emit: (event) => events.push(event.type),
      executeAgent: async ({ label }) => ({
        summary: `${label} complete`,
        tokenUsage: { prompt: 10, completion: 5, total: 15 },
        sources: [{ title: label, url: `https://example.com/${label}` }],
      }),
      now: fixedNow(),
    });

    expect(events).toContain("workflow_started");
    expect(events).toContain("workflow_phase_changed");
    expect(events).toContain("workflow_agent_started");
    expect(events).toContain("workflow_agent_completed");
    expect(events).toContain("workflow_token_usage");
    expect(events.at(-1)).toBe("workflow_completed");
    expect(run.status).toBe("completed");
    expect(run.tokenUsage).toEqual({ prompt: 30, completion: 15, total: 45 });
    expect(run.agents).toHaveLength(3);
    expect(run.sources).toHaveLength(3);
    expect(await store.getRun(run.id)).toMatchObject({ status: "completed" });
  });

  it("persists canceled runs", async () => {
    const store = createWorkflowStore(root);
    const controller = new AbortController();
    const events: WorkflowEventType[] = [];
    const run = await runWorkflow({
      template: BUILT_IN_WORKFLOWS[0]!,
      input: { prompt: "verify this" },
      store,
      signal: controller.signal,
      emit: (event) => events.push(event.type),
      executeAgent: async () => {
        controller.abort();
        return {
          summary: "aborted",
          tokenUsage: { prompt: 1, completion: 1, total: 2 },
          sources: [],
        };
      },
      now: fixedNow(),
    });

    expect(run.status).toBe("canceled");
    expect(events.at(-1)).toBe("workflow_canceled");
    expect(await store.getRun(run.id)).toMatchObject({ status: "canceled" });
  });
});

function fixedNow(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 5, 11, 0, 0, tick++)).toISOString();
}
