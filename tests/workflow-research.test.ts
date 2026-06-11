import { describe, expect, it } from "vitest";
import { BUILT_IN_WORKFLOWS } from "../src/workflows/catalog.js";
import {
  buildResearchAgentPrompt,
  getResearchWorkflowPlan,
  isResearchWorkflow,
} from "../src/workflows/research.js";

describe("research workflow definitions", () => {
  it("defines Batch 1 research workflows with focused checks", () => {
    for (const id of [
      "deep-fact-check",
      "paper-direction-validation",
      "open-source-project-selection",
      "technical-route-feasibility-review",
    ]) {
      const plan = getResearchWorkflowPlan(id);

      expect(plan).not.toBeNull();
      expect(plan?.checks.length).toBeGreaterThanOrEqual(3);
      expect(plan?.outputSchema.required).toEqual(
        expect.arrayContaining(["summary", "keyFacts", "caveats", "verdict"]),
      );
      expect(plan?.recommendedTools).toEqual(
        expect.arrayContaining(["web_search", "web_fetch", "library_search", "library_read"]),
      );
    }
  });

  it("does not classify deferred or engineering-only workflows as Batch 1 research workflows", () => {
    expect(isResearchWorkflow("release-readiness-check")).toBe(false);
    expect(isResearchWorkflow("decision-record-generator")).toBe(false);
  });

  it("builds self-contained agent prompts with citation and caveat requirements", () => {
    const plan = getResearchWorkflowPlan("open-source-project-selection");
    const prompt = buildResearchAgentPrompt(plan!.checks[0]!, {
      userPrompt: "compare Playwright and Puppeteer for Jupiter",
      workflowTitle: plan!.title,
    });

    expect(prompt).toContain("compare Playwright and Puppeteer for Jupiter");
    expect(prompt).toContain("web_search");
    expect(prompt).toContain("library_search");
    expect(prompt).toContain("source URL");
    expect(prompt).toContain("caveats");
  });

  it("uses research checks as catalog phases for Batch 1 workflows", () => {
    const template = BUILT_IN_WORKFLOWS.find((workflow) => workflow.id === "deep-fact-check");
    const plan = getResearchWorkflowPlan("deep-fact-check");

    expect(template?.phases.map((phase) => phase.id)).toEqual(
      plan?.checks.map((check) => check.id),
    );
  });
});
