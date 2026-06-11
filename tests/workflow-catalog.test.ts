import { describe, expect, it } from "vitest";
import { BUILT_IN_WORKFLOWS, getWorkflowTemplate } from "../src/workflows/catalog.js";

const EXPECTED_IDS = [
  "deep-fact-check",
  "paper-direction-validation",
  "open-source-project-selection",
  "technical-route-feasibility-review",
  "code-change-plan-review",
  "working-tree-review",
  "dependency-license-audit",
  "release-readiness-check",
  "cross-platform-compatibility-review",
  "bug-reproduction",
  "workspace-health-check",
  "decision-record-generator",
] as const;

describe("built-in workflow catalog", () => {
  it("ships the first-version built-in workflow set only", () => {
    expect(BUILT_IN_WORKFLOWS.map((workflow) => workflow.id)).toEqual(EXPECTED_IDS);
  });

  it("uses unique ids and versioned built-in templates", () => {
    const ids = new Set(BUILT_IN_WORKFLOWS.map((workflow) => workflow.id));

    expect(ids.size).toBe(BUILT_IN_WORKFLOWS.length);
    for (const workflow of BUILT_IN_WORKFLOWS) {
      expect(workflow.version).toBe(1);
      expect(workflow.builtIn).toBe(true);
      expect(workflow.title.trim()).not.toBe("");
      expect(workflow.description.trim()).not.toBe("");
      expect(workflow.phases.length).toBeGreaterThan(0);
      expect(workflow.inputSchema.type).toBe("object");
      expect(workflow.outputSchema.type).toBe("object");
    }
  });

  it("declares permissions and trigger hints for every template", () => {
    for (const workflow of BUILT_IN_WORKFLOWS) {
      expect(typeof workflow.permissions.allowNetwork).toBe("boolean");
      expect(typeof workflow.permissions.allowWorkspaceRead).toBe("boolean");
      expect(typeof workflow.permissions.allowLibraryRead).toBe("boolean");
      expect(typeof workflow.permissions.allowLibraryWrite).toBe("boolean");
      expect(typeof workflow.permissions.allowFileWrite).toBe("boolean");
      expect(typeof workflow.permissions.requiresApprovalBeforeWrite).toBe("boolean");
      expect(workflow.suggestedTriggers.length).toBeGreaterThan(0);
      for (const trigger of workflow.suggestedTriggers) {
        expect(trigger.phrase.trim()).not.toBe("");
        expect(trigger.confidence).toBeGreaterThan(0);
        expect(trigger.confidence).toBeLessThanOrEqual(1);
      }
    }
  });

  it("looks up templates by id", () => {
    expect(getWorkflowTemplate("release-readiness-check")?.title).toBe("Release Readiness Check");
    expect(getWorkflowTemplate("custom-workflow")).toBeNull();
  });
});
