// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { invoke } from "@tauri-apps/api/core";
import * as eventApi from "@tauri-apps/api/event";
import * as webviewApi from "@tauri-apps/api/webview";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, UsageStats } from "../App";
import type { FilePreview } from "../file-preview";
import { setLang } from "../i18n";
import { ContextInfoPopover, ContextPanel } from "./context-panel";

const xtermMockState = vi.hoisted(() => {
  const terminals: Array<{
    options?: Record<string, unknown>;
    writes: string[];
    disposed: boolean;
    dataHandlers: Array<(data: string) => void>;
    open: (node: HTMLElement) => void;
    loadAddon: (addon: unknown) => void;
    onData: (handler: (data: string) => void) => { dispose: () => void };
    write: (data: string) => void;
    focus: () => void;
    dispose: () => void;
  }> = [];
  const fitAddons: Array<{ fitCalls: number; fit: () => void }> = [];
  return { terminals, fitAddons };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options?: Record<string, unknown>;
    writes: string[] = [];
    disposed = false;
    dataHandlers: Array<(data: string) => void> = [];
    open(_node: HTMLElement) {}
    loadAddon(_addon: unknown) {}
    onData(handler: (data: string) => void) {
      this.dataHandlers.push(handler);
      return {
        dispose: () => {
          this.dataHandlers = this.dataHandlers.filter((item) => item !== handler);
        },
      };
    }
    write(data: string) {
      this.writes.push(data);
    }
    focus() {}
    dispose() {
      this.disposed = true;
    }
    constructor(options?: Record<string, unknown>) {
      this.options = options;
      xtermMockState.terminals.push(this);
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fitCalls = 0;
    fit() {
      this.fitCalls += 1;
    }
    constructor() {
      xtermMockState.fitAddons.push(this);
    }
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(() => Promise.resolve()),
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
  contextDiagnostics: null,
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

const Panel = ContextPanel as never as ComponentType<Record<string, unknown>>;
const eventMockState = eventApi as unknown as {
  emitMockEvent: (event: string, payload: unknown) => void;
  resetMockEvents: () => void;
};
const webviewMockState = webviewApi as unknown as {
  webviewInstances: Array<Record<string, any>>;
  webviewCreationEvents: Array<{
    event: "tauri://created" | "tauri://error";
    payload?: unknown;
  }>;
};

function renderPanel(overrides: Record<string, unknown> = {}) {
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
      mode="files"
      {...overrides}
    />,
  );
}

describe("ContextPanel files", () => {
  beforeEach(() => {
    setLang("en");
    document.documentElement.removeAttribute("style");
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null as never);
    vi.mocked(openPath).mockReset();
    vi.mocked(openUrl).mockClear();
    vi.mocked(openUrl).mockResolvedValue(undefined);
    vi.mocked(revealItemInDir).mockReset();
    eventMockState.resetMockEvents();
    xtermMockState.terminals.length = 0;
    xtermMockState.fitAddons.length = 0;
    webviewMockState.webviewInstances.length = 0;
    webviewMockState.webviewCreationEvents.length = 0;
  });
  afterEach(cleanup);

  it("shows the module home panel by default without shell controls", () => {
    renderPanel({ mode: undefined });

    expect(document.querySelector(".ctx")?.getAttribute("data-mode")).toBe("home");
    expect(screen.getByText("Files")).toBeTruthy();
    expect(screen.getAllByText("Library").length).toBeGreaterThan(0);
    expect(screen.getByText("Side Chat")).toBeTruthy();
    expect(screen.getByText("Browser")).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Toggle bottom bar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Toggle right sidebar" })).toBeNull();
  });

  it("does not annotate sidebar home cards with keyboard shortcuts", () => {
    renderPanel({ mode: undefined });

    expect(document.querySelector(".ctx-home-card kbd")).toBeNull();
    expect(document.body.textContent).not.toContain("⌘P");
    expect(document.body.textContent).not.toContain("⌘T");
    expect(document.body.textContent).not.toContain("^⇧G");
    expect(document.body.textContent).not.toContain("^`");
  });

  it("lets the tab add button switch to another panel", () => {
    const onModeChange = vi.fn();
    renderPanel({ mode: "files", onModeChange });

    fireEvent.click(screen.getByRole("button", { name: "Add panel" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Browser" }));

    expect(onModeChange).toHaveBeenCalledWith("browser");
  });

  it("shows library as a selectable workspace module", () => {
    const onModeChange = vi.fn();
    renderPanel({ mode: "files", onModeChange });

    fireEvent.click(screen.getByRole("button", { name: "Add panel" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Library" }));

    expect(onModeChange).toHaveBeenCalledWith("library");
  });

  it("renders the library module summary", () => {
    renderPanel({
      mode: "library",
      sessionFiles: [
        { path: "src/new-file.ts", status: "m" },
        { path: "docs/notes.md", status: "c" },
      ],
      memory: [
        {
          kind: "project_file",
          path: "/repo/.jupiter/memory.md",
          name: "memory.md",
          description: "Project note",
          scope: "project",
        },
      ],
    });

    expect(screen.getAllByText("Library").length).toBeGreaterThan(0);
    expect(screen.getByText("Saved sources")).toBeTruthy();
    expect(screen.getByText("0 items")).toBeTruthy();
    expect(screen.queryByText("Workspace files")).toBeNull();
    expect(screen.queryByText("Saved notes")).toBeNull();
  });

  it("searches sources from the library module", () => {
    const onSourceSearch = vi.fn();
    renderPanel({ mode: "library", onSourceSearch });

    fireEvent.change(screen.getByPlaceholderText("Search web or saved sources…"), {
      target: { value: "notebook lm" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(onSourceSearch).toHaveBeenCalledWith("notebook lm", expect.any(Number));
  });

  it("keeps library stats focused on saved sources", () => {
    renderPanel({ mode: "library" });

    expect(screen.getByText("Saved sources")).toBeTruthy();
    expect(screen.queryByText("Workspace files")).toBeNull();
    expect(screen.queryByText("Saved notes")).toBeNull();
  });

  it("offers manual file import from the library", () => {
    const onImportLibraryFiles = vi.fn();
    renderPanel({ mode: "library", onImportLibraryFiles });

    fireEvent.click(screen.getByRole("button", { name: "Import files" }));

    expect(onImportLibraryFiles).toHaveBeenCalledTimes(1);
  });

  it("adds web search results to the library", () => {
    const onAddLibrarySource = vi.fn();
    renderPanel({
      mode: "library",
      onAddLibrarySource,
      sourceSearch: {
        type: "$source_search_results",
        nonce: 1,
        query: "NotebookLM",
        results: [
          {
            kind: "web",
            title: "NotebookLM",
            url: "https://notebooklm.google/",
            snippet: "AI notebook source grounding.",
          },
        ],
      },
    });

    fireEvent.change(screen.getByPlaceholderText("Search web or saved sources…"), {
      target: { value: "NotebookLM" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAddLibrarySource).toHaveBeenCalledWith({
      kind: "web",
      title: "NotebookLM",
      url: "https://notebooklm.google/",
      snippet: "AI notebook source grounding.",
    });
  });

  it("opens saved web sources in the built-in browser", () => {
    const onOpenWebSource = vi.fn();
    renderPanel({
      mode: "library",
      onOpenWebSource,
      librarySources: [
        {
          id: "web-1",
          kind: "web",
          title: "NotebookLM",
          url: "https://notebooklm.google/",
          snippet: "AI notebook source grounding.",
          addedAt: 1,
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Open source: NotebookLM" }));

    expect(onOpenWebSource).toHaveBeenCalledWith("https://notebooklm.google/");
  });

  it("previews and reveals saved local file sources", () => {
    const onPreviewFile = vi.fn();
    const onRevealFileSource = vi.fn();
    renderPanel({
      mode: "library",
      onPreviewFile,
      onRevealFileSource,
      librarySources: [
        {
          id: "file-1",
          kind: "file",
          title: "notes.md",
          path: "docs/notes.md",
          snippet: "docs/notes.md",
          addedAt: 1,
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Open source: notes.md" }));
    expect(onPreviewFile).toHaveBeenCalledWith({ path: "docs/notes.md" });

    fireEvent.click(screen.getByRole("button", { name: "Show in folder: notes.md" }));
    expect(onRevealFileSource).toHaveBeenCalledWith("docs/notes.md");
  });

  it("filters saved library sources while searching", () => {
    renderPanel({
      mode: "library",
      sourceSearch: {
        type: "$source_search_results",
        nonce: 1,
        query: "notebook",
        results: [],
      },
      librarySources: [
        {
          id: "web-1",
          kind: "web",
          title: "NotebookLM",
          url: "https://notebooklm.google/",
          snippet: "AI notebook source grounding.",
          addedAt: 1,
        },
        {
          id: "web-2",
          kind: "web",
          title: "Unrelated Source",
          url: "https://example.com/",
          snippet: "Different topic.",
          addedAt: 2,
        },
      ],
    });

    fireEvent.change(screen.getByPlaceholderText("Search web or saved sources…"), {
      target: { value: "notebook" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.getByText("NotebookLM")).toBeTruthy();
    expect(screen.queryByText("Unrelated Source")).toBeNull();
  });

  it("sends a side chat message from the sidebar", () => {
    const onSideChatSend = vi.fn();
    renderPanel({ mode: "sidechat", onSideChatSend });

    fireEvent.change(screen.getByLabelText("Side chat message"), {
      target: { value: "Check the current diff" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send side chat" }));

    expect(onSideChatSend).toHaveBeenCalledWith("Check the current diff");
    expect((screen.getByLabelText("Side chat message") as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps side chat sends available while a temporary answer is pending", () => {
    const onSideChatSend = vi.fn();
    renderPanel({
      mode: "sidechat",
      sideChatBusy: true,
      sideChats: [{ id: "side-1", question: "Existing side question", status: "pending" }],
      onSideChatSend,
    });

    expect(screen.getByText("Existing side question")).toBeTruthy();
    expect(screen.getByText("Thinking…")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Side chat message"), {
      target: { value: "Another throwaway question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send side chat" }));

    expect(onSideChatSend).toHaveBeenCalledWith("Another throwaway question");
  });

  it("shows completed side chat answers in the sidebar", () => {
    renderPanel({
      mode: "sidechat",
      sideChats: [
        {
          id: "side-1",
          question: "What is a closure?",
          answer: "A closure captures variables from its outer scope.",
          status: "done",
        },
      ],
    });

    expect(screen.getByText("What is a closure?")).toBeTruthy();
    expect(screen.getByText("A closure captures variables from its outer scope.")).toBeTruthy();
  });

  it("opens a website inside the browser panel and can open it externally", async () => {
    renderPanel({ mode: "browser" });

    fireEvent.change(screen.getByLabelText("Website URL"), {
      target: { value: "example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open website" }));

    expect(screen.getByTitle("Browser preview").classList.contains("ctx-browser-native-host")).toBe(
      true,
    );
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText("https://example.com/")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open in default browser" }));

    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.com/"));
  });

  it("opens browser requests passed from the conversation", () => {
    renderPanel({
      mode: "browser",
      browserRequest: { id: 1, url: "https://example.com/docs" },
    });

    expect(screen.getByTitle("Browser preview").classList.contains("ctx-browser-native-host")).toBe(
      true,
    );
    expect(screen.getByText("https://example.com/docs")).toBeTruthy();
  });

  it("returns to the source panel when closing a browser opened from library", () => {
    const onModeChange = vi.fn();
    renderPanel({
      mode: "browser",
      browserReturnMode: "library",
      browserRequest: { id: 1, url: "https://example.com/docs" },
      onModeChange,
    });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onModeChange).toHaveBeenCalledWith("library");
  });

  it("opens local html file requests inside the browser panel", () => {
    renderPanel({
      mode: "browser",
      browserRequest: { id: 1, url: "file:///repo/reports/index.html" },
    });

    expect(screen.getByTitle("Browser preview").classList.contains("ctx-browser-native-host")).toBe(
      true,
    );
    expect(screen.getByText("file:///repo/reports/index.html")).toBeTruthy();
  });

  it("hides the native browser webview when the sidebar is not visible", async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 120,
      left: 100,
      top: 120,
      right: 460,
      bottom: 520,
      width: 360,
      height: 400,
      toJSON: () => ({}),
    } as DOMRect);
    const view = renderPanel({
      mode: "browser",
      browserRequest: { id: 1, url: "https://example.com/docs" },
      visible: true,
    });

    await waitFor(() => expect(webviewMockState.webviewInstances[0]?.show).toHaveBeenCalled());

    view.rerender(
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
        mode="browser"
        browserRequest={{ id: 1, url: "https://example.com/docs" }}
        visible={false}
      />,
    );

    await waitFor(() => expect(webviewMockState.webviewInstances[0]?.hide).toHaveBeenCalled());
    rectSpy.mockRestore();
  });

  it("resyncs native browser bounds when the panel placement changes", async () => {
    let rect = {
      x: 40,
      y: 480,
      left: 40,
      top: 480,
      right: 740,
      bottom: 680,
      width: 700,
      height: 200,
      toJSON: () => ({}),
    } as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => rect);
    const view = renderPanel({
      mode: "browser",
      browserRequest: { id: 1, url: "file:///repo/reports/index.html" },
      placement: "bottom",
      visible: true,
    });

    await waitFor(() => expect(webviewMockState.webviewInstances[0]?.show).toHaveBeenCalled());

    rect = {
      x: 840,
      y: 96,
      left: 840,
      top: 96,
      right: 1200,
      bottom: 720,
      width: 360,
      height: 624,
      toJSON: () => ({}),
    } as DOMRect;
    view.rerender(
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
        mode="browser"
        browserRequest={{ id: 1, url: "file:///repo/reports/index.html" }}
        placement="side"
        visible={true}
      />,
    );

    await waitFor(() =>
      expect(webviewMockState.webviewInstances[0]?.setPosition).toHaveBeenCalledWith(
        expect.objectContaining({ x: 840, y: 96 }),
      ),
    );
    expect(webviewMockState.webviewInstances[0]?.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 360, height: 624 }),
    );
    rectSpy.mockRestore();
  });

  it("renders review changes and previews a changed file", async () => {
    const onPreviewFile = vi.fn();
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "git_status") {
        return Promise.resolve([
          { path: "src/App.tsx", kind: "modified" },
          { path: "src/new.ts", kind: "untracked" },
        ]) as never;
      }
      if (command === "git_diff") {
        return Promise.resolve(
          [
            "diff --git a/src/App.tsx b/src/App.tsx",
            "index 123..456 100644",
            "--- a/src/App.tsx",
            "+++ b/src/App.tsx",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "diff --git a/src/new.ts b/src/new.ts",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/src/new.ts",
            "@@ -0,0 +1 @@",
            "+hello",
          ].join("\n"),
        ) as never;
      }
      return Promise.resolve(null) as never;
    });

    renderPanel({ mode: "review", onPreviewFile });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_status", { root: "/repo" }));
    expect(invoke).toHaveBeenCalledWith("git_diff", { root: "/repo" });
    expect(screen.getByText("2 changed")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getAllByText("-1").length).toBeGreaterThan(0);
    expect(screen.getByText("src/App.tsx")).toBeTruthy();
    expect(screen.getByText("src/new.ts")).toBeTruthy();
    const appRow = screen.getByRole("button", {
      name: "src/App.tsx M +1 -1",
    });
    await waitFor(() => expect(appRow.getAttribute("aria-expanded")).toBe("true"));
    expect(document.body.textContent).toContain("-old");
    expect(document.body.textContent).toContain("+new");
    expect(document.body.textContent).not.toContain("diff --git");
    expect(document.body.textContent).not.toContain("index 123..456");
    expect(screen.queryByRole("button", { name: "Refresh changes" })).toBeNull();

    fireEvent.click(appRow);
    expect(appRow.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "src/new.ts U +1 -0" }));
    expect(document.body.textContent).toContain("+hello");
    expect(document.body.textContent).not.toContain("new file mode");
    fireEvent.doubleClick(appRow);

    expect(onPreviewFile).toHaveBeenCalledWith({ path: "src/App.tsx" });
  });

  it("automatically refreshes review changes while the panel is open", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(invoke).mockImplementation((command: string) => {
        if (command === "git_status") {
          return Promise.resolve([]) as never;
        }
        if (command === "git_diff") {
          return Promise.resolve("") as never;
        }
        return Promise.resolve(null) as never;
      });

      renderPanel({ mode: "review" });

      await act(async () => {
        await Promise.resolve();
      });
      expect(invoke).toHaveBeenCalledWith("git_status", { root: "/repo" });

      await act(async () => {
        vi.advanceTimersByTime(1800);
        await Promise.resolve();
      });

      expect(
        vi.mocked(invoke).mock.calls.filter(([command]) => command === "git_status").length,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("connects the sidebar terminal to a persistent pty session", async () => {
    const view = renderPanel({ mode: "terminal" });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("terminal_spawn", {
        id: "sidebar",
        root: "/repo",
        cols: expect.any(Number),
        rows: expect.any(Number),
      }),
    );
    expect(xtermMockState.terminals.length).toBe(1);
    expect(xtermMockState.fitAddons.length).toBe(1);

    eventMockState.emitMockEvent("terminal:output", {
      id: "sidebar",
      data: "hello\r\n",
    });
    expect(xtermMockState.terminals[0]?.writes).toContain("hello\r\n");

    xtermMockState.terminals[0]?.dataHandlers[0]?.("pwd\r");
    expect(invoke).toHaveBeenCalledWith("terminal_write", {
      id: "sidebar",
      data: "pwd\r",
    });

    view.unmount();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("terminal_kill", { id: "sidebar" }));
    expect(xtermMockState.terminals[0]?.disposed).toBe(true);
  });

  it("uses the app theme tokens for the sidebar terminal surface and text", async () => {
    document.documentElement.style.setProperty("--fg", "#20242a");
    document.documentElement.style.setProperty("--panel", "#f7f8fa");
    document.documentElement.style.setProperty("--accent-soft", "rgba(32, 36, 42, 0.16)");
    document.documentElement.style.setProperty("--terminal-fg", "#24292f");
    document.documentElement.style.setProperty("--terminal-surface", "#fbfcfd");
    document.documentElement.style.setProperty("--terminal-red", "#c42b3a");
    document.documentElement.style.setProperty("--terminal-blue", "#2f63c7");

    renderPanel({ mode: "terminal" });

    await waitFor(() => expect(xtermMockState.terminals.length).toBe(1));
    const theme = xtermMockState.terminals[0]?.options?.theme as Record<string, string> | undefined;
    expect(theme?.background).toBe("#fbfcfd");
    expect(theme?.foreground).toBe("#24292f");
    expect(theme?.cursor).toBe("#24292f");
    expect(theme?.cursorAccent).toBe("#fbfcfd");
    expect(theme?.black).toBe("#24292f");
    expect(theme?.white).toBe("#24292f");
    expect(theme?.brightWhite).toBe("#24292f");
    expect(theme?.red).toBe("#c42b3a");
    expect(theme?.blue).toBe("#2f63c7");
    expect(theme?.selectionBackground).toBe("rgba(32, 36, 42, 0.16)");
  });

  it("previews a searched project file", async () => {
    const onMentionQuery = vi.fn();
    const onMentionPicked = vi.fn();
    const onPreviewFile = vi.fn();
    const view = renderPanel({
      mode: "files",
      onMentionQuery,
      onMentionPicked,
      onPreviewFile,
    });

    await waitFor(() => expect(onMentionQuery).toHaveBeenCalled());
    const nonce = onMentionQuery.mock.calls[0]?.[1] as number;
    view.rerender(
      <ContextPanel
        settings={settings}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        subagents={[]}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        mode="files"
        onMentionQuery={onMentionQuery}
        onMentionPicked={onMentionPicked}
        mentionResults={{ nonce, query: "", results: ["src/App.tsx:42"] }}
        onOpenSubagent={() => {}}
        onReadMemory={() => {}}
        onPreviewFile={onPreviewFile}
      />,
    );

    fireEvent.click(screen.getByText("App.tsx:42"));

    expect(onMentionPicked).toHaveBeenCalledWith("src/App.tsx");
    expect(onPreviewFile).toHaveBeenCalledWith({
      path: "src/App.tsx",
      line: "42",
    });
  });

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

  it("adds a tracked file to the library from the files panel", () => {
    const onAddLibrarySource = vi.fn();
    renderPanel({ mode: "files", onAddLibrarySource });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Add to library: src/new-file.ts",
      }),
    );

    expect(onAddLibrarySource).toHaveBeenCalledWith({
      kind: "file",
      title: "new-file.ts",
      path: "src/new-file.ts",
      snippet: "src/new-file.ts",
    });
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
      mode: "preview",
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

    expect(screen.getAllByText("Preview").length).toBeGreaterThan(0);
    expect(screen.getAllByText("src/new-file.ts").length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain("export const x = 1;");
  });

  it("uses rich rendering for docx files instead of extracted text", () => {
    renderPanel({
      mode: "preview",
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
    expect(document.querySelector(".file-preview-docx")).toBeTruthy();
    expect(document.querySelector(".file-preview-text")).toBeNull();
    expect(document.body.textContent).not.toContain("Project brief");
  });

  it("renders markdown previews as markdown instead of plain text", () => {
    renderPanel({
      mode: "preview",
      selectedFilePreview: {
        path: "docs/demo.md",
        absPath: "/repo/docs/demo.md",
        name: "demo.md",
        ext: "md",
        kind: "text",
        bytes: 128,
        modifiedMs: null,
        text: "# Welcome\n\n**Ready**",
        truncated: false,
      },
    });

    expect(document.querySelector(".file-preview-markdown")).toBeTruthy();
    expect(document.querySelector(".file-preview-text")).toBeNull();
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeTruthy();
    expect(screen.getByText("Ready").tagName.toLowerCase()).toBe("strong");
  });

  it("uses the rich PDF renderer for PDF previews", () => {
    renderPanel({
      mode: "preview",
      selectedFilePreview: {
        path: "docs/spec.pdf",
        absPath: "/repo/docs/spec.pdf",
        name: "spec.pdf",
        ext: "pdf",
        kind: "binary",
        bytes: 4096,
        modifiedMs: null,
        text: null,
        truncated: false,
      },
    });

    expect(screen.getByText(/PDF preview/i)).toBeTruthy();
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
      <ContextInfoPopover
        open
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

  it("shows all context information in the floating info card and opens the child transcript", () => {
    const onOpenSubagent = vi.fn();
    render(
      <ContextInfoPopover
        open
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

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open subagent: Explore the renderer",
      }),
    );

    expect(onOpenSubagent).toHaveBeenCalledWith("subagent-sub-1-20260531120000");
  });

  it("shows git information in the floating info card without context files", async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "git_info") {
        return Promise.resolve({
          isRepo: true,
          branch: "main",
          upstream: "origin/main",
          remote: "origin",
          ahead: 1,
          behind: 0,
          lastCommit: "abc1234 Update docs",
          branches: ["main", "feature/git-panel"],
        }) as never;
      }
      if (command === "git_status") {
        return Promise.resolve([
          { path: "README.md", kind: "modified" },
          { path: "src/new.ts", kind: "untracked" },
        ]) as never;
      }
      return Promise.resolve(null) as never;
    });

    render(
      <ContextInfoPopover
        open
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

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_info", { root: "/repo" }));
    expect(invoke).toHaveBeenCalledWith("git_status", { root: "/repo" });
    expect(screen.getByText("Git")).toBeTruthy();
    expect((screen.getByLabelText("Branch") as HTMLSelectElement).value).toBe("main");
    expect(screen.getByText("origin/main")).toBeTruthy();
    expect(screen.getByText("1 ahead")).toBeTruthy();
    expect(screen.getByText("2 changed")).toBeTruthy();
    expect(screen.queryByText("Files in context")).toBeNull();
    expect(screen.queryByText("new-file.ts")).toBeNull();
  });

  it("runs lightweight git actions from the floating info card", async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "git_info") {
        return Promise.resolve({
          isRepo: true,
          branch: "main",
          upstream: "origin/main",
          remote: "origin",
          ahead: 0,
          behind: 0,
          lastCommit: "abc1234 Update docs",
          branches: ["main", "feature/git-panel"],
        }) as never;
      }
      if (command === "git_status") {
        return Promise.resolve([{ path: "README.md", kind: "modified" }]) as never;
      }
      return Promise.resolve({ stdout: "ok", stderr: "", code: 0 }) as never;
    });

    render(
      <ContextInfoPopover
        open
        settings={settings}
        usage={usage}
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

    await waitFor(() => screen.getByText("Git"));

    fireEvent.change(screen.getByLabelText("Commit message"), {
      target: { value: "Update git panel" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("git_commit_all", {
        root: "/repo",
        message: "Update git panel",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_push", { root: "/repo" }));

    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("git_create_pull_request", {
        root: "/repo",
      }),
    );

    fireEvent.change(screen.getByLabelText("Branch"), {
      target: { value: "feature/git-panel" },
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("git_checkout_branch", {
        root: "/repo",
        branch: "feature/git-panel",
      }),
    );
  });

  it("allows an empty git commit message so the backend can auto-generate one", async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "git_info") {
        return Promise.resolve({
          isRepo: true,
          branch: "main",
          upstream: "origin/main",
          remote: "origin",
          ahead: 0,
          behind: 0,
          lastCommit: "abc1234 Update docs",
          branches: ["main"],
        }) as never;
      }
      if (command === "git_status") {
        return Promise.resolve([{ path: "README.md", kind: "modified" }]) as never;
      }
      return Promise.resolve({ stdout: "ok", stderr: "", code: 0 }) as never;
    });

    render(
      <ContextInfoPopover
        open
        settings={settings}
        usage={usage}
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

    await waitFor(() => screen.getByText("Git"));
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("git_commit_all", {
        root: "/repo",
        message: "",
      }),
    );
  });

  it("keeps the context info card vertical-only when content is wide", () => {
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    const scrollRule = css.match(/\.context-info-scroll \{[\s\S]*?\n\}/)?.[0] ?? "";
    const gitStatusRule = css.match(/\.ctx-git-action-status \{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(scrollRule).toContain("overflow-y: auto");
    expect(scrollRule).toContain("overflow-x: hidden");
    expect(gitStatusRule).toContain("overflow-y: auto");
    expect(gitStatusRule).toContain("overflow-x: hidden");
    expect(gitStatusRule).toContain("overflow-wrap: anywhere");
  });

  it("lets the surrounding shell control whether a selected file shows preview or files", () => {
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
        mode="files"
        onOpenSubagent={() => {}}
        onReadMemory={() => {}}
      />,
    );

    expect(document.querySelector(".ctx")?.getAttribute("data-mode")).toBe("files");
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
