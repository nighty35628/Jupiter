// @vitest-environment jsdom

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, forwardRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => {
  const listeners = new Map<string, Array<(event: { payload: unknown }) => void>>();
  const defaultInvoke = (cmd: string, payload?: unknown) => {
    if (cmd === "rpc_spawn" || cmd === "rpc_send") return Promise.resolve();
    if (cmd === "read_file_preview") {
      const path =
        typeof payload === "object" && payload && "path" in payload
          ? String((payload as { path?: unknown }).path)
          : "untitled.txt";
      return Promise.resolve({
        path,
        absPath: `/tmp/jupiter-streaming-test/${path}`,
        name: path.split("/").filter(Boolean).pop() || path,
        kind: "text",
        bytes: 12,
        modifiedMs: null,
        text: "preview text",
        truncated: false,
      });
    }
    if (cmd.startsWith("plugin:")) return Promise.resolve();
    return Promise.resolve();
  };
  const invoke = vi.fn(defaultInvoke);
  return {
    listeners,
    invoke,
    defaultInvoke,
    emit(event: string, payload: unknown) {
      for (const handler of listeners.get(event) ?? []) handler({ payload });
    },
  };
});

const splashMockState = vi.hoisted(() => ({
  shouldShow: false,
  shouldShowCalls: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    const bucket = tauri.listeners.get(event) ?? [];
    bucket.push(handler);
    tauri.listeners.set(event, bucket);
    return () => {
      const next = (tauri.listeners.get(event) ?? []).filter((item) => item !== handler);
      tauri.listeners.set(event, next);
    };
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn(() => Promise.resolve(false)),
    isMaximized: vi.fn(() => Promise.resolve(false)),
    isFocused: vi.fn(() => Promise.resolve(true)),
    setFullscreen: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    minimize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    listen: vi.fn(() => Promise.resolve(() => {})),
  }),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
  save: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(() => Promise.resolve(false)),
  requestPermission: vi.fn(() => Promise.resolve("denied")),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function VirtuosoMock(
    props: {
      data?: unknown[];
      totalCount?: number;
      itemContent: (index: number, item?: unknown) => ReactNode;
      components?: {
        Header?: () => ReactNode;
        Footer?: () => ReactNode;
      };
    },
    _ref,
  ) {
    const items = props.data ?? Array.from({ length: props.totalCount ?? 0 }, () => undefined);
    return (
      <div data-testid="virtuoso">
        {props.components?.Header ? <props.components.Header /> : null}
        {items.map((item, index) => (
          <div key={index}>{props.itemContent(index, item)}</div>
        ))}
        {props.components?.Footer ? <props.components.Footer /> : null}
      </div>
    );
  }),
}));

vi.mock("./CommandPalette", () => ({
  CommandPalette: () => null,
  Toast: () => null,
  buildCommands: vi.fn(() => []),
  useCommandPalette: vi.fn(() => ({ open: false, setOpen: vi.fn() })),
}));

vi.mock("./Markdown", () => ({
  WorkspaceProvider: ({ children }: { children?: unknown }) => children ?? null,
  Markdown: ({ source }: { source: string }) => <>{source}</>,
}));

vi.mock("./ui/splash", () => ({
  Splash: ({ onDone }: { onDone: () => void }) => (
    <button type="button" data-testid="splash" onClick={onDone}>
      Jupiter splash
    </button>
  ),
  shouldShowSplash: () => {
    splashMockState.shouldShowCalls += 1;
    return splashMockState.shouldShow;
  },
}));

vi.mock("./theme", () => ({
  FONT_FAMILY: { SANS: "sans" },
  FONT_FAMILY_STACK: { sans: "sans-serif" },
  FONT_SCALE: { MEDIUM: "medium" },
  FONT_SCALE_ZOOM: { medium: 1 },
  THEME: { LIGHT: "light", DARK: "dark" },
  defaultStyleForTheme: vi.fn(() => "default"),
  isFontFamily: vi.fn((value) => value === "sans"),
  isFontScale: vi.fn((value) => value === "medium"),
  isTheme: vi.fn((value) => value === "light" || value === "dark"),
  isThemeStyle: vi.fn((value) => value === "default"),
  themeForStyle: vi.fn(() => "light"),
}));

HTMLCanvasElement.prototype.getContext = vi.fn() as never;
Element.prototype.scrollIntoView = vi.fn();
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

import { App, shouldSkipInactiveTabRuntimeRender } from "./App";

async function emitRpc(line: Record<string, unknown>) {
  await act(async () => {
    tauri.emit("rpc:event", { data: JSON.stringify(line) });
    await Promise.resolve();
  });
}

