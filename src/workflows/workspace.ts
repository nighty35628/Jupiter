import type { JsonSchema } from "./types.js";

export type WorkspaceWorkflowId =
  | "code-change-plan-review"
  | "working-tree-review"
  | "bug-reproduction"
  | "dependency-license-audit"
  | "release-readiness-check"
  | "cross-platform-compatibility-review"
  | "workspace-health-check"
  | "decision-record-generator";

export interface WorkspaceWorkflowCheck {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly evidenceHints: readonly string[];
}

export interface WorkspaceWorkflowPlan {
  readonly id: WorkspaceWorkflowId;
  readonly title: string;
  readonly description: string;
  readonly recommendedTools: readonly string[];
  readonly outputSchema: JsonSchema;
  readonly checks: readonly WorkspaceWorkflowCheck[];
}

export interface WorkspaceAgentPromptInput {
  readonly userPrompt: string;
  readonly workflowTitle: string;
  readonly workspaceDir: string;
}

const WORKSPACE_REPORT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: { type: "object" } },
    risks: { type: "array", items: { type: "string" } },
    nextSteps: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "findings", "risks", "nextSteps"],
};

const WORKSPACE_TOOLS = ["workspace_read", "git_status", "git_diff", "package_read"] as const;

export const WORKSPACE_WORKFLOW_PLANS: readonly WorkspaceWorkflowPlan[] = [
  {
    id: "code-change-plan-review",
    title: "Code Change Plan Review",
    description: "Review a proposed implementation plan before code is changed.",
    recommendedTools: WORKSPACE_TOOLS,
    outputSchema: WORKSPACE_REPORT_SCHEMA,
    checks: [
      {
        id: "architecture-impact",
        title: "Architecture impact",
        prompt: "Identify affected modules, boundaries, and coupling risks.",
        evidenceHints: ["src", "desktop/src", "docs/superpowers/specs"],
      },
      {
        id: "test-strategy",
        title: "Test strategy",
        prompt: "Map the proposed change to focused unit, integration, CLI, and desktop tests.",
        evidenceHints: ["tests", "desktop/src/**/*.test.tsx", "vitest.config.ts"],
      },
      {
        id: "implementation-risk",
        title: "Implementation risk",
        prompt: "List behavior, migration, compatibility, and rollback risks.",
        evidenceHints: ["git diff", "package.json", "desktop/package.json"],
      },
    ],
  },
  {
    id: "working-tree-review",
    title: "PR Or Working Tree Review",
    description: "Review current changes for correctness, regressions, and missing tests.",
    recommendedTools: WORKSPACE_TOOLS,
    outputSchema: WORKSPACE_REPORT_SCHEMA,
    checks: [
      {
        id: "correctness",
        title: "Correctness",
        prompt: "Inspect changed files for behavior regressions and broken assumptions.",
        evidenceHints: ["git diff --stat", "git diff --name-only"],
      },
      {
        id: "tests",
        title: "Tests",
        prompt: "Check whether changed behavior has focused tests and where gaps remain.",
        evidenceHints: ["tests", "desktop/src/**/*.test.tsx"],
      },
      {
        id: "integration-risk",
        title: "Integration risk",
        prompt: "Look for cross-module, CLI/desktop, packaging, or compatibility risks.",
        evidenceHints: ["package.json", "desktop/package.json", ".github/workflows"],
      },
    ],
  },
  {
    id: "bug-reproduction",
    title: "Bug Reproduction Workflow",
    description: "Turn a bug report into likely causes, reproduction steps, and tests.",
    recommendedTools: WORKSPACE_TOOLS,
    outputSchema: WORKSPACE_REPORT_SCHEMA,
    checks: [
      {
        id: "symptom-map",
        title: "Symptom map",
        prompt: "Map the reported symptom to likely code paths and user-visible states.",
        evidenceHints: ["rg symptom terms", "src", "desktop/src"],
      },
      {
        id: "minimal-reproduction",
        title: "Minimal reproduction",
        prompt: "Draft deterministic reproduction steps and required fixture data.",
        evidenceHints: ["tests", "fixtures", "scripts"],
      },
      {
        id: "test-proposal",
        title: "Test proposal",
        prompt: "Recommend the smallest tests that would fail before a fix and pass after.",
        evidenceHints: ["vitest", "desktop vitest", "CLI slash tests"],
      },
    ],
  },
  {
    id: "dependency-license-audit",
    title: "Dependency And License Audit",
    description:
      "Audit dependencies for license, maintenance, package size, and supply-chain risk.",
    recommendedTools: WORKSPACE_TOOLS,
    outputSchema: WORKSPACE_REPORT_SCHEMA,
    checks: [
      {
        id: "declared-licenses",
        title: "Declared licenses",
        prompt:
          "Check project license declarations and dependency license metadata available locally.",
        evidenceHints: ["package.json", "desktop/package.json", "LICENSE", "CLA.md"],
      },
      {
        id: "dependency-surface",
        title: "Dependency surface",
        prompt: "Summarize runtime and build dependency footprint and risky packages.",
        evidenceHints: ["package-lock.json", "desktop/package-lock.json"],
      },
      {
        id: "policy-fit",
        title: "Policy fit",
        prompt: "Assess whether the dependency set fits Jupiter's GPL/CLA licensing intent.",
        evidenceHints: ["LICENSE", "CLA.md", "README.md"],
      },
    ],
  },
  {
    id: "release-readiness-check",
    title: "Release Readiness Check",
    description:
      "Check versioning, changelog, release workflow, artifacts, packaging, and blockers.",
    recommendedTools: WORKSPACE_TOOLS,
    outputSchema: WORKSPACE_REPORT_SCHEMA,
    checks: [
      {
        id: "version-changelog",
        title: "Version and changelog",
        prompt: "Check version declarations and release notes readiness.",
        evidenceHints: ["package.json", "desktop/package.json", "CHANGELOG.md"],
      },
      {
        id: "release-workflow",
        title: "Release workflow",
        prompt: "Inspect CI/release workflow, target matrix, and artifact settings.",
        evidenceHints: [".github/workflows/release.yml", "desktop/src-tauri/tauri.conf.json"],
      },
      {
        id: "blockers",
        title: "Blockers",
        prompt: "Identify dirty worktree, failing tests, missing docs, or packaging blockers.",
        evidenceHints: ["git status", "tests", "dist"],
      },
    ],
  },
  {
    id: "cross-platform-compatibility-review",
    title: "Cross-Platform Compatibility Review",
    description: "Check macOS, Windows, Linux, ARM, glibc, Tauri, and permission compatibility.",
    recommendedTools: WORKSPACE_TOOLS,
    outputSchema: WORKSPACE_REPORT_SCHEMA,
    checks: [
      {
        id: "build-matrix",
        title: "Build matrix",
        prompt: "Check release target matrix, OS baselines, and architecture coverage.",
        evidenceHints: [".github/workflows/release.yml"],
      },
      {
        id: "desktop-runtime",
        title: "Desktop runtime",
        prompt: "Inspect Tauri configuration, bundled binaries, permissions, and resources.",
        evidenceHints: ["desktop/src-tauri/tauri.conf.json", "desktop/scripts"],
      },
      {
        id: "linux-compatibility",
        title: "Linux compatibility",
        prompt: "Check Linux dependency and glibc compatibility risks.",
        evidenceHints: ["release.yml", "install-linux.sh", "desktop/SIGNING.md"],
      },
    ],
  },
  {
    id: "workspace-health-check",
    title: "Workspace Health Check",
    description: "Inspect project hygiene across docs, scripts, tests, CI, license, and releases.",
    recommendedTools: WORKSPACE_TOOLS,
    outputSchema: WORKSPACE_REPORT_SCHEMA,
    checks: [
      {
        id: "documentation",
        title: "Documentation",
        prompt: "Check README, contributing, security, changelog, and project docs.",
        evidenceHints: ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"],
      },
      {
        id: "automation",
        title: "Automation",
        prompt: "Check scripts, tests, CI, release, and typecheck coverage.",
        evidenceHints: ["package.json", ".github/workflows", "vitest.config.ts"],
      },
      {
        id: "governance",
        title: "Governance",
        prompt: "Check license, CLA, code of conduct, and dependency policy signals.",
        evidenceHints: ["LICENSE", "CLA.md", "CODE_OF_CONDUCT.md"],
      },
    ],
  },
  {
    id: "decision-record-generator",
    title: "Decision Record Generator",
    description: "Generate an ADR from a conversation, diff, or implementation decision.",
    recommendedTools: WORKSPACE_TOOLS,
    outputSchema: WORKSPACE_REPORT_SCHEMA,
    checks: [
      {
        id: "context",
        title: "Context",
        prompt: "Extract the decision context, forces, constraints, and current state.",
        evidenceHints: ["user prompt", "git diff", "docs/superpowers/specs"],
      },
      {
        id: "decision",
        title: "Decision",
        prompt: "State the chosen decision and rejected alternatives clearly.",
        evidenceHints: ["conversation summary", "changed files"],
      },
      {
        id: "consequences",
        title: "Consequences",
        prompt: "List consequences, risks, follow-ups, and rollback notes.",
        evidenceHints: ["tests", "release notes", "future work"],
      },
    ],
  },
];

const WORKSPACE_WORKFLOW_BY_ID = new Map(WORKSPACE_WORKFLOW_PLANS.map((plan) => [plan.id, plan]));

export function isWorkspaceWorkflow(id: string): id is WorkspaceWorkflowId {
  return WORKSPACE_WORKFLOW_BY_ID.has(id as WorkspaceWorkflowId);
}

export function getWorkspaceWorkflowPlan(id: string): WorkspaceWorkflowPlan | null {
  return WORKSPACE_WORKFLOW_BY_ID.get(id as WorkspaceWorkflowId) ?? null;
}

export function buildWorkspaceAgentPrompt(
  check: WorkspaceWorkflowCheck,
  input: WorkspaceAgentPromptInput,
): string {
  const hints = check.evidenceHints.map((hint) => `- ${hint}`).join("\n");
  return [
    `Workflow: ${input.workflowTitle}`,
    `Workspace: ${input.workspaceDir}`,
    `Check: ${check.title}`,
    "",
    `User request: ${input.userPrompt}`,
    "",
    check.prompt,
    "",
    "Use workspace evidence and cite file references when possible. Keep findings actionable and include risks, missing tests, or unresolved assumptions.",
    "",
    "Evidence hints:",
    hints,
  ].join("\n");
}
