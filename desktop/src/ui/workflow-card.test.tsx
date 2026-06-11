// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowRunCard } from "./cards";

const run = {
  id: "wf-1",
  workflowId: "release-readiness-check",
  workflowVersion: 1,
  title: "Release Readiness Check",
  status: "running",
  phase: "parallel-checks",
  input: { prompt: "check release" },
  startedAt: "2026-06-11T00:00:00.000Z",
  tokenUsage: { prompt: 120, completion: 80, total: 200 },
  agents: [
    {
      id: "agent-1",
      label: "Scope",
      status: "completed",
      phase: "scope",
      summary: "Inputs checked",
      tokenUsage: { prompt: 40, completion: 20, total: 60 },
    },
    {
      id: "agent-2",
      label: "Release files",
      status: "running",
      phase: "parallel-checks",
      tokenUsage: { prompt: 80, completion: 60, total: 140 },
    },
  ],
  logs: [{ ts: "2026-06-11T00:00:01.000Z", message: "checking release files" }],
  sources: [{ title: "release.yml", path: ".github/workflows/release.yml" }],
  result: { summary: "Ready with caveats" },
} as const;

afterEach(() => cleanup());

describe("WorkflowRunCard", () => {
  it("renders live workflow status and metrics", () => {
    render(<WorkflowRunCard run={run} />);

    expect(screen.getByText("Release Readiness Check")).toBeTruthy();
    expect(screen.getByText("parallel-checks")).toBeTruthy();
    expect(screen.getByText("200 t")).toBeTruthy();
    expect(screen.getByText("1 running")).toBeTruthy();
    expect(screen.getByText("1 done")).toBeTruthy();
    expect(screen.getByText("1 source")).toBeTruthy();
  });

  it("shows expanded details and calls cancel", () => {
    const onCancel = vi.fn();
    render(<WorkflowRunCard run={run} onCancel={onCancel} defaultOpen />);

    expect(screen.getByText("checking release files")).toBeTruthy();
    expect(screen.getByText("Inputs checked")).toBeTruthy();
    expect(screen.getByText("release.yml")).toBeTruthy();
    expect(screen.getByText(/Ready with caveats/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel workflow" }));

    expect(onCancel).toHaveBeenCalledWith("wf-1");
  });

  it("shows completed result actions", () => {
    const onSaveToLibrary = vi.fn();
    const onInsertResult = vi.fn();
    const onExportMarkdown = vi.fn();
    const onCopyResult = vi.fn();
    render(
      <WorkflowRunCard
        run={{ ...run, status: "completed", phase: "completed" }}
        defaultOpen
        onSaveToLibrary={onSaveToLibrary}
        onInsertResult={onInsertResult}
        onExportMarkdown={onExportMarkdown}
        onCopyResult={onCopyResult}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save to library" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert result" }));
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy result" }));

    expect(onSaveToLibrary).toHaveBeenCalledWith("wf-1");
    expect(onInsertResult).toHaveBeenCalledWith("wf-1");
    expect(onExportMarkdown).toHaveBeenCalledWith("wf-1");
    expect(onCopyResult).toHaveBeenCalledWith("wf-1");
  });
});