async function emitBootstrap(
  tabId = "tab-1",
  workspaceDir = "/tmp/jupiter-streaming-test",
  opts: { busy?: boolean; promptHistory?: string[] } = {},
) {
  await emitRpc({
    type: "$tab_opened",
    tabId,
    workspaceDir,
    active: true,
    ...(opts.busy !== undefined ? { busy: opts.busy } : {}),
  });
  await waitFor(() =>
    expect(tauri.invoke).toHaveBeenCalledWith("rpc_send", {
      line: JSON.stringify({ cmd: "tab_activate", tabId }),
    }),
  );
  await emitRpc({
    type: "$settings",
    tabId,
    reasoningEffort: "high",
    editMode: "review",
    budgetUsd: null,
    workspaceDir,
    recentWorkspaces: [],
    model: "deepseek-v4-flash",
    subagentModels: {},
    contextTokens: {},
    showSystemEvents: true,
    processCardsDefaultOpen: false,
    memoryConfirmWrites: false,
    memoryGlobalEnabled: true,
    promptHistory: opts.promptHistory ?? [],
    version: "test",
  });
  await emitRpc({ type: "$ready", tabId });
}

function sentRpcCommands(): Array<Record<string, unknown>> {
  return tauri.invoke.mock.calls
    .filter((call) => call[0] === "rpc_send")
    .map((call) => JSON.parse((call[1] as { line: string }).line));
}

function contextTabTitles(): string[] {
  return Array.from(document.querySelectorAll(".ctx-tabs .ctx-tab-title")).map(
    (node) => node.textContent?.trim() ?? "",
  );
}

function contextTabByTitle(title: string): HTMLElement {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>(".ctx-tab"));
  const tab = tabs.find(
    (item) => item.querySelector(".ctx-tab-title")?.textContent?.trim() === title,
  );
  if (!tab) throw new Error(`Missing context tab: ${title}`);
  return tab;
}

function clickContextTab(title: string) {
  fireEvent.click(contextTabByTitle(title));
}

function closeActiveContextTab() {
  const contextPanel = document.querySelector(".ctx");
  expect(contextPanel).toBeTruthy();
  fireEvent.click(
    within(contextPanel as HTMLElement).getByRole("button", {
      name: "Close",
    }),
  );
}

function activeApp(): HTMLElement {
  const app = Array.from(document.querySelectorAll<HTMLElement>(".app")).find(
    (item) => item.style.display !== "none",
  );
  if (!app) throw new Error("Missing active app");
  return app;
}

function visibleMain(): HTMLElement {
  const main = Array.from(activeApp().querySelectorAll<HTMLElement>(".main")).find(
    (item) => item.style.display !== "none",
  );
  if (!main) throw new Error("Missing visible main");
  return main;
}

beforeEach(() => {
  tauri.listeners.clear();
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(tauri.defaultInvoke);
  vi.mocked(openDialog).mockReset();
  vi.mocked(openDialog).mockResolvedValue(null as never);
  vi.mocked(openUrl).mockReset();
  vi.mocked(openUrl).mockResolvedValue(undefined);
  localStorage.clear();
  splashMockState.shouldShow = false;
  splashMockState.shouldShowCalls = 0;
  sessionStorage.setItem("jupiter.splash.shown", "1");
});

afterEach(() => {
  cleanup();
});

