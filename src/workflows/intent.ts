import { BUILT_IN_WORKFLOWS, getWorkflowTemplate } from "./catalog.js";

export type WorkflowTriggerMode = "off" | "suggest" | "explicit";
export type WorkflowEstimatedCost = "low" | "medium" | "high";

export interface WorkflowIntent {
  readonly shouldSuggest: boolean;
  readonly shouldStart: boolean;
  readonly workflowId?: string;
  readonly confidence: number;
  readonly reason: string;
  readonly estimatedCost: WorkflowEstimatedCost;
}

export type WorkflowIntentModelClassifier = (prompt: string) => Promise<string>;

interface ClassifyWorkflowIntentOptions {
  readonly text: string;
  readonly mode?: WorkflowTriggerMode;
  readonly classifyWithModel?: WorkflowIntentModelClassifier;
}

const NO_INTENT: WorkflowIntent = {
  shouldSuggest: false,
  shouldStart: false,
  confidence: 0,
  reason: "no workflow intent",
  estimatedCost: "low",
};

export function buildWorkflowIntentPrompt(text: string): string {
  const catalog = BUILT_IN_WORKFLOWS.map((workflow) => ({
    id: workflow.id,
    title: workflow.title,
    category: workflow.category,
    description: workflow.description,
    triggers: workflow.suggestedTriggers.map((trigger) => trigger.phrase),
  }));
  return [
    "You classify whether a user request should use one of Jupiter's built-in workflows.",
    "Return JSON only with this shape:",
    '{"shouldSuggest":boolean,"shouldStart":boolean,"workflowId":string|null,"confidence":number,"reason":string,"estimatedCost":"low"|"medium"|"high"}',
    "Only choose workflowId from the catalog. Choose null when ordinary chat is better.",
    "Use shouldStart only when the user explicitly asks to run/start/use a workflow.",
    "Prefer shouldSuggest for broad research, release, review, compatibility, license, bug-reproduction, workspace-health, and ADR tasks.",
    "Do not suggest workflows for tiny edits, ordinary Q&A, translation, casual writing, or one-step commands.",
    "",
    "Catalog:",
    JSON.stringify(catalog),
    "",
    "User request:",
    text.trim().slice(0, 4_000),
  ].join("\n");
}

export async function classifyWorkflowIntent(
  options: ClassifyWorkflowIntentOptions,
): Promise<WorkflowIntent> {
  const mode = options.mode ?? "suggest";
  if (mode === "off") {
    return {
      ...NO_INTENT,
      reason: "workflow suggestions disabled",
    };
  }
  const text = options.text.trim();
  if (!text || !options.classifyWithModel) return NO_INTENT;

  try {
    const raw = await options.classifyWithModel(buildWorkflowIntentPrompt(text));
    const parsed = JSON.parse(raw) as Partial<WorkflowIntent>;
    const workflowId =
      typeof parsed.workflowId === "string" && getWorkflowTemplate(parsed.workflowId)
        ? parsed.workflowId
        : undefined;
    if (!workflowId) return NO_INTENT;

    const confidence = clampConfidence(parsed.confidence);
    const estimatedCost = parseEstimatedCost(parsed.estimatedCost);
    const reason = typeof parsed.reason === "string" ? parsed.reason : "model classified workflow";
    if (mode === "explicit") {
      return {
        shouldSuggest: false,
        shouldStart: parsed.shouldStart === true,
        workflowId,
        confidence,
        reason,
        estimatedCost,
      };
    }
    return {
      shouldSuggest: parsed.shouldSuggest === true || parsed.shouldStart === true,
      shouldStart: false,
      workflowId,
      confidence,
      reason,
      estimatedCost,
    };
  } catch {
    return NO_INTENT;
  }
}

function clampConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function parseEstimatedCost(value: unknown): WorkflowEstimatedCost {
  return value === "medium" || value === "high" ? value : "low";
}
