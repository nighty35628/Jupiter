import type { JsonSchema } from "./types.js";

export type ResearchWorkflowId =
  | "deep-fact-check"
  | "paper-direction-validation"
  | "open-source-project-selection"
  | "technical-route-feasibility-review";

export interface ResearchWorkflowCheck {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly suggestedQueries: readonly string[];
}

export interface ResearchWorkflowPlan {
  readonly id: ResearchWorkflowId;
  readonly title: string;
  readonly description: string;
  readonly recommendedTools: readonly string[];
  readonly outputSchema: JsonSchema;
  readonly checks: readonly ResearchWorkflowCheck[];
}

export interface ResearchAgentPromptInput {
  readonly userPrompt: string;
  readonly workflowTitle: string;
}

const FACTS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", description: "One-paragraph conclusion." },
    keyFacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          fact: { type: "string" },
          source: { type: "string", description: "source URL or workspace library source id" },
        },
        required: ["fact", "source"],
      },
    },
    caveats: { type: "array", items: { type: "string" } },
    verdict: { type: "string", enum: ["ok", "ok-with-caveats", "problem"] },
  },
  required: ["summary", "keyFacts", "caveats", "verdict"],
};

const RECOMMENDED_TOOLS = ["web_search", "web_fetch", "library_search", "library_read"] as const;

export const RESEARCH_WORKFLOW_PLANS: readonly ResearchWorkflowPlan[] = [
  {
    id: "deep-fact-check",
    title: "Deep Fact Check",
    description: "Verify a claim or direction against current web and workspace library sources.",
    recommendedTools: RECOMMENDED_TOOLS,
    outputSchema: FACTS_SCHEMA,
    checks: [
      {
        id: "official-sources",
        title: "Official sources",
        prompt: "Find official or primary sources that directly support or refute the claim.",
        suggestedQueries: ["official documentation", "project announcement", "dataset paper"],
      },
      {
        id: "independent-sources",
        title: "Independent sources",
        prompt: "Find independent sources, reports, papers, or repositories that confirm details.",
        suggestedQueries: ["independent verification", "paper report", "github repository"],
      },
      {
        id: "contradictions",
        title: "Contradictions and caveats",
        prompt: "Look for stale, conflicting, missing, or restricted information and list caveats.",
        suggestedQueries: ["known issue", "license limitation", "download unavailable"],
      },
    ],
  },
  {
    id: "paper-direction-validation",
    title: "Paper Direction Validation",
    description:
      "Validate dataset availability, baselines, novelty gaps, evaluation protocols, and publication risk.",
    recommendedTools: RECOMMENDED_TOOLS,
    outputSchema: FACTS_SCHEMA,
    checks: [
      {
        id: "datasets-baselines",
        title: "Datasets and baselines",
        prompt:
          "Verify whether required datasets, official code, pretrained models, and baseline protocols are public and usable.",
        suggestedQueries: ["dataset download baseline code", "official repository benchmark"],
      },
      {
        id: "literature-gap",
        title: "Literature gap",
        prompt:
          "Search recent papers for the closest work and assess whether the proposed novelty remains open.",
        suggestedQueries: ["2024 2025 2026 paper novelty gap", "survey latest method"],
      },
      {
        id: "evaluation-protocol",
        title: "Evaluation protocol",
        prompt:
          "Verify metrics, train/test split, evaluation scripts, and whether the protocol is accepted by the target community.",
        suggestedQueries: [
          "evaluation protocol metrics train test split",
          "challenge report benchmark",
        ],
      },
      {
        id: "publication-risk",
        title: "Publication risk",
        prompt:
          "Summarize feasibility, novelty, reproducibility, and reviewer-risk caveats for the direction.",
        suggestedQueries: ["limitations reproducibility open problems", "negative results"],
      },
    ],
  },
  {
    id: "open-source-project-selection",
    title: "Open Source Project Selection",
    description: "Compare candidate repositories or packages for integration.",
    recommendedTools: RECOMMENDED_TOOLS,
    outputSchema: FACTS_SCHEMA,
    checks: [
      {
        id: "license-maintenance",
        title: "License and maintenance",
        prompt: "Check license, release activity, recent commits, issues, and maintainer signals.",
        suggestedQueries: ["github license releases issues", "npm package maintenance"],
      },
      {
        id: "integration-fit",
        title: "Integration fit",
        prompt:
          "Check API shape, platform support, dependency weight, and build/runtime constraints.",
        suggestedQueries: ["documentation API platform support", "bundle size dependencies"],
      },
      {
        id: "alternatives",
        title: "Alternatives",
        prompt: "Find credible alternatives and compare tradeoffs against the requested use case.",
        suggestedQueries: ["alternatives comparison", "best library for use case"],
      },
    ],
  },
  {
    id: "technical-route-feasibility-review",
    title: "Technical Route Feasibility Review",
    description: "Evaluate whether a technical route is practical for Jupiter.",
    recommendedTools: RECOMMENDED_TOOLS,
    outputSchema: FACTS_SCHEMA,
    checks: [
      {
        id: "compatibility",
        title: "Compatibility",
        prompt: "Check OS, architecture, dependency, runtime, and packaging compatibility.",
        suggestedQueries: ["compatibility requirements", "installation requirements"],
      },
      {
        id: "cost-risk",
        title: "Cost and risk",
        prompt: "Estimate implementation cost, package size, operational risk, and failure modes.",
        suggestedQueries: ["package size", "known issues", "security advisory"],
      },
      {
        id: "implementation-path",
        title: "Implementation path",
        prompt: "Find the simplest implementation path, rollout steps, and rollback strategy.",
        suggestedQueries: ["official guide integration", "migration guide", "rollback strategy"],
      },
    ],
  },
];

const RESEARCH_WORKFLOW_BY_ID = new Map(RESEARCH_WORKFLOW_PLANS.map((plan) => [plan.id, plan]));

export function isResearchWorkflow(id: string): id is ResearchWorkflowId {
  return RESEARCH_WORKFLOW_BY_ID.has(id as ResearchWorkflowId);
}

export function getResearchWorkflowPlan(id: string): ResearchWorkflowPlan | null {
  return RESEARCH_WORKFLOW_BY_ID.get(id as ResearchWorkflowId) ?? null;
}

export function buildResearchAgentPrompt(
  check: ResearchWorkflowCheck,
  input: ResearchAgentPromptInput,
): string {
  const queries = check.suggestedQueries.map((query) => `- ${query}`).join("\n");
  return [
    `Workflow: ${input.workflowTitle}`,
    `Check: ${check.title}`,
    "",
    `User request: ${input.userPrompt}`,
    "",
    check.prompt,
    "",
    "Use web_search first when current or external facts matter. Use web_fetch for pages whose snippets are insufficient. Use library_search and library_read when workspace library sources may contain relevant saved material.",
    "",
    "Suggested search angles:",
    queries,
    "",
    "Return concise findings with source URL or workspace library source id for every key fact. Put uncertainty, missing access, stale pages, or conflicting evidence in caveats.",
  ].join("\n");
}
