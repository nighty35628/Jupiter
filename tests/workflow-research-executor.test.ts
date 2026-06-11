import { describe, expect, it, vi } from "vitest";
import { createResearchWorkflowAgentExecutor } from "../src/workflows/research-executor.js";
import { getResearchWorkflowPlan } from "../src/workflows/research.js";
import type { WorkflowRun } from "../src/workflows/types.js";

const run: WorkflowRun = {
  id: "wf-1",
  workflowId: "open-source-project-selection",
  workflowVersion: 1,
  title: "Open Source Project Selection",
  status: "running",
  phase: "license-maintenance",
  input: { prompt: "compare Playwright and Puppeteer" },
  startedAt: "2026-06-11T00:00:00.000Z",
  tokenUsage: { prompt: 0, completion: 0, total: 0 },
  agents: [],
  logs: [],
  sources: [],
};

describe("research workflow executor", () => {
  it("uses configured web and library search hooks and returns cited sources", async () => {
    const searchWeb = vi.fn(async () => [
      {
        title: "Playwright",
        url: "https://playwright.dev",
        snippet: "Official Playwright docs.",
      },
    ]);
    const searchLibrary = vi.fn(() => ({
      query: "compare Playwright and Puppeteer license-maintenance",
      results: [
        {
          sourceId: "lib-1",
          kind: "file" as const,
          title: "prior-notes.md",
          score: 12,
          text: "Prior notes mention browser automation tradeoffs.",
        },
      ],
    }));
    const executor = createResearchWorkflowAgentExecutor({
      plan: getResearchWorkflowPlan("open-source-project-selection")!,
      userPrompt: "compare Playwright and Puppeteer",
      workspaceDir: "/repo",
      searchWeb,
      searchLibrary,
    });

    const result = await executor({
      run,
      label: "license-maintenance",
      phase: "license-maintenance",
      input: run.input,
    });

    expect(searchWeb).toHaveBeenCalledWith(
      expect.stringContaining("compare Playwright and Puppeteer"),
      expect.objectContaining({ topK: 5 }),
    );
    expect(searchLibrary).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({
        query: expect.stringContaining("compare Playwright and Puppeteer"),
      }),
    );
    expect(result.summary).toContain("Playwright");
    expect(result.summary).toContain("prior-notes.md");
    expect(result.sources).toEqual(
      expect.arrayContaining([
        { title: "Playwright", url: "https://playwright.dev" },
        { title: "prior-notes.md", path: "library:lib-1" },
      ]),
    );
    expect(result.tokenUsage.total).toBeGreaterThan(0);
  });

  it("reports caveats when web search fails", async () => {
    const executor = createResearchWorkflowAgentExecutor({
      plan: getResearchWorkflowPlan("deep-fact-check")!,
      userPrompt: "verify this",
      searchWeb: async () => {
        throw new Error("rate limited");
      },
    });

    const result = await executor({
      run: { ...run, workflowId: "deep-fact-check", title: "Deep Fact Check" },
      label: "official-sources",
      phase: "official-sources",
      input: { prompt: "verify this" },
    });

    expect(result.summary).toContain("caveat");
    expect(result.summary).toContain("rate limited");
    expect(result.sources).toEqual([]);
  });
});
