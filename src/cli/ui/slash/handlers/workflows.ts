import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUILT_IN_WORKFLOWS, getWorkflowTemplate } from "../../../../workflows/catalog.js";
import { createResearchWorkflowAgentExecutor } from "../../../../workflows/research-executor.js";
import { getResearchWorkflowPlan } from "../../../../workflows/research.js";
import { runWorkflow } from "../../../../workflows/runner.js";
import { createWorkflowStore } from "../../../../workflows/store.js";
import type { WorkflowRun } from "../../../../workflows/types.js";
import type { SlashHandler } from "../dispatch.js";
import type { SlashContext } from "../types.js";

const workflows: SlashHandler = () => {
  const lines = ["Built-in workflows"];
  for (const workflow of BUILT_IN_WORKFLOWS) {
    lines.push(`- ${workflow.id}: ${workflow.title}`);
  }
  return { info: lines.join("\n") };
};

const workflow: SlashHandler = (args, _loop, ctx) => {
  const sub = (args[0] ?? "status").toLowerCase();
  switch (sub) {
    case "start":
      return startWorkflow(args.slice(1), ctx, ctx.workflowRoot ?? ctx.codeRoot ?? process.cwd());
    case "status":
      return workflowStatus(ctx.workflowRoot ?? ctx.codeRoot ?? process.cwd());
    case "open":
      return openWorkflow(args[1], ctx.workflowRoot ?? ctx.codeRoot ?? process.cwd());
    case "cancel":
      return cancelWorkflow(args[1], ctx.workflowRoot ?? ctx.codeRoot ?? process.cwd());
    default:
      return { info: "usage: /workflow <start|status|open|cancel> [id]" };
  }
};

function startWorkflow(args: readonly string[], ctx: SlashContext, root: string) {
  const workflowId = args[0] ?? "deep-fact-check";
  const template = getWorkflowTemplate(workflowId);
  if (!template) return { info: `unknown workflow: ${workflowId}` };
  const runId = `wf-${Date.now().toString(36)}`;
  const userPrompt = args.slice(1).join(" ").trim();
  const plan = getResearchWorkflowPlan(template.id);
  const executeAgent =
    ctx.workflowExecuteAgent ??
    (plan
      ? createResearchWorkflowAgentExecutor({
          plan,
          userPrompt,
          workspaceDir: ctx.codeRoot ?? root,
          configPath: ctx.configPath,
        })
      : async (input) => ({
          summary: `${input.phase} checked`,
          tokenUsage: { prompt: 0, completion: 0, total: 0 },
          sources: [],
        }));

  void runWorkflow({
    runId,
    template,
    input: { prompt: userPrompt },
    store: createWorkflowStore(root),
    executeAgent,
  })
    .then((run) => {
      ctx.postInfo?.(`workflow ${run.status}: ${run.id} ${run.title}`);
    })
    .catch((error: Error) => {
      ctx.postInfo?.(`workflow failed: ${runId} ${error.message}`);
    });

  return { info: `started ${runId}: ${template.title}` };
}

function workflowStatus(root: string) {
  const runs = readWorkflowRuns(root);
  if (runs.length === 0) return { info: "Workflow runs\nNo workflow runs yet." };
  const lines = ["Workflow runs"];
  for (const run of runs.slice(0, 20)) {
    lines.push(
      `- ${run.id} ${run.status} ${run.title} phase=${run.phase ?? "-"} tokens=${run.tokenUsage.total}t agents=${agentSummary(run)}`,
    );
  }
  return { info: lines.join("\n") };
}

function openWorkflow(id: string | undefined, root: string) {
  if (!id) return { info: "usage: /workflow open <run-id>" };
  const run = readWorkflowRuns(root).find((entry) => entry.id === id);
  if (!run) return { info: `workflow run not found: ${id}` };
  const lines = [
    `${run.title}`,
    `id: ${run.id}`,
    `status: ${run.status}`,
    `phase: ${run.phase ?? "-"}`,
    `tokens: ${run.tokenUsage.total}t`,
    `agents: ${agentSummary(run)}`,
  ];
  const lastLog = run.logs.at(-1);
  if (lastLog) lines.push(`last log: ${lastLog.message}`);
  if (run.error) lines.push(`error: ${run.error}`);
  return { info: lines.join("\n") };
}

function cancelWorkflow(id: string | undefined, root: string) {
  if (!id) return { info: "usage: /workflow cancel <run-id>" };
  const runs = readWorkflowRuns(root);
  const index = runs.findIndex((run) => run.id === id);
  if (index < 0) return { info: `workflow run not found: ${id}` };
  const now = new Date().toISOString();
  runs[index] = {
    ...runs[index]!,
    status: "canceled",
    completedAt: now,
    agents: runs[index]!.agents.map((agent) =>
      agent.status === "running" ? { ...agent, status: "canceled", completedAt: now } : agent,
    ),
    logs: [...runs[index]!.logs, { ts: now, message: "canceled by user" }],
  };
  writeWorkflowRuns(root, runs);
  return { info: `canceled ${id}` };
}

function agentSummary(run: WorkflowRun): string {
  const running = run.agents.filter((agent) => agent.status === "running").length;
  const completed = run.agents.filter((agent) => agent.status === "completed").length;
  const failed = run.agents.filter((agent) => agent.status === "failed").length;
  return `${running} running, ${completed} completed, ${failed} failed`;
}

function workflowFile(root: string): string {
  return join(root, ".jupiter", "workflows", "runs.json");
}

function readWorkflowRuns(root: string): WorkflowRun[] {
  const file = workflowFile(root);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { runs?: WorkflowRun[] };
  return Array.isArray(parsed.runs)
    ? [...parsed.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    : [];
}

function writeWorkflowRuns(root: string, runs: WorkflowRun[]): void {
  const file = workflowFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ runs }, null, 2)}\n`, "utf8");
}

export const handlers: Record<string, SlashHandler> = {
  workflows,
  workflow,
};
