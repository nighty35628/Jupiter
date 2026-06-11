export type WorkflowCategory = "research" | "engineering" | "workspace";

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "canceled";

export type WorkflowAgentStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export type WorkflowEventType =
  | "workflow_started"
  | "workflow_phase_changed"
  | "workflow_log"
  | "workflow_agent_started"
  | "workflow_agent_updated"
  | "workflow_agent_completed"
  | "workflow_token_usage"
  | "workflow_waiting_approval"
  | "workflow_completed"
  | "workflow_failed"
  | "workflow_canceled";

export interface JsonSchema {
  readonly type: string;
  readonly additionalProperties?: boolean;
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly items?: unknown;
  readonly enum?: readonly string[];
  readonly description?: string;
}

export interface WorkflowPermissions {
  readonly allowNetwork: boolean;
  readonly allowWorkspaceRead: boolean;
  readonly allowLibraryRead: boolean;
  readonly allowLibraryWrite: boolean;
  readonly allowFileWrite: boolean;
  readonly requiresApprovalBeforeWrite: boolean;
}

export interface WorkflowPhaseTemplate {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}

export interface WorkflowTriggerHint {
  readonly phrase: string;
  readonly confidence: number;
}

export interface WorkflowTemplate {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: WorkflowCategory;
  readonly version: number;
  readonly builtIn: true;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly permissions: WorkflowPermissions;
  readonly phases: readonly WorkflowPhaseTemplate[];
  readonly suggestedTriggers: readonly WorkflowTriggerHint[];
}

export interface WorkflowTokenUsage {
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
}

export interface WorkflowSource {
  readonly title: string;
  readonly url?: string;
  readonly path?: string;
}

export interface WorkflowLogEntry {
  readonly ts: string;
  readonly message: string;
}

export interface WorkflowAgentRun {
  readonly id: string;
  readonly label: string;
  readonly status: WorkflowAgentStatus;
  readonly phase: string;
  readonly summary?: string;
  readonly tokenUsage: WorkflowTokenUsage;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface WorkflowRun {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly title: string;
  readonly status: WorkflowRunStatus;
  readonly phase: string | null;
  readonly input: unknown;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly tokenUsage: WorkflowTokenUsage;
  readonly agents: readonly WorkflowAgentRun[];
  readonly logs: readonly WorkflowLogEntry[];
  readonly sources: readonly WorkflowSource[];
  readonly result?: unknown;
  readonly error?: string;
}

export interface WorkflowEvent {
  readonly type: WorkflowEventType;
  readonly run: WorkflowRun;
}

export const ZERO_TOKEN_USAGE: WorkflowTokenUsage = {
  prompt: 0,
  completion: 0,
  total: 0,
};
