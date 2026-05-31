// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, UsageStats } from "../App";
import { setLang } from "../i18n";
import { ContextPanel } from "./context-panel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));

const usage: UsageStats = {
  totalCostUsd: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  lastCallCacheHit: null,
  lastCallCacheMiss: null,
  reservedTokens: 0,
  liveLogTokens: 0,
};

const settings: Settings = {
  reasoningEffort: "high",
  editMode: "review",
  budgetUsd: null,
  workspaceDir: "/repo",
  recentWorkspaces: [],
  model: "deepseek-reasoner",
  version: "0.0.0",
};

function renderPanel() {
  return render(
    <ContextPanel
      settings={settings}
      usage={usage}
      mcpSpecs={[]}
      mcpBridged={false}
      subagents={[]}
      sessionFiles={[{ path: "src/new-file.ts", status: "m" }]}
      memory={[]}
      memoryDetail={null}
      onOpenSubagent={() => {}}
      onReadMemory={() => {}}
    />,
  );
}

describe("ContextPanel files", () => {
  beforeEach(() => {
    setLang("en");
    vi.mocked(invoke).mockReset();
    vi.mocked(openPath).mockReset();
  });
  afterEach(cleanup);

  it("keeps each tracked file's full path visible", () => {
    const { container } = renderPanel();

    const fileRow = container.querySelector('[data-kind="file"]');

    expect(fileRow?.textContent).toContain("src/new-file.ts");
    expect(fileRow?.getAttribute("title")).toBe("src/new-file.ts");
  });

  it("opens a tracked file from the file row action", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Open file: src/new-file.ts" }));

    await waitFor(() => expect(openPath).toHaveBeenCalledWith("/repo/src/new-file.ts"));
  });

  it("renders live log tokens even before final usage arrives", () => {
    render(
      <ContextPanel
        settings={settings}
        usage={{ ...usage, reservedTokens: 50, liveLogTokens: 100 }}
        mcpSpecs={[]}
        mcpBridged={false}
        subagents={[]}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        onOpenSubagent={() => {}}
        onReadMemory={() => {}}
      />,
    );

    expect(screen.getByText("150 / 1,000,000")).toBeTruthy();
    expect(screen.getByText("100")).toBeTruthy();
  });

  it("shows subagents beside MCP tools and opens the child transcript", () => {
    const onOpenSubagent = vi.fn();
    render(
      <ContextPanel
        settings={settings}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        subagents={[
          {
            runId: "sub-1",
            sessionName: "subagent-sub-1-20260531120000",
            parentSession: "desktop-20260531115900-1",
            task: "Explore the renderer",
            skillName: "explorer",
            status: "running",
            iter: 2,
            elapsedMs: 12_300,
            outputChars: 40,
            reasoningChars: 8,
            toolReadChars: 1024,
          },
        ]}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        onOpenSubagent={onOpenSubagent}
        onReadMemory={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("Tools"));

    expect(screen.getByText("Subagents")).toBeTruthy();
    expect(screen.getByText("(explorer)")).toBeTruthy();
    expect(screen.getByText("Explore the renderer")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open subagent: Explore the renderer" }));

    expect(onOpenSubagent).toHaveBeenCalledWith("subagent-sub-1-20260531120000");
  });
});
