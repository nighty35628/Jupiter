// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { forwardRef, useImperativeHandle, type ReactNode } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  handlers: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  invoke: vi.fn(async () => undefined),
  scrollToIndex: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(async () => undefined),
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = bridge.handlers.get(name) ?? new Set();
    handlers.add(handler); bridge.handlers.set(name, handlers);
    return () => { handlers.delete(handler); };
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  isFullscreen: async () => false, isMaximized: async () => false, isFocused: async () => true,
  setFullscreen: vi.fn(), toggleMaximize: vi.fn(), minimize: vi.fn(), close: vi.fn(),
  listen: async () => () => {},
}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn(() => ({ onDragDropEvent: async () => () => {} })) }));
vi.mock("./CommandPalette", () => ({ CommandPalette: () => null, Toast: () => null, buildCommands: () => [], useCommandPalette: () => ({ open: false, setOpen: vi.fn() }) }));
vi.mock("./Markdown", () => ({ WorkspaceProvider: ({ children }: { children: ReactNode }) => children, Markdown: ({ source }: { source: string }) => source }));
vi.mock("./ui/splash", () => ({ Splash: () => null, shouldShowSplash: () => false }));
vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function Transcript(props: {
    data: unknown[]; firstItemIndex?: number; itemContent: (index: number, item: unknown) => ReactNode;
    computeItemKey: (index: number, item: unknown) => string; scrollerRef: (node: HTMLElement | null) => void;
    context?: { historyControl: ReactNode };
  }, ref) {
    useImperativeHandle(ref, () => ({ scrollToIndex: bridge.scrollToIndex, scrollTo: vi.fn() }));
    return <div data-testid="shared-transcript" ref={props.scrollerRef}>
      {props.context?.historyControl}
      {props.data.map((row, index) => <div key={props.computeItemKey(index, row)}>{props.itemContent(index + (props.firstItemIndex ?? 0), row)}</div>)}
    </div>;
  }),
}));

import { App, TabBar } from "./App";
import { setLang, t } from "./i18n";
import { conversationDraftKey, readImageDraft, writeImageDraft } from "./ui/image-draft-store";

const commands = () => bridge.invoke.mock.calls.flatMap((args) => {
  const [cmd, payload] = args as unknown as [string, { line?: string }?];
  return cmd === "rpc_send" && payload?.line ? [JSON.parse(payload.line)] : [];
});
async function emit(event: Record<string, unknown>) {
  await act(async () => {
    for (const callback of bridge.handlers.get("rpc:event") ?? []) callback({ payload: { data: JSON.stringify(event) } });
    await Promise.resolve();
  });
}
const main = () => document.querySelector<HTMLElement>('.main:not([style*="display: none"])')!;
const composer = () => within(main()).getByRole("textbox") as HTMLTextAreaElement;
async function bootstrap(tabId: string, sessionId: string, conversationViewId: string, opts: { load?: boolean; defaultConversationViewId?: string } = {}) {
  await emit({ type: "$tab_opened", tabId, workspaceDir: "/tmp/shared-ui", active: true, sessionId, conversationViewId, sessionTitle: "Shared task" });
  await emit({ type: "$settings", tabId, workspaceDir: "/tmp/shared-ui", model: "mock", reasoningEffort: "high", editMode: "review", recentWorkspaces: [], version: "test" });
  if (opts.load !== false) await emit({ type: "$session_loaded", tabId, name: "shared-task", messages: [], runtimeReady: true,
    snapshot: { sessionId, conversationViewId, defaultConversationViewId: opts.defaultConversationViewId ?? (conversationViewId === "default" ? "default" : undefined), bindingId: 1, reason: "load", payloadBytes: 0, truncated: false },
    history: { generation: "g1", sourceSize: 0, totalTurns: 0, hasMore: false },
    sessionFiles: [], carryover: { totalCostUsd: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalCompletionTokens: 0 } });
}

beforeEach(() => {
  localStorage.clear(); bridge.handlers.clear(); bridge.invoke.mockClear(); bridge.scrollToIndex.mockClear();
  setLang("en");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) });
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(getCurrentWebview).mockReturnValue({ onDragDropEvent: async () => () => {} } as never);
});
afterEach(() => cleanup());

