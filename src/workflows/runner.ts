import type { WorkflowStore } from "./store.js";
import type {
  WorkflowAgentRun,
  WorkflowEvent,
  WorkflowRun,
  WorkflowSource,
  WorkflowTemplate,
  WorkflowTokenUsage,
} from "./types.js";
import { ZERO_TOKEN_USAGE } from "./types.js";

export interface WorkflowAgentInput {
  readonly run: WorkflowRun;
  readonly label: string;
  readonly phase: string;
  readonly input: unknown;
}

export interface WorkflowAgentResult {
  readonly summary: string;
  readonly tokenUsage: WorkflowTokenUsage;
  readonly sources?: readonly WorkflowSource[];
  readonly result?: unknown;
}

export interface RunWorkflowOptions {
  readonly template: WorkflowTemplate;
  readonly input: unknown;
  readonly store: WorkflowStore;
  readonly executeAgent: (input: WorkflowAgentInput) => Promise<WorkflowAgentResult>;
  readonly emit?: (event: WorkflowEvent) => void;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
  readonly runId?: string;
}

export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRun> {
  const now = options.now ?? (() => new Date().toISOString());
  let run: WorkflowRun = {
    id: options.runId ?? `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    workflowId: options.template.id,
    workflowVersion: options.template.version,
    title: options.template.title,
    status: "running",
    phase: null,
    input: options.input,
    startedAt: now(),
    tokenUsage: ZERO_TOKEN_USAGE,
    agents: [],
    logs: [],
    sources: [],
  };

  run = await options.store.createRun(run);
  emit(options, "workflow_started", run);

  try {
    for (const phase of options.template.phases) {
      if (options.signal?.aborted) {
        return await cancelRun(options, run, now());
      }
      run = await patchRun(options, run, {
        phase: phase.id,
        logs: [...run.logs, { ts: now(), message: phase.detail }],
      });
      emit(options, "workflow_phase_changed", run);
      emit(options, "workflow_log", run);

      const agent: WorkflowAgentRun = {
        id: `${run.id}-${phase.id}`,
        label: phase.title,
        status: "running",
        phase: phase.id,
        tokenUsage: ZERO_TOKEN_USAGE,
        startedAt: now(),
      };
      run = await patchRun(options, run, { agents: [...run.agents, agent] });
      emit(options, "workflow_agent_started", run);

      const result = await options.executeAgent({
        run,
        label: phase.id,
        phase: phase.id,
        input: options.input,
      });
      const completedAgent: WorkflowAgentRun = {
        ...agent,
        status: "completed",
        summary: result.summary,
        tokenUsage: result.tokenUsage,
        completedAt: now(),
      };
      run = await patchRun(options, run, {
        agents: run.agents.map((entry) => (entry.id === agent.id ? completedAgent : entry)),
        tokenUsage: addTokenUsage(run.tokenUsage, result.tokenUsage),
        sources: [...run.sources, ...(result.sources ?? [])],
      });
      emit(options, "workflow_agent_completed", run);
      emit(options, "workflow_token_usage", run);

      if (options.signal?.aborted) {
        return await cancelRun(options, run, now());
      }
    }
    run = await patchRun(options, run, {
      status: "completed",
      phase: "completed",
      completedAt: now(),
      result: {
        summary: `${options.template.title} completed.`,
        agents: run.agents.map((agent) => ({ label: agent.label, summary: agent.summary })),
      },
    });
    emit(options, "workflow_completed", run);
    return run;
  } catch (error) {
    run = await patchRun(options, run, {
      status: "failed",
      completedAt: now(),
      error: (error as Error).message,
    });
    emit(options, "workflow_failed", run);
    return run;
  }
}

function addTokenUsage(a: WorkflowTokenUsage, b: WorkflowTokenUsage): WorkflowTokenUsage {
  return {
    prompt: a.prompt + b.prompt,
    completion: a.completion + b.completion,
    total: a.total + b.total,
  };
}

async function patchRun(
  options: RunWorkflowOptions,
  current: WorkflowRun,
  patch: Partial<WorkflowRun>,
): Promise<WorkflowRun> {
  return await options.store.updateRun(current.id, patch);
}

async function cancelRun(
  options: RunWorkflowOptions,
  current: WorkflowRun,
  completedAt: string,
): Promise<WorkflowRun> {
  const run = await patchRun(options, current, {
    status: "canceled",
    completedAt,
    agents: current.agents.map((agent) =>
      agent.status === "running" ? { ...agent, status: "canceled", completedAt } : agent,
    ),
  });
  emit(options, "workflow_canceled", run);
  return run;
}

function emit(options: RunWorkflowOptions, type: WorkflowEvent["type"], run: WorkflowRun): void {
  options.emit?.({ type, run });
}
