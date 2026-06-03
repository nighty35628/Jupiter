// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import * as eventApi from "@tauri-apps/api/event";
import * as webviewApi from "@tauri-apps/api/webview";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, UsageStats } from "../App";
import type { FilePreview } from "../file-preview";
import { setLang } from "../i18n";
import { ContextInfoPopover, ContextPanel } from "./context-panel";

const xtermMockState = vi.hoisted(() => {
  const terminals: Array<{
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

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    writes: string[] = [];
    disposed = false;
    dataHandlers: Array<(data: string) => void> = [];
    open(_node: HTMLElement) {}
    loadAddon(_addon: unknown) {}
    onData(handler: (data: string) => void) {
      this.dataHandlers.push(handler);
      return {
        dispose: () => {
          this.dataHandlers = this.dataHandlers.filter(
            (item) => item !== handler,
          );
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
    constructor() {
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

  it("shows the five-entry home panel by default without shell controls", () => {
    renderPanel({ mode: undefined });

    expect(document.querySelector(".ctx")?.getAttribute("data-mode")).toBe(
      "home",
    );
    expect(screen.getByText("Files")).toBeTruthy();
    expect(screen.getByText("Side Chat")).toBeTruthy();
    expect(screen.getByText("Browser")).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Toggle bottom bar" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Toggle right sidebar" }),
    ).toBeNull();
  });

  it("lets the tab add button switch to another panel", () => {
    const onModeChange = vi.fn();
    renderPanel({ mode: "files", onModeChange });

    fireEvent.click(screen.getByRole("button", { name: "Add panel" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Browser" }));

    expect(onModeChange).toHaveBeenCalledWith("browser");
  });

  it("sends a side chat message from the sidebar", () => {
    const onSideChatSend = vi.fn();
    renderPanel({ mode: "sidechat", onSideChatSend });

    fireEvent.change(screen.getByLabelText("Side chat message"), {
      target: { value: "Check the current diff" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send side chat" }));

    expect(onSideChatSend).toHaveBeenCalledWith("Check the current diff");
    expect(
      (screen.getByLabelText("Side chat message") as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("keeps side chat sends available while a temporary answer is pending", () => {
    const onSideChatSend = vi.fn();
    renderPanel({
      mode: "sidechat",
      sideChatBusy: true,
      sideChats: [
        { id: "side-1", question: "Existing side question", status: "pending" },
      ],
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
    expect(
      screen.getByText("A closure captures variables from its outer scope."),
    ).toBeTruthy();
  });

  it("opens a website inside the browser panel and can open it externally", async () => {
    renderPanel({ mode: "browser" });

    fireEvent.change(screen.getByLabelText("Website URL"), {
      target: { value: "example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open website" }));

    expect(
      screen
        .getByTitle("Browser preview")
        .classList.contains("ctx-browser-native-host"),
    ).toBe(true);
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText("https://example.com/")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Open in default browser" }),
    );

    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://example.com/"),
    );
  });

  it("opens browser requests passed from the conversation", () => {
    renderPanel({
      mode: "browser",
      browserRequest: { id: 1, url: "https://example.com/docs" },
    });

    expect(
      screen
        .getByTitle("Browser preview")
        .classList.contains("ctx-browser-native-host"),
    ).toBe(true);
    expect(screen.getByText("https://example.com/docs")).toBeTruthy();
  });

  it("opens local html file requests inside the browser panel", () => {
    renderPanel({
      mode: "browser",
      browserRequest: { id: 1, url: "file:///repo/reports/index.html" },
    });

    expect(
      screen
        .getByTitle("Browser preview")
        .classList.contains("ctx-browser-native-host"),
    ).toBe(true);
    expect(screen.getByText("file:///repo/reports/index.html")).toBeTruthy();
  });

  it("hides the native browser webview when the sidebar is not visible", async () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
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

    await waitFor(() =>
      expect(webviewMockState.webviewInstances[0]?.show).toHaveBeenCalled(),
    );

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

    await waitFor(() =>
      expect(webviewMockState.webviewInstances[0]?.hide).toHaveBeenCalled(),
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

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("git_status", { root: "/repo" }),
    );
    expect(invoke).toHaveBeenCalledWith("git_diff", { root: "/repo" });
    expect(screen.getByText("2 changed")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getAllByText("-1").length).toBeGreaterThan(0);
    expect(screen.getByText("src/App.tsx")).toBeTruthy();
    expect(screen.getByText("src/new.ts")).toBeTruthy();
    const appRow = screen.getByRole("button", {
      name: "src/App.tsx M +1 -1",
    });
    await waitFor(() =>
      expect(appRow.getAttribute("aria-expanded")).toBe("true"),
    );
    expect(document.body.textContent).toContain("-old");
    expect(document.body.textContent).toContain("+new");
    expect(document.body.textContent).not.toContain("diff --git");
    expect(document.body.textContent).not.toContain("index 123..456");
    expect(
      screen.queryByRole("button", { name: "Refresh changes" }),
    ).toBeNull();

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
        vi
          .mocked(invoke)
          .mock.calls.filter(([command]) => command === "git_status").length,
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
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("terminal_kill", { id: "sidebar" }),
    );
    expect(xtermMockState.terminals[0]?.disposed).toBe(true);
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

    fireEvent.click(
      screen.getByRole("button", { name: "Open file: src/new-file.ts" }),
    );

    await waitFor(() =>
      expect(openPath).toHaveBeenCalledWith("/repo/src/new-file.ts"),
    );
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

  it("renders extracted document text in the preview pane", () => {
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
    expect(document.body.textContent).toContain("Project brief");
  });

  it("reveals a tracked file from its actions menu", async () => {
    renderPanel();

    fireEvent.click(
      screen.getByRole("button", { name: "File actions: src/new-file.ts" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reveal in folder" }));

    await waitFor(() =>
      expect(revealItemInDir).toHaveBeenCalledWith("/repo/src/new-file.ts"),
    );
  });

  it("opens the tracked file actions menu from the row context menu", () => {
    renderPanel();

    fireEvent.contextMenu(screen.getByText("new-file.ts"));

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open in default app" }),
    ).toBeTruthy();
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

    expect(onOpenSubagent).toHaveBeenCalledWith(
      "subagent-sub-1-20260531120000",
    );
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

    expect(document.querySelector(".ctx")?.getAttribute("data-mode")).toBe(
      "preview",
    );
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

    expect(document.querySelector(".ctx")?.getAttribute("data-mode")).toBe(
      "files",
    );
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

    expect(
      screen.queryByRole("button", { name: "Toggle bottom bar" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Toggle right sidebar" }),
    ).toBeNull();
  });
});