describe("shared tabs menu", { retry: 0 }, () => {
  it("keeps ordinary labels and numbers shared views; opens parallel from the clicked source tab", () => {
    const parallel = vi.fn();
    render(<TabBar tabs={[
      { id: "a", sessionId: "s", conversationViewId: "default", sessionTitle: "Shared task", workspaceDir: "/tmp/shared-ui" },
      { id: "b", sessionId: "s", conversationViewId: "v-b", sessionTitle: "Shared task", workspaceDir: "/tmp/shared-ui", busy: true },
      { id: "other", workspaceDir: "/tmp/ordinary" },
    ]} activeId="a" setActive={vi.fn()} onClose={vi.fn()} onNew={vi.fn()} onParallel={parallel} />);
    expect(screen.getByRole("tab", { name: "Shared task · Chat 1" }).querySelector(".tab-view-number")?.textContent).toBe("Chat 1");
    expect(screen.getByRole("tab", { name: "Shared task · Chat 2" }).querySelector(".tab-view-number")?.textContent).toBe("Chat 2");
    expect(screen.getByText("ordinary")).toBeTruthy();
    const source = screen.getByRole("tab", { name: "Shared task · Chat 2" });
    fireEvent.contextMenu(source, { clientX: 25, clientY: 25 });
    fireEvent.click(screen.getByRole("menuitem", { name: t("app.tab.parallel") }));
    expect(parallel).toHaveBeenCalledTimes(1);
    expect(parallel).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("supports keyboard menu, escape focus restoration, and disables unresolved identities", () => {
    const props = { activeId: "a", setActive: vi.fn(), onClose: vi.fn(), onNew: vi.fn(), onParallel: vi.fn() };
    const rendered = render(<TabBar {...props} tabs={[{ id: "a", workspaceDir: "/tmp/unresolved" }]} />);
    const tab = screen.getByRole("tab");
    tab.focus(); fireEvent.keyDown(tab, { key: "F10", shiftKey: true });
    expect((screen.getByRole("menuitem") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(tab);
    rendered.unmount();
  });
});

describe("shared tabs real App routing", { retry: 0 }, () => {
  it.each(["default", "123e4567-e89b-12d3-a456-426614174000"])("does not persist an empty placeholder or let a parallel view claim a late default draft (%s)", async (view) => {
    const sid = crypto.randomUUID();
    writeImageDraft(sid, () => ({ text: "legacy text", queue: [{ text: "queued once", payload: { clientId: "late-once" } }] }));
    render(<App />); await waitFor(() => expect(bridge.handlers.has("rpc:event")).toBe(true));
    await bootstrap("a", sid, view, { load: false });
    await emit({ type: "$ready", tabId: "a" });
    expect(localStorage.getItem(`jupiter.image-draft.v1:${conversationDraftKey(sid, view)}`)).toBeNull();
    expect(commands().filter((cmd) => cmd.cmd === "user_input")).toHaveLength(0);
    await bootstrap("b", sid, "parallel-uuid", { defaultConversationViewId: view });
    expect(composer().value).toBe("");
    expect(commands().filter((cmd) => cmd.cmd === "user_input")).toHaveLength(0);
    fireEvent.click(screen.getByRole("tab", { name: "Shared task · Chat 1" }));
    await emit({ type: "$session_loaded", tabId: "a", name: "shared-task", runtimeReady: true, busy: true, messages: [],
      snapshot: { sessionId: sid, conversationViewId: view, defaultConversationViewId: view, bindingId: 1, reason: "resync", payloadBytes: 0, truncated: false },
      history: { generation: "g1", sourceSize: 0, totalTurns: 0, hasMore: false },
      sessionFiles: [], carryover: { totalCostUsd: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalCompletionTokens: 0 } });
    expect(composer().value).toBe("legacy text");
    await emit({ type: "$turn_complete", tabId: "a" });
    await waitFor(() => expect(commands().filter((cmd) => cmd.cmd === "user_input")).toHaveLength(1));
    expect(commands().find((cmd) => cmd.cmd === "user_input")).toMatchObject({ tabId: "a", clientId: "late-once", text: "queued once" });
  });

  it("hands off new-tab drafts to a UUID view independently of legacy ownership", async () => {
    const sid = crypto.randomUUID();
    const view = crypto.randomUUID();
    render(<App />); await waitFor(() => expect(bridge.handlers.has("rpc:event")).toBe(true));
    await emit({ type: "$tab_opened", tabId: "fresh-uuid", workspaceDir: "/tmp/shared-ui", active: true });
    await emit({ type: "$settings", tabId: "fresh-uuid", workspaceDir: "/tmp/shared-ui", model: "mock", recentWorkspaces: [], editMode: "review", reasoningEffort: "high", version: "test" });
    await emit({ type: "$ready", tabId: "fresh-uuid" });
    fireEvent.change(composer(), { target: { value: "first question" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(commands().some((cmd) => cmd.cmd === "user_input")).toBe(true));
    fireEvent.change(composer(), { target: { value: "next UUID draft" } });
    writeImageDraft(sid, () => ({ text: "legacy belongs to another view" }));
    await emit({ type: "$turn_committed", tabId: "fresh-uuid", name: `fresh-${sid}`, sessionId: sid, bindingId: 1, turn: 1, conversationViewId: view,
      sessionFiles: [], carryover: { totalCostUsd: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalCompletionTokens: 0 } });
    expect(composer().value).toBe("next UUID draft");
    expect(readImageDraft(conversationDraftKey(sid, view)).text).toBe("next UUID draft");
    expect(readImageDraft(sid).text).toBe("legacy belongs to another view");
    expect(localStorage.getItem(`jupiter.image-draft.migrated:${sid}`)).toBeNull();
  });

  it("preserves locally queued messages while the default owner is still unknown", async () => {
    const sid = crypto.randomUUID();
    const view = crypto.randomUUID();
    render(<App />); await waitFor(() => expect(bridge.handlers.has("rpc:event")).toBe(true));
    await bootstrap("a", sid, view, { load: false });
    await emit({ type: "$ready", tabId: "a" });
    await emit({ type: "user.message", tabId: "a", id: 1, turn: 1, turnId: "running", conversationViewId: view, text: "running" });
    fireEvent.change(composer(), { target: { value: "queued while identity pending" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(readImageDraft(conversationDraftKey(sid, view)).queue).toEqual([
      expect.objectContaining({ text: "queued while identity pending" }),
    ]);
    await emit({ type: "$session_loaded", tabId: "a", name: "shared-task", runtimeReady: true, busy: true, messages: [],
      snapshot: { sessionId: sid, conversationViewId: view, defaultConversationViewId: view, bindingId: 1, reason: "resync", payloadBytes: 0, truncated: false },
      history: { generation: "g1", sourceSize: 0, totalTurns: 0, hasMore: false },
      sessionFiles: [], carryover: { totalCostUsd: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalCompletionTokens: 0 } });
    await emit({ type: "$turn_complete", tabId: "a" });
    await waitFor(() => expect(commands().filter((cmd) => cmd.cmd === "user_input")).toHaveLength(1));
    expect(commands().find((cmd) => cmd.cmd === "user_input").text).toBe("queued while identity pending");
  });

  it("hands off a local draft even when session and view identities arrive separately", async () => {
    const sid = crypto.randomUUID();
    const view = crypto.randomUUID();
    render(<App />); await waitFor(() => expect(bridge.handlers.has("rpc:event")).toBe(true));
    await emit({ type: "$tab_opened", tabId: "partial-identity", workspaceDir: "/tmp/shared-ui", active: true });
    await emit({ type: "$ready", tabId: "partial-identity" });
    fireEvent.change(composer(), { target: { value: "draft before full identity" } });
    await emit({ type: "$tab_opened", tabId: "partial-identity", workspaceDir: "/tmp/shared-ui", sessionId: sid, active: true });
    expect(composer().value).toBe("draft before full identity");
    await emit({ type: "$tab_opened", tabId: "partial-identity", workspaceDir: "/tmp/shared-ui", sessionId: sid, conversationViewId: view, active: true });
    expect(composer().value).toBe("draft before full identity");
    expect(readImageDraft(conversationDraftKey(sid, view)).text).toBe("draft before full identity");
  });

  it("keeps an optimistic user-only turn contiguous through a foreign commit and its first delta", async () => {
    const sid = crypto.randomUUID();
    render(<App />); await waitFor(() => expect(bridge.handlers.has("rpc:event")).toBe(true));
    await bootstrap("a", sid, "default");
    fireEvent.change(composer(), { target: { value: "question A awaiting first token" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(commands().some((cmd) => cmd.cmd === "user_input")).toBe(true));
    const clientId = commands().find((cmd) => cmd.cmd === "user_input").clientId;
    await emit({ type: "$session_loaded", tabId: "a", name: "shared-task", busy: true, runtimeReady: true,
      snapshot: { sessionId: sid, conversationViewId: "default", bindingId: 1, reason: "resync", payloadBytes: 0, truncated: false },
      history: { generation: "g1", totalTurns: 1, sourceSize: 100, hasMore: false },
      messages: [{ kind: "user", text: "question B completed first", turn: 1, turnId: "B", conversationViewId: "view-b", messageId: "uB" },
        { kind: "assistant", turn: 1, turnId: "B", conversationViewId: "view-b", messageId: "aB", pending: false, segments: [{ kind: "text", text: "foreign folded" }] }],
      sessionFiles: [], carryover: { totalCostUsd: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalCompletionTokens: 0 } });
    const questions = () => [...main().querySelectorAll("[data-turn]")].filter((node) => node.textContent?.includes("question ")).map((node) => node.textContent);
    expect(questions()).toHaveLength(2);
    expect(questions()[0]).toContain("question B completed first");
    expect(questions()[1]).toContain("question A awaiting first token");
    await emit({ type: "user.message", tabId: "a", id: 1, turn: 1, clientId, turnId: "A", conversationViewId: "default", text: "question A awaiting first token" });
    await emit({ type: "model.delta", tabId: "a", id: 2, turn: 1, turnId: "A", conversationViewId: "default", channel: "content", text: "first A token" });
    expect(main().textContent).toContain("first A token");
    expect(screen.queryByText("foreign folded")).toBeNull();
  });
  it("folds completed foreign replies without changing the shared history or own replies", async () => {
    const sid = crypto.randomUUID();
    render(<App />); await waitFor(() => expect(bridge.handlers.has("rpc:event")).toBe(true));
    await bootstrap("a", sid, "default");
    await emit({ type: "$session_loaded", tabId: "a", name: "shared-task", runtimeReady: true,
      snapshot: { sessionId: sid, conversationViewId: "default", bindingId: 1, reason: "resync", payloadBytes: 0, truncated: false },
      history: { generation: "g1", totalTurns: 2, sourceSize: 200, hasMore: false },
      messages: [
        { kind: "user", text: "own question", turn: 1, turnId: "own", conversationViewId: "default", messageId: "u-own" },
        { kind: "assistant", turn: 1, turnId: "own", conversationViewId: "default", messageId: "a-own", pending: false, segments: [{ kind: "text", text: "own answer stays visible" }] },
        { kind: "user", text: "foreign question", turn: 2, turnId: "other", conversationViewId: "view-b", messageId: "u-other" },
        { kind: "assistant", turn: 2, turnId: "other", conversationViewId: "view-b", messageId: "a-other", pending: false, segments: [{ kind: "text", text: "foreign answer folds initially" }] },
      ], sessionFiles: [], carryover: { totalCostUsd: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalCompletionTokens: 0 },
    });
    expect(screen.getByText("own answer stays visible")).toBeTruthy();
    expect(screen.queryByText("foreign answer folds initially")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show reply|查看回复/ }));
    expect(screen.getByText("foreign answer folds initially")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Hide reply|收起回复/ }));
    expect(screen.queryByText("foreign answer folds initially")).toBeNull();
    expect(commands().some((command) => command.cmd === "session_load")).toBe(false);
  });
  it("keeps drafts independent and sends tab_parallel to its source without changing new-tab behavior", async () => {
    const sid = crypto.randomUUID();
    writeImageDraft(sid, () => ({ text: "legacy draft" }));
    render(<App />);
    await waitFor(() => expect(bridge.handlers.has("rpc:event")).toBe(true));
    await bootstrap("a", sid, "default");
    expect(composer().value).toBe("legacy draft");
    fireEvent.change(composer(), { target: { value: "draft A" } });
    fireEvent.contextMenu(screen.getByRole("tab"), { clientX: 15, clientY: 15 });
    fireEvent.click(screen.getByRole("menuitem", { name: t("app.tab.parallel") }));
    await waitFor(() => expect(commands()).toContainEqual({ cmd: "tab_parallel", tabId: "a" }));
    await bootstrap("b", sid, "v-b");
    expect(composer().value).toBe("");
    fireEvent.change(composer(), { target: { value: "draft B" } });
    fireEvent.click(screen.getByRole("tab", { name: "Shared task · Chat 1" }));
    expect(composer().value).toBe("draft A");
    expect(readImageDraft(conversationDraftKey(sid, "v-b")).text).toBe("draft B");
    fireEvent.click(screen.getByText(t("app.tab.newTab")));
    await waitFor(() => expect(commands().some((cmd) => cmd.cmd === "tab_open")).toBe(true));
  });
  it("shared notices and resync do not clear another view's live reply, approval or draft", async () => {
    const sid = crypto.randomUUID();
    render(<App />); await waitFor(() => expect(bridge.handlers.has("rpc:event")).toBe(true));
    await bootstrap("a", sid, "default");
    await emit({ type: "user.message", tabId: "a", id: 1, turn: 1, text: "running A", turnId: "A", conversationViewId: "default" });
    await emit({ type: "model.delta", tabId: "a", id: 2, turn: 1, text: "stream A", channel: "content", turnId: "A", conversationViewId: "default" });
    await emit({ type: "$confirm_required", tabId: "a", id: 7, kind: "run_command", command: "echo A",
      prompt: { id: 7, kind: "shell", tone: "warn", title: "Confirm command", subtitle: "echo A", preview: "echo A", data: { prefix: "echo" }, actions: [
        { id: "allow", kind: "allow_once", label: "Run once" }, { id: "deny", kind: "reject", label: "Deny" },
      ] } });
    fireEvent.change(composer(), { target: { value: "next draft" } });
    const transcript = screen.getByTestId("shared-transcript");
    bridge.scrollToIndex.mockClear();
    await emit({ type: "$shared_session_updated", tabId: "a", sessionId: sid, historyVersion: 2, sourceViewId: "v-b", sourceTurnId: "B" });
    expect(composer().value).toBe("next draft");
    expect(main().textContent).toContain(t("app.tab.sharedUpdatedWhileRunning"));
    await emit({ type: "$session_loaded", tabId: "a", name: "shared-task", runtimeReady: true,
      snapshot: { sessionId: sid, conversationViewId: "default", bindingId: 1, reason: "resync", historyVersion: 2, payloadBytes: 0, truncated: false },
      history: { generation: "g1", sourceSize: 100, totalTurns: 1, hasMore: false },
      messages: [{ kind: "user", messageId: "uB", turn: 1, turnId: "B", conversationViewId: "v-b", text: "finished B" },
        { kind: "assistant", messageId: "aB", turn: 1, turnId: "B", conversationViewId: "v-b", segments: [{ kind: "text", text: "answer B" }], pending: false }],
      sessionFiles: [], carryover: { totalCostUsd: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalCompletionTokens: 0 } });
    expect(main().textContent).toContain("stream A");
    expect(main().textContent).not.toContain("answer B");
    fireEvent.click(screen.getByRole("button", { name: /Show reply|查看回复/ }));
    expect(main().textContent).toContain("answer B");
    expect(main().textContent).toContain("echo A");
    expect(composer().value).toBe("next draft");
    expect(screen.getByTestId("shared-transcript")).toBe(transcript);
    expect(main().querySelectorAll('[data-conversation-view-id="v-b"]')).toHaveLength(1);
    await emit({ type: "model.delta", tabId: "a", id: 3, turn: 1, turnId: "A", conversationViewId: "default", channel: "content", text: " continued" });
    expect(main().textContent).toContain("stream A continued");
    expect(main().textContent).toContain("answer B");
  });
  it("does not replay a legacy queue until its default view identity is known", async () => {
    const sid = crypto.randomUUID();
    writeImageDraft(sid, () => ({ text: "", queue: [{ text: "queued once", payload: { clientId: "old-client" } }] }));
    render(<App />); await waitFor(() => expect(bridge.handlers.has("rpc:event")).toBe(true));
    await emit({ type: "$tab_opened", tabId: "a", workspaceDir: "/tmp/shared-ui", sessionId: sid, active: true });
    await emit({ type: "$ready", tabId: "a" });
    expect(commands().filter((cmd) => cmd.cmd === "user_input")).toHaveLength(0);
    await bootstrap("b", sid, "v-b");
    expect(commands().filter((cmd) => cmd.cmd === "user_input")).toHaveLength(0);
    await bootstrap("a", sid, "default");
    await waitFor(() => expect(commands().filter((cmd) => cmd.cmd === "user_input")).toHaveLength(1));
    expect(commands().find((cmd) => cmd.cmd === "user_input")).toMatchObject({ text: "queued once", clientId: "old-client", tabId: "a" });
  });
  it("keeps a new tab's next draft when its first turn assigns the session identity", async () => {
    const sid = crypto.randomUUID();
    render(<App />); await waitFor(() => expect(bridge.handlers.has("rpc:event")).toBe(true));
    await emit({ type: "$tab_opened", tabId: "fresh", workspaceDir: "/tmp/shared-ui", active: true });
    await emit({ type: "$settings", tabId: "fresh", workspaceDir: "/tmp/shared-ui", model: "mock", recentWorkspaces: [], editMode: "review", reasoningEffort: "high", version: "test" });
    await emit({ type: "$ready", tabId: "fresh" });
    fireEvent.change(composer(), { target: { value: "first question" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(commands().some((cmd) => cmd.cmd === "user_input")).toBe(true));
    fireEvent.change(composer(), { target: { value: "next draft while running" } });
    await emit({ type: "$turn_committed", tabId: "fresh", name: `fresh-${sid}`, sessionId: sid, bindingId: 1, turn: 1, conversationViewId: "default",
      sessionFiles: [], carryover: { totalCostUsd: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalCompletionTokens: 0 } });
    expect(composer().value).toBe("next draft while running");
    expect(readImageDraft(conversationDraftKey(sid, "default")).text).toBe("next draft while running");
  });
});
