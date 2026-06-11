import { getResearchWorkflowPlan } from "./research.js";
import type {
  JsonSchema,
  WorkflowCategory,
  WorkflowPermissions,
  WorkflowTemplate,
} from "./types.js";
import { getWorkspaceWorkflowPlan } from "./workspace.js";

const TEXT_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    prompt: { type: "string", description: "User request or task description." },
  },
  required: ["prompt"],
};

const REPORT_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: { type: "object" } },
    caveats: { type: "array", items: { type: "string" } },
    recommendation: { type: "string" },
  },
  required: ["summary"],
};

const READ_ONLY_RESEARCH: WorkflowPermissions = {
  allowNetwork: true,
  allowWorkspaceRead: false,
  allowLibraryRead: true,
  allowLibraryWrite: false,
  allowFileWrite: false,
  requiresApprovalBeforeWrite: true,
};

const READ_ONLY_ENGINEERING: WorkflowPermissions = {
  allowNetwork: false,
  allowWorkspaceRead: true,
  allowLibraryRead: false,
  allowLibraryWrite: false,
  allowFileWrite: false,
  requiresApprovalBeforeWrite: true,
};

const NETWORK_ENGINEERING: WorkflowPermissions = {
  ...READ_ONLY_ENGINEERING,
  allowNetwork: true,
};

function workflow(
  id: string,
  title: string,
  description: string,
  category: WorkflowCategory,
  permissions: WorkflowPermissions,
  triggerPhrases: readonly string[],
): WorkflowTemplate {
  return {
    id,
    title,
    description,
    category,
    version: 1,
    builtIn: true,
    inputSchema: TEXT_INPUT_SCHEMA,
    outputSchema: REPORT_OUTPUT_SCHEMA,
    permissions,
    phases: phasesFor(id),
    suggestedTriggers: triggerPhrases.map((phrase) => ({ phrase, confidence: 0.75 })),
  };
}

function phasesFor(id: string): WorkflowTemplate["phases"] {
  const researchPlan = getResearchWorkflowPlan(id);
  if (researchPlan) {
    return researchPlan.checks.map((check) => ({
      id: check.id,
      title: check.title,
      detail: check.prompt,
    }));
  }
  const workspacePlan = getWorkspaceWorkflowPlan(id);
  if (workspacePlan) {
    return workspacePlan.checks.map((check) => ({
      id: check.id,
      title: check.title,
      detail: check.prompt,
    }));
  }
  return [
    { id: "scope", title: "Scope", detail: "Clarify inputs and constraints." },
    { id: "parallel-checks", title: "Parallel checks", detail: "Run focused checks." },
    { id: "synthesis", title: "Synthesis", detail: "Merge findings into a final report." },
  ];
}

export const BUILT_IN_WORKFLOWS: readonly WorkflowTemplate[] = [
  workflow(
    "deep-fact-check",
    "Deep Fact Check",
    "Verify facts across sources and return conclusions, citations, caveats, and confidence.",
    "research",
    READ_ONLY_RESEARCH,
    ["fact check this", "verify these sources", "deep research"],
  ),
  workflow(
    "paper-direction-validation",
    "Paper Direction Validation",
    "Validate data availability, baselines, novelty gaps, protocols, and publication risk.",
    "research",
    READ_ONLY_RESEARCH,
    ["validate this paper direction", "research novelty gap", "check datasets and baselines"],
  ),
  workflow(
    "open-source-project-selection",
    "Open Source Project Selection",
    "Compare repositories or libraries before integration.",
    "research",
    READ_ONLY_RESEARCH,
    ["compare these libraries", "choose an open source project", "evaluate this repo"],
  ),
  workflow(
    "technical-route-feasibility-review",
    "Technical Route Feasibility Review",
    "Evaluate implementation cost, compatibility, dependency risk, and rollback path.",
    "engineering",
    NETWORK_ENGINEERING,
    ["is this technical route feasible", "review this approach", "assess this integration"],
  ),
  workflow(
    "code-change-plan-review",
    "Code Change Plan Review",
    "Review a proposed code change for architecture impact, test strategy, and risks.",
    "engineering",
    READ_ONLY_ENGINEERING,
    ["review this implementation plan", "check this code change plan", "assess the change"],
  ),
  workflow(
    "working-tree-review",
    "PR Or Working Tree Review",
    "Review staged, unstaged, or PR changes for bugs, regressions, and missing tests.",
    "engineering",
    READ_ONLY_ENGINEERING,
    ["review my changes", "review the working tree", "check this PR"],
  ),
  workflow(
    "dependency-license-audit",
    "Dependency And License Audit",
    "Audit dependencies for license compatibility, package size, maintenance, and supply-chain risk.",
    "engineering",
    NETWORK_ENGINEERING,
    ["audit dependencies", "check license risk", "review package risk"],
  ),
  workflow(
    "release-readiness-check",
    "Release Readiness Check",
    "Check versioning, changelog, release workflow, artifacts, packaging, and blockers.",
    "engineering",
    READ_ONLY_ENGINEERING,
    ["release check", "is this ready to release", "check release blockers"],
  ),
  workflow(
    "cross-platform-compatibility-review",
    "Cross-Platform Compatibility Review",
    "Check macOS, Windows, Linux, ARM, glibc, Tauri, and permission compatibility.",
    "engineering",
    NETWORK_ENGINEERING,
    ["cross-platform review", "check linux compatibility", "check windows mac linux"],
  ),
  workflow(
    "bug-reproduction",
    "Bug Reproduction Workflow",
    "Turn a bug report into likely causes, reproduction steps, and suggested tests.",
    "engineering",
    READ_ONLY_ENGINEERING,
    ["reproduce this bug", "debug this issue", "find likely cause"],
  ),
  workflow(
    "workspace-health-check",
    "Workspace Health Check",
    "Inspect project hygiene across docs, scripts, tests, CI, licenses, releases, and dependencies.",
    "workspace",
    READ_ONLY_ENGINEERING,
    ["workspace health check", "check project hygiene", "audit this workspace"],
  ),
  workflow(
    "decision-record-generator",
    "Decision Record Generator",
    "Generate an ADR from a conversation, diff, or implementation decision.",
    "workspace",
    READ_ONLY_ENGINEERING,
    ["write an ADR", "generate decision record", "record this decision"],
  ),
];

const WORKFLOW_BY_ID = new Map(BUILT_IN_WORKFLOWS.map((workflow) => [workflow.id, workflow]));

export function getWorkflowTemplate(id: string): WorkflowTemplate | null {
  return WORKFLOW_BY_ID.get(id) ?? null;
}
