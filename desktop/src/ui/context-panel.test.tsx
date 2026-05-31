// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, UsageStats } from "../App";
import type { FilePreview } from "../file-preview";
import { setLang } from "../i18n";
import { ContextPanel } from "./context-panel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));

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

function renderPanel(overrides: Record<string, unknown> = {}) {
  const Panel = ContextPanel as never as ComponentType<Record<string, unknown>>;
  return render(
    <Panel
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
      {...overrides}
    />,
  );
}

describe("ContextPanel files", () => {
  beforeEach(() => {
    setLang("en");
    vi.mocked(invoke).mockReset();
    vi.mocked(openPath).mockReset();
    vi.mocked(revealItemInDir).mockReset();
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

  it("previews a tracked file when its row is clicked", () => {
    const onPreviewFile = vi.fn();
    renderPanel({ onPreviewFile });

    fireEvent.click(screen.getByText("new-file.ts"));

    expect(onPreviewFile).toHaveBeenCalledWith({ path: "src/new-file.ts" });
    expect(openPath).not.toHaveBeenCalled();
  });

  it("renders the selected file preview in the files tab", () => {
    renderPanel({
      selectedFilePreview: {
        path: "src/new-file.ts",
        absPath: "/repo/src/new-file.ts",
        name: "new-file.ts",
        kind: "text",
        bytes: 18,
        modifiedMs: null,
        text: "export const x = 1;",
        truncated: false,
      },
      filePreviewLoading: false,
      filePreviewError: null,
    });

    expect(screen.getByText("Preview")).toBeTruthy();
    expect(screen.getAllByText("src/new-file.ts").length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain("export const x = 1;");
  });

  it("renders extracted document text in the preview pane", () => {
    renderPanel({
      selectedFilePreview: {
        path: "docs/spec.docx",
        absPath: "/repo/docs/spec.docx",
        name: "spec.docx",
        ext: "docx",
        kind: "document",
        bytes: 4096,
        modifiedMs: null,
        text: "Project brief",
        truncated: false,
      },
    });

    expect(screen.getByText("spec.docx")).toBeTruthy();
    expect(document.body.textContent).toContain("Project brief");
  });

  it("reveals a tracked file from its actions menu", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "File actions: src/new-file.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Reveal in folder" }));

    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/repo/src/new-file.ts"));
  });

  it("opens the tracked file actions menu from the row context menu", () => {
    renderPanel();

    fireEvent.contextMenu(screen.getByText("new-file.ts"));

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open in default app" })).toBeTruthy();
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

  it("shows all context information in the info view and opens the child transcript", () => {
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

    expect(screen.getByText("Subagents")).toBeTruthy();
    expect(screen.getByText("(explorer)")).toBeTruthy();
    expect(screen.getByText("Explore the renderer")).toBeTruthy();
    expect(screen.queryByText("Rules")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open subagent: Explore the renderer" }));

    expect(onOpenSubagent).toHaveBeenCalledWith("subagent-sub-1-20260531120000");
  });

  it("lets the surrounding shell control whether a selected file shows preview or info", () => {
    const preview: FilePreview = {
      path: "src/new-file.ts",
      absPath: "/repo/src/new-file.ts",
      name: "new-file.ts",
      kind: "text",
      bytes: 18,
      modifiedMs: null,
      text: "export const x = 1;",
      truncated: false,
    };
    const view = renderPanel({
      mode: "preview",
      selectedFilePreview: preview,
      filePreviewLoading: false,
      filePreviewError: null,
    });

    expect(document.querySelector(".ctx")?.getAttribute("data-mode")).toBe("preview");
    expect(document.querySelector(".ctx-file-preview--full")).toBeTruthy();
    expect(screen.queryByText("Files in context")).toBeNull();

    view.rerender(
      <ContextPanel
        settings={settings}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        subagents={[]}
        sessionFiles={[{ path: "src/new-file.ts", status: "m" }]}
        memory={[]}
        memoryDetail={null}
        selectedFilePreview={preview}
        filePreviewLoading={false}
        filePreviewError={null}
        mode="info"
        onOpenSubagent={() => {}}
        onReadMemory={() => {}}
      />,
    );

    expect(document.querySelector(".ctx")?.getAttribute("data-mode")).toBe("info");
    expect(screen.getByText("Files in context")).toBeTruthy();
  });

  it("requests preview mode when a file preview target appears", () => {
    const onModeChange = vi.fn();
    renderPanel({
      selectedFilePreview: {
        path: "src/new-file.ts",
        absPath: "/repo/src/new-file.ts",
        name: "new-file.ts",
        kind: "text",
        bytes: 18,
        modifiedMs: null,
        text: "export const x = 1;",
        truncated: false,
      },
      filePreviewLoading: false,
      filePreviewError: null,
      onModeChange,
    });

    expect(onModeChange).toHaveBeenCalledWith("preview");
  });

  it("does not render shell controls inside the context panel", () => {
    renderPanel();

    expect(screen.queryByRole("button", { name: "Toggle bottom bar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Toggle right sidebar" })).toBeNull();
  });
});
