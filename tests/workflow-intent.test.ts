import { describe, expect, it, vi } from "vitest";
import { buildWorkflowIntentPrompt, classifyWorkflowIntent } from "../src/workflows/intent.js";

describe("workflow intent classifier", () => {
  it("does nothing when workflow suggestions are off", async () => {
    const classifyWithModel = vi.fn();

    const intent = await classifyWorkflowIntent({
      text: "run a release readiness check",
      mode: "off",
      classifyWithModel,
    });

    expect(intent).toEqual({
      shouldSuggest: false,
      shouldStart: false,
      confidence: 0,
      reason: "workflow suggestions disabled",
      estimatedCost: "low",
    });
    expect(classifyWithModel).not.toHaveBeenCalled();
  });

  it("uses a model result to suggest a matching built-in workflow", async () => {
    const intent = await classifyWorkflowIntent({
      text: "check whether this is ready to release",
      mode: "suggest",
      classifyWithModel: async () =>
        JSON.stringify({
          shouldSuggest: true,
          shouldStart: true,
          workflowId: "release-readiness-check",
          confidence: 0.91,
          reason: "release readiness task",
          estimatedCost: "medium",
        }),
    });

    expect(intent).toMatchObject({
      shouldSuggest: true,
      shouldStart: false,
      workflowId: "release-readiness-check",
      confidence: 0.91,
      estimatedCost: "medium",
    });
  });

  it("allows direct start only in explicit mode", async () => {
    const intent = await classifyWorkflowIntent({
      text: "use workflow to audit dependencies",
      mode: "explicit",
      classifyWithModel: async () =>
        JSON.stringify({
          shouldSuggest: true,
          shouldStart: true,
          workflowId: "dependency-license-audit",
          confidence: 0.86,
          reason: "explicit workflow request",
          estimatedCost: "high",
        }),
    });

    expect(intent).toMatchObject({
      shouldSuggest: false,
      shouldStart: true,
      workflowId: "dependency-license-audit",
      confidence: 0.86,
    });
  });

  it("rejects unknown workflow ids from the model", async () => {
    const intent = await classifyWorkflowIntent({
      text: "run a custom workflow",
      mode: "suggest",
      classifyWithModel: async () =>
        JSON.stringify({
          shouldSuggest: true,
          shouldStart: true,
          workflowId: "custom-workflow",
          confidence: 0.9,
          reason: "not built in",
          estimatedCost: "low",
        }),
    });

    expect(intent.shouldSuggest).toBe(false);
    expect(intent.shouldStart).toBe(false);
    expect(intent.workflowId).toBeUndefined();
  });

  it("builds a bounded model prompt from the shared catalog", () => {
    const prompt = buildWorkflowIntentPrompt("review this PR");

    expect(prompt).toContain("Return JSON only");
    expect(prompt).toContain("release-readiness-check");
    expect(prompt).toContain("decision-record-generator");
    expect(prompt.length).toBeLessThan(10_000);
  });
});