describe("App streaming events", () => {
  it("starts a blank chat with the composer centered and workspace picker in the composer", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap("tab-new", "/tmp/jupiter-streaming-test");

    expect(screen.getByText("What should we do in Jupiter today?")).toBeTruthy();
    expect(document.querySelector(".empty-state .composer-wrap--hero")).toBeTruthy();
    expect(document.querySelector(".main > .composer-wrap")).toBeNull();

    const workspaceButton = screen.getByRole("button", {
      name: /Switch workspace: jupiter-streaming-test/,
    });
    fireEvent.click(workspaceButton);

    expect(screen.getByText("Switch workspace")).toBeTruthy();
    expect(document.querySelector(".wd-pop")?.textContent).toContain("jupiter-streaming-test");
  });

  it("does not show recent prompt history as blank-chat suggestions", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap("tab-new", "/tmp/jupiter-streaming-test", {
      promptHistory: ["最近刚问过的私密问题"],
    });

    expect(screen.queryByText("最近刚问过的私密问题")).toBeNull();
    expect(document.querySelectorAll(".empty-suggestion")).toHaveLength(4);
  });

  it("updates the top tab title when the workspace changes", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap("tab-one", "/tmp/Alpha");

    await waitFor(() => {
      expect(document.querySelector(".tabbar .tab .label")?.textContent).toBe("Alpha");
    });

    await emitRpc({
      type: "$settings",
      tabId: "tab-one",
      workspaceDir: "/tmp/Beta",
      recentWorkspaces: [],
      model: "deepseek-v4-flash",
    });

    await waitFor(() => {
      expect(document.querySelector(".tabbar .tab .label")?.textContent).toBe("Beta");
    });
  });

  it("shows a global update prompt with release-source and suppression actions", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap("tab-update", "/tmp/jupiter-streaming-test");

    await emitRpc({
      type: "$update_check",
      mode: "auto",
      status: "available",
      currentVersion: "0.99.9",
      latestVersion: "0.99.10",
      releaseUrls: {
        gitee: "https://gitee.com/nighty35628/jupiter/releases",
        github: "https://github.com/nighty35628/Jupiter/releases/latest",
      },
    });

    expect(screen.getByText(/0.99.9.*0.99.10|0.99.10.*0.99.9/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /gitee/i }));
    expect(openUrl).toHaveBeenCalledWith("https://gitee.com/nighty35628/jupiter/releases");

    fireEvent.click(screen.getByRole("button", { name: /skip this version|跳过当前版本/i }));
    expect(sentRpcCommands()).toContainEqual({ cmd: "update_skip", version: "0.99.10" });

    await emitRpc({
      type: "$update_check",
      mode: "auto",
      status: "available",
      currentVersion: "0.99.9",
      latestVersion: "0.99.10",
      releaseUrls: {
        gitee: "https://gitee.com/nighty35628/jupiter/releases",
        github: "https://github.com/nighty35628/Jupiter/releases/latest",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /don't remind again|不再提示/i }));
    expect(sentRpcCommands()).toContainEqual({ cmd: "update_disable_prompts" });
  });

  it("does not show the startup splash again when switching to a newly opened tab", async () => {
    splashMockState.shouldShow = true;
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap("tab-one", "/tmp/ws");
    expect(screen.getByTestId("splash")).toBeTruthy();

    fireEvent.click(screen.getByTestId("splash"));
    expect(screen.queryByTestId("splash")).toBeNull();

    await emitRpc({
      type: "$tab_opened",
      tabId: "tab-two",
      workspaceDir: "/tmp/ws",
      active: true,
    });

    expect(screen.queryByTestId("splash")).toBeNull();
    expect(splashMockState.shouldShowCalls).toBe(1);
  });

  it("renders live reasoning and content deltas before final", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap();

    await emitRpc({
      type: "user.message",
      tabId: "tab-1",
      id: 1,
      ts: new Date().toISOString(),
      turn: 1,
      text: "hello",
      clientId: "c-test",
    });
    await waitFor(() => {
      expect(screen.getAllByText("hello").length).toBeGreaterThan(0);
    });

    await emitRpc({
      type: "model.turn.started",
      tabId: "tab-1",
      id: 2,
      ts: new Date().toISOString(),
      turn: 1,
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      prefixHash: "test-prefix",
    });
    expect(screen.getByRole("status").textContent).toBe("Thinking");
    await emitRpc({
      type: "model.delta",
      tabId: "tab-1",
      turn: 1,
      channel: "reasoning",
      text: "thinking live",
    });
    await emitRpc({
      type: "model.delta",
      tabId: "tab-1",
      turn: 1,
      channel: "content",
      text: "answer live",
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("answer live");
    });
    expect(screen.queryByText("thinking live")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("applies model deltas during the same rpc event tick", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap();
    await emitRpc({
      type: "model.turn.started",
      tabId: "tab-1",
      id: 1,
      ts: new Date().toISOString(),
      turn: 1,
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      prefixHash: "test-prefix",
    });

    await emitRpc({
      type: "model.delta",
      tabId: "tab-1",
      turn: 1,
      channel: "content",
      text: "same tick",
    });

    expect(document.body.textContent).toContain("same tick");
  });

  it("keeps the stop button after a running tab is rehydrated", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap("tab-running", "/tmp/ws-running", { busy: true });
    await emitRpc({
      type: "$session_loaded",
      tabId: "tab-running",
      name: "desktop-running",
      busy: true,
      messages: [{ kind: "user", text: "still running" }],
      carryover: {
        totalCostUsd: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalCompletionTokens: 0,
      },
    });

    await waitFor(() => {
      expect(within(activeApp()).getByTitle("stop")).toBeTruthy();
    });
  });

  it("does not focus a restoring session tab before its transcript arrives", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap("tab-running", "/tmp/ws-running");
    await emitRpc({
      type: "user.message",
      tabId: "tab-running",
      id: 1,
      ts: new Date().toISOString(),
      turn: 1,
      text: "running prompt",
      clientId: "c-running",
    });
    await emitRpc({
      type: "model.turn.started",
      tabId: "tab-running",
      id: 2,
      ts: new Date().toISOString(),
      turn: 1,
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      prefixHash: "test-prefix",
    });
    await waitFor(() => {
      expect(visibleMain().textContent).toContain("running prompt");
    });

    await emitRpc({
      type: "$tab_opened",
      tabId: "tab-history",
      workspaceDir: "/tmp/ws-history",
      active: true,
      restoringSession: "desktop-history",
    });

    expect(visibleMain().textContent).toContain("running prompt");
    expect(visibleMain().textContent).not.toContain("Welcome to Jupiter");

    await emitRpc({
      type: "$session_loaded",
      tabId: "tab-history",
      name: "desktop-history",
      messages: [{ kind: "user", text: "loaded history" }],
      carryover: {
        totalCostUsd: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalCompletionTokens: 0,
      },
    });

    await waitFor(() => {
      expect(visibleMain().textContent).toContain("loaded history");
    });
  });

  it("keeps live in-flight content when a busy session snapshot arrives", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap("tab-running", "/tmp/ws-running");
    await emitRpc({
      type: "$session_loaded",
      tabId: "tab-running",
      name: "desktop-running",
      messages: [],
      carryover: {
        totalCostUsd: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalCompletionTokens: 0,
      },
    });
    await emitRpc({
      type: "user.message",
      tabId: "tab-running",
      id: 1,
      ts: new Date().toISOString(),
      turn: 1,
      text: "running prompt",
      clientId: "c-running",
    });
    await emitRpc({
      type: "model.turn.started",
      tabId: "tab-running",
      id: 2,
      ts: new Date().toISOString(),
      turn: 1,
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      prefixHash: "test-prefix",
    });
    await emitRpc({
      type: "model.delta",
      tabId: "tab-running",
      id: 3,
      ts: new Date().toISOString(),
      turn: 1,
      channel: "content",
      text: "live answer",
    });

    await emitRpc({
      type: "$session_loaded",
      tabId: "tab-running",
      name: "desktop-running",
      busy: true,
      messages: [{ kind: "user", text: "running prompt" }],
      carryover: {
        totalCostUsd: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalCompletionTokens: 0,
      },
    });

    expect(visibleMain().textContent).toContain("live answer");
    expect(within(activeApp()).getByTitle("stop")).toBeTruthy();
  });

  it("keeps live content and stop state when focusing an already-open running tab", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap("tab-running", "/tmp/ws-running");
    await emitRpc({
      type: "$session_loaded",
      tabId: "tab-running",
      name: "desktop-running",
      messages: [],
      carryover: {
        totalCostUsd: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalCompletionTokens: 0,
      },
    });
    await emitRpc({
      type: "user.message",
      tabId: "tab-running",
      id: 1,
      ts: new Date().toISOString(),
      turn: 1,
      text: "running prompt",
      clientId: "c-running",
    });
    await emitRpc({
      type: "model.turn.started",
      tabId: "tab-running",
      id: 2,
      ts: new Date().toISOString(),
      turn: 1,
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      prefixHash: "test-prefix",
    });
    await emitRpc({
      type: "model.delta",
      tabId: "tab-running",
      id: 3,
      ts: new Date().toISOString(),
      turn: 1,
      channel: "content",
      text: "live answer",
    });

    await emitBootstrap("tab-history", "/tmp/ws-running");
    await emitRpc({
      type: "$session_loaded",
      tabId: "tab-history",
      name: "desktop-history",
      messages: [{ kind: "user", text: "loaded history" }],
      carryover: {
        totalCostUsd: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalCompletionTokens: 0,
      },
    });
    await waitFor(() => {
      expect(visibleMain().textContent).toContain("loaded history");
    });

    await emitRpc({
      type: "$tab_opened",
      tabId: "tab-running",
      workspaceDir: "/tmp/ws-running",
      active: true,
      busy: true,
    });

    await waitFor(() => {
      expect(visibleMain().textContent).toContain("live answer");
    });
    expect(visibleMain().textContent).not.toContain("loaded history");
    expect(within(activeApp()).getByTitle("stop")).toBeTruthy();
  });

  it("renders live subagent activity as an in-thread card", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap("tab-subagent", "/tmp/ws-subagent");
    await emitRpc({
      type: "user.message",
      tabId: "tab-subagent",
      id: 1,
      ts: new Date().toISOString(),
      turn: 1,
      text: "research this",
      clientId: "c-subagent",
    });
    await emitRpc({
      type: "model.turn.started",
      tabId: "tab-subagent",
      id: 2,
      ts: new Date().toISOString(),
      turn: 1,
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      prefixHash: "test-prefix",
    });
    await emitRpc({
      type: "$subagent_event",
      tabId: "tab-subagent",
      kind: "start",
      runId: "subagent-1",
      parentSession: "desktop-subagent",
      sessionName: "subagent-session-1",
      task: "Survey release blockers",
      skillName: "research",
      model: "deepseek-v4-flash",
    });

    expect(visibleMain().textContent).toContain("subagent");
    expect(visibleMain().textContent).toContain("Survey release blockers");
  });

  it("opens subagent details in a sidebar tab instead of loading the child session in main chat", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap("tab-subagent", "/tmp/ws-subagent");
    await emitRpc({
      type: "$subagent_event",
      tabId: "tab-subagent",
      kind: "start",
      runId: "subagent-1",
      parentSession: "desktop-subagent",
      sessionName: "subagent-session-1",
      task: "Survey release blockers",
      skillName: "research",
      model: "deepseek-v4-flash",
    });

    fireEvent.click(screen.getByRole("button", { name: "Show information" }));
    fireEvent.click(screen.getByRole("button", { name: "Open subagent: Survey release blockers" }));

    await waitFor(() => {
      expect(contextTabTitles()).toContain("Survey release blockers");
    });
    expect(document.querySelector(".ctx")?.getAttribute("data-mode")).toBe("subagent");
    expect(within(document.querySelector(".ctx") as HTMLElement).getByText("research")).toBeTruthy();
    expect(
      sentRpcCommands().some(
        (cmd) => cmd.cmd === "session_load" && cmd.name === "subagent-session-1",
      ),
    ).toBe(false);
  });

  it("keeps sidebar sessions synchronized across tab switches", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap("tab-one", "/tmp/ws-one");
    await emitBootstrap("tab-two", "/tmp/ws-one");
    await emitRpc({
      type: "$tab_opened",
      tabId: "tab-one",
      workspaceDir: "/tmp/ws-one",
      active: true,
    });
    await waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith("rpc_send", {
        line: JSON.stringify({ cmd: "tab_activate", tabId: "tab-one" }),
      });
    });

    await emitRpc({
      type: "$sessions",
      tabId: "tab-one",
      items: [
        {
          name: "desktop-shared",
          messageCount: 2,
          mtime: new Date().toISOString(),
          summary: "Shared sidebar chat",
          workspace: "/tmp/ws-one",
          workspaceStatus: "ok",
        },
      ],
    });

    await emitRpc({
      type: "$tab_opened",
      tabId: "tab-two",
      workspaceDir: "/tmp/ws-one",
      active: true,
    });

    await waitFor(() => {
      expect((activeApp().querySelector(".sidebar") as HTMLElement).textContent).toContain(
        "Shared sidebar chat",
      );
    });
  });

  it("keeps the same visible sidebar instance and scroll position when busy navigation switches tabs", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap("tab-running", "/tmp/ws");
    await emitRpc({
      type: "$sessions",
      tabId: "tab-running",
      items: Array.from({ length: 30 }, (_, index) => ({
        name: `desktop-${index}`,
        messageCount: 2,
        mtime: new Date(Date.now() - index * 1000).toISOString(),
        summary: index === 29 ? "Target old chat" : `Chat ${index}`,
        workspace: "/tmp/ws",
        workspaceStatus: "ok",
      })),
    });
    await emitRpc({
      type: "$session_loaded",
      tabId: "tab-running",
      name: "desktop-running",
      messages: [],
      carryover: {
        totalCostUsd: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalCompletionTokens: 0,
      },
    });
    await emitRpc({
      type: "user.message",
      tabId: "tab-running",
      id: 1,
      ts: new Date().toISOString(),
      turn: 1,
      text: "running prompt",
      clientId: "c-running",
    });
    await emitRpc({
      type: "model.turn.started",
      tabId: "tab-running",
      id: 2,
      ts: new Date().toISOString(),
      turn: 1,
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      prefixHash: "test-prefix",
    });

    const sidebar = activeApp().querySelector(".sidebar") as HTMLElement;
    expect(sidebar).toBeTruthy();
    const list = sidebar.querySelector(".session-list") as HTMLElement;
    expect(list).toBeTruthy();
    list.scrollTop = 240;

    fireEvent.click(
      within(sidebar).getByText("Target old chat").closest(".session-item") as HTMLElement,
    );
    await emitRpc({
      type: "$tab_opened",
      tabId: "tab-target",
      workspaceDir: "/tmp/ws",
      active: true,
      busy: false,
    });
    await emitRpc({
      type: "$session_loaded",
      tabId: "tab-target",
      name: "desktop-29",
      messages: [{ kind: "user", text: "old prompt" }],
      carryover: {
        totalCostUsd: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalCompletionTokens: 0,
      },
    });

    const nextSidebar = activeApp().querySelector(".sidebar") as HTMLElement;
    expect(nextSidebar).toBe(sidebar);
    expect((nextSidebar.querySelector(".session-list") as HTMLElement).scrollTop).toBe(240);
  });

  it("restores a running session by focusing its existing tab instead of reloading a snapshot", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap("tab-running", "/tmp/ws");
    await emitRpc({
      type: "$sessions",
      tabId: "tab-running",
      items: [
        {
          name: "desktop-running",
          messageCount: 2,
          mtime: new Date().toISOString(),
          summary: "Running chat",
          workspace: "/tmp/ws",
          workspaceStatus: "ok",
        },
        {
          name: "desktop-other",
          messageCount: 2,
          mtime: new Date().toISOString(),
          summary: "Other chat",
          workspace: "/tmp/ws",
          workspaceStatus: "ok",
        },
      ],
    });
    await emitRpc({
      type: "$session_loaded",
      tabId: "tab-running",
      name: "desktop-running",
      messages: [],
      carryover: {
        totalCostUsd: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalCompletionTokens: 0,
      },
    });
    await emitRpc({
      type: "user.message",
      tabId: "tab-running",
      id: 1,
      ts: new Date().toISOString(),
      turn: 1,
      text: "running prompt",
      clientId: "c-running",
    });
    await emitRpc({
      type: "model.turn.started",
      tabId: "tab-running",
      id: 2,
      ts: new Date().toISOString(),
      turn: 1,
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      prefixHash: "test-prefix",
    });
    await emitRpc({
      type: "model.delta",
      tabId: "tab-running",
      id: 3,
      ts: new Date().toISOString(),
      turn: 1,
      channel: "content",
      text: "half streamed answer",
    });

    fireEvent.click(
      within(activeApp()).getByText("Other chat").closest(".session-item") as HTMLElement,
    );
    await emitRpc({
      type: "$tab_opened",
      tabId: "tab-other",
      workspaceDir: "/tmp/ws",
      active: true,
      busy: false,
    });
    await emitRpc({
      type: "$session_loaded",
      tabId: "tab-other",
      name: "desktop-other",
      messages: [{ kind: "user", text: "other prompt" }],
      carryover: {
        totalCostUsd: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalCompletionTokens: 0,
      },
    });

    const sidebar = activeApp().querySelector(".sidebar") as HTMLElement;
    expect(sidebar).toBeTruthy();
    fireEvent.click(
      within(sidebar).getByText("Running chat").closest(".session-item") as HTMLElement,
    );
    await emitRpc({
      type: "$tab_opened",
      tabId: "tab-running",
      workspaceDir: "/tmp/ws",
      active: true,
      busy: true,
    });

    expect(visibleMain().textContent).toContain("half streamed answer");
    expect(within(activeApp()).getByTitle("stop")).toBeTruthy();
  });

  it("serializes rpc sends so sidebar navigation cannot overtake a submitted turn", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap();
    await emitRpc({
      type: "$sessions",
      tabId: "tab-1",
      items: [
        {
          name: "desktop-other",
          messageCount: 2,
          mtime: new Date().toISOString(),
          summary: "Other chat",
          workspace: "/tmp/jupiter-streaming-test",
          workspaceStatus: "ok",
        },
      ],
    });

    const sent: Array<Record<string, unknown>> = [];
    let resolveUserInput: (() => void) | null = null;
    tauri.invoke.mockClear();
    tauri.invoke.mockImplementation((cmd: string, payload?: unknown) => {
      if (cmd === "rpc_send") {
        const parsed = JSON.parse((payload as { line: string }).line);
        sent.push(parsed);
        if (parsed.cmd === "user_input") {
          return new Promise<void>((resolve) => {
            resolveUserInput = resolve;
          });
        }
      }
      return Promise.resolve();
    });

    const textarea = screen.getByPlaceholderText("Ask the agent / describe a task…");
    fireEvent.change(textarea, { target: { value: "start running" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    const otherSession = screen.getByText("Other chat").closest(".session-item") as HTMLElement;
    expect(otherSession).toBeTruthy();
    fireEvent.click(otherSession);

    await waitFor(() => {
      expect(sent.some((item) => item.cmd === "user_input")).toBe(true);
    });
    expect(sent.some((item) => item.cmd === "session_load")).toBe(false);

    await act(async () => {
      resolveUserInput?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        sent
          .map((item) => item.cmd)
          .filter((cmd) => cmd === "user_input" || cmd === "session_load"),
      ).toEqual(["user_input", "session_load"]);
    });
  });

  it("skips parent-driven renders for tabs that remain hidden", () => {
    expect(
      shouldSkipInactiveTabRuntimeRender(
        { tabId: "tab-one", active: false },
        { tabId: "tab-one", active: false },
      ),
    ).toBe(true);
    expect(
      shouldSkipInactiveTabRuntimeRender(
        { tabId: "tab-one", active: true },
        { tabId: "tab-one", active: false },
      ),
    ).toBe(false);
  });

  it("aborts the current turn and sends the selected queued prompt when jumping ahead", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap();
    tauri.invoke.mockClear();

    await emitRpc({
      type: "user.message",
      tabId: "tab-1",
      id: 1,
      ts: new Date().toISOString(),
      turn: 1,
      text: "current prompt",
      clientId: "c-current",
    });
    await emitRpc({
      type: "model.turn.started",
      tabId: "tab-1",
      id: 1,
      ts: new Date().toISOString(),
      turn: 1,
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      prefixHash: "test-prefix",
    });

    const textarea = screen.getByPlaceholderText("Ask the agent / describe a task…");
    fireEvent.change(textarea, { target: { value: "first queued" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "second queued" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: "Jump ahead: second queued" }));

    await waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith("rpc_send", {
        line: JSON.stringify({ tabId: "tab-1", cmd: "abort" }),
      });
    });

    await emitRpc({
      type: "model.final",
      tabId: "tab-1",
      id: 2,
      ts: new Date().toISOString(),
      turn: 1,
      content:
        "[aborted by user (Esc) — no summary produced. Ask again or /retry when ready; prior tool output is still in the log.]",
      forcedSummary: true,
      usage: {},
      costUsd: 0,
    });

    expect(document.body.textContent).not.toContain("no summary produced");
    expect(document.body.textContent).not.toContain("Ask again or /retry");

    await emitRpc({ type: "$turn_complete", tabId: "tab-1" });

    await waitFor(() => {
      expect(
        tauri.invoke.mock.calls.some((call) => {
          const [cmd, payload] = call as [string, { line: string }];
          if (cmd !== "rpc_send") return false;
          const line = JSON.parse(payload.line);
          return line.cmd === "user_input" && line.text === "second queued";
        }),
      ).toBe(true);
    });
  });

  it("ingests web source text when adding a web search result", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap();
    tauri.invoke.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Search sources" }));
    fireEvent.change(screen.getByPlaceholderText("Search web or saved sources…"), {
      target: { value: "NotebookLM" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    let searchCommand: Record<string, unknown> | undefined;
    await waitFor(() => {
      searchCommand = sentRpcCommands().find((cmd) => cmd.cmd === "source_search");
      expect(searchCommand).toBeTruthy();
    });

    await emitRpc({
      type: "$source_search_results",
      tabId: "tab-1",
      nonce: searchCommand?.nonce,
      query: "NotebookLM",
      results: [
        {
          kind: "web",
          title: "NotebookLM",
          url: "https://notebooklm.google/",
          snippet: "AI notebook source grounding.",
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    let addCommand: Record<string, unknown> | undefined;
    await waitFor(() => {
      addCommand = sentRpcCommands().find((cmd) => cmd.cmd === "library_add");
      expect(addCommand).toMatchObject({
        cmd: "library_add",
        source: {
          kind: "web",
          url: "https://notebooklm.google/",
          title: "NotebookLM",
        },
      });
    });

    await emitRpc({
      type: "$library_sources",
      tabId: "tab-1",
      workspaceDir: "/tmp/jupiter-streaming-test",
      sources: [
        {
          id: "source-1",
          kind: "web",
          title: "NotebookLM",
          url: "https://notebooklm.google/",
          snippet: "AI notebook source grounding.",
          contentText: "Full page body with citation grounding.",
          contentFetchedAt: 1_780_000_000_000,
          contentTruncated: false,
          ingestStatus: "done",
          addedAt: 1,
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getAllByText("NotebookLM").length).toBeGreaterThan(0);
    });
  });

  it("adds mentioned files to the library from a natural-language request", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap();

    const textarea = screen.getByPlaceholderText("Ask the agent / describe a task…");
    fireEvent.change(textarea, {
      target: { value: "请把 @docs/notes.md 加入资料库" },
    });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(
        sentRpcCommands().some(
          (cmd) =>
            cmd.cmd === "library_add" &&
            (cmd.source as { path?: string } | undefined)?.path === "docs/notes.md",
        ),
      ).toBe(true);
    });
  });

  it("sends natural-language compaction requests to the backend for model intent detection", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap();

    const textarea = screen.getByPlaceholderText("Ask the agent / describe a task…");
    fireEvent.change(textarea, {
      target: { value: "帮我压缩上下文" },
    });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(
        sentRpcCommands().some((cmd) => cmd.cmd === "user_input" && cmd.text === "帮我压缩上下文"),
      ).toBe(true);
    });
    expect(sentRpcCommands().some((cmd) => cmd.cmd === "compact_history")).toBe(false);
  });

  it("routes slash context compaction requests to the compact RPC with visible feedback", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap();

    const textarea = screen.getByPlaceholderText("Ask the agent / describe a task…");
    fireEvent.change(textarea, {
      target: { value: "/compact" },
    });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(sentRpcCommands().some((cmd) => cmd.cmd === "compact_history")).toBe(true);
    });
    expect(sentRpcCommands().some((cmd) => cmd.cmd === "slash")).toBe(false);
    expect(screen.getByText(/folding older turns into a summary/i)).toBeTruthy();

    await emitRpc({
      type: "$compact_result",
      tabId: "tab-1",
      folded: true,
      beforeMessages: 12,
      afterMessages: 4,
      summaryChars: 3456,
    });

    expect(screen.getByText(/folded 12 messages/i)).toBeTruthy();
  });

  it("imports local files into the library from the library panel", async () => {
    vi.mocked(openDialog).mockResolvedValue([
      "/tmp/jupiter-streaming-test/docs/imported.pdf",
    ] as never);
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap();

    fireEvent.click(screen.getByText("Library"));
    fireEvent.click(screen.getByRole("button", { name: "Import files" }));

    await waitFor(() => {
      expect(
        sentRpcCommands().some(
          (cmd) =>
            cmd.cmd === "library_add" &&
            (cmd.source as { path?: string } | undefined)?.path === "docs/imported.pdf",
        ),
      ).toBe(true);
    });
  });

  it("keeps the library tab open when a saved web source opens in a new sidebar tab", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap();
    await emitRpc({
      type: "$library_sources",
      tabId: "tab-1",
      workspaceDir: "/tmp/jupiter-streaming-test",
      sources: [
        {
          id: "source-1",
          kind: "web",
          title: "NotebookLM",
          url: "https://notebooklm.google/",
          snippet: "AI notebook source grounding.",
          addedAt: 1,
        },
      ],
    });

    fireEvent.click(screen.getByText("Library"));
    fireEvent.click(screen.getByRole("button", { name: "Open source: NotebookLM" }));

    await waitFor(() => {
      expect(document.querySelector(".ctx")?.getAttribute("data-mode")).toBe("browser");
    });
    expect(within(document.querySelector(".ctx") as HTMLElement).getByText("Library")).toBeTruthy();

    clickContextTab("Library");
    fireEvent.click(screen.getByRole("button", { name: "Open source: NotebookLM" }));

    expect(contextTabTitles().filter((title) => title === "notebooklm.google")).toHaveLength(2);

    closeActiveContextTab();

    expect(document.querySelector(".ctx")?.getAttribute("data-mode")).toBe("library");
    expect(screen.getByRole("button", { name: "Open source: NotebookLM" })).toBeTruthy();
  });

  it("switches to an existing module tab instead of duplicating it", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap();

    fireEvent.click(screen.getByText("Library"));
    fireEvent.click(screen.getByRole("button", { name: "Add panel" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: "Add panel" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Library" }));

    expect(document.querySelector(".ctx")?.getAttribute("data-mode")).toBe("library");
    expect(contextTabTitles().filter((title) => title === "Library")).toHaveLength(1);
    expect(contextTabTitles()).toEqual(["Library", "Files"]);
  });

  it("opens the same saved file source in a new preview tab every time", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap();
    await emitRpc({
      type: "$library_sources",
      tabId: "tab-1",
      workspaceDir: "/tmp/jupiter-streaming-test",
      sources: [
        {
          id: "source-file-1",
          kind: "file",
          title: "notes.md",
          path: "docs/notes.md",
          snippet: "docs/notes.md",
          addedAt: 1,
        },
      ],
    });

    fireEvent.click(screen.getByText("Library"));
    fireEvent.click(screen.getByRole("button", { name: "Open source: notes.md" }));

    await waitFor(() => {
      expect(document.querySelector(".ctx")?.getAttribute("data-mode")).toBe("preview");
    });

    clickContextTab("Library");
    fireEvent.click(screen.getByRole("button", { name: "Open source: notes.md" }));

    await waitFor(() => {
      expect(contextTabTitles().filter((title) => title === "notes.md")).toHaveLength(2);
    });
  });

  it("returns to the previously active sidebar tab when closing the current one", async () => {
    render(<App />);

    await waitFor(() => expect(tauri.listeners.has("rpc:event")).toBe(true));
    await emitBootstrap();

    fireEvent.click(screen.getByText("Library"));
    fireEvent.click(screen.getByRole("button", { name: "Add panel" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: "Add panel" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminal" }));
    clickContextTab("Library");

    closeActiveContextTab();

    expect(document.querySelector(".ctx")?.getAttribute("data-mode")).toBe("terminal");
    expect(contextTabTitles()).toEqual(["Files", "Terminal"]);
  });
});
