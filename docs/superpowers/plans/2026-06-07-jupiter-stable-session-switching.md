# Jupiter Stable Session Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make conversation/session switching stable while an agent turn is running: the left sidebar must not remount or reset scroll, and an in-flight conversation must keep streamed text, process cards, thinking state, tool calls, and stop state when switched away and back.

**Architecture:** Move navigation chrome ownership from per-tab runtime toward App-level ownership. Keep the heavy conversation/runtime state inside each existing `TabRuntime`, but report a small active-tab snapshot to `App`; render one singleton left `Sidebar` in the App shell and route its commands to the active tab through one serialized RPC queue. On the backend, make session-to-tab focus robust enough that selecting an already-open session focuses the in-memory tab and never reloads a disk snapshot.

**Tech Stack:** React 19, TypeScript, Vitest/jsdom, Tauri RPC (`invoke("rpc_send")`), Node desktop sidecar in `src/cli/commands/desktop.ts`.

---

## Current Diagnosis

Direct tab switching works because it changes `activeTabId` among already-mounted `TabRuntime` instances.

Running-turn sidebar navigation behaves differently. When the active tab is busy, `session_load` is sent with `openInNewTab: true` or hits the backend `tab.aborter` branch. That moves focus to another tab or opens a new one. Because `Sidebar` is currently rendered inside each `TabRuntime`, switching tabs swaps the entire sidebar DOM instance, resetting scroll and local UI state.

The in-flight text/process loss is a separate but related invariant failure: when selecting a session that is already open, the app must focus the tab that owns that in-memory session. If it instead calls `loadSessionIntoTab()`, it replaces live frontend state with the current disk snapshot. Half-streamed output is not guaranteed to be in that snapshot yet, so it disappears.

## File Structure

- Modify `desktop/src/App.tsx`
  - Add `TabRuntimeSnapshot` and `TabRuntimeControls` types.
  - Add App-level per-tab RPC serialization helper.
  - Add App-level global sidebar/session/import source state.
  - Add `onRuntimeSnapshot` prop to `TabRuntime`.
  - Remove `Sidebar` from `TabRuntimeInner`.
  - Render one singleton `Sidebar` from `App`.
  - Render tab-specific main/context/bottom surfaces inside one shared shell.

- Modify `desktop/src/styles.css`
  - Keep existing `.app` grid semantics.
  - Add minimal styles only if needed for a new `.tab-runtime-surfaces` wrapper.
  - Do not restyle sidebar or conversation UI beyond structural placement.

- Modify `desktop/src/App.streaming.test.tsx`
  - Add regression for sidebar DOM/scroll persistence across busy session switch.
  - Add regression for live streamed content and stop button preservation when switching away and back through sidebar.
  - Update existing tests to wait for serialized RPC flush where needed.

- Modify `tests/desktop-busy-navigation.test.ts`
  - Strengthen backend source assertions so `session_load` tries existing-session focus before any disk snapshot load.

- Modify `src/cli/commands/desktop.ts`
  - Make `findOpenSessionTab` match by session first, and use workspace only as a tie-breaker.
  - Add diagnostic-safe helper `findOpenSessionTabs(session)` if needed.
  - Ensure `session_load` never calls `loadSessionIntoTab` if any open tab already owns the target session.

---

## Task 1: Lock The Current Bug With UI Regression Tests

**Files:**
- Modify: `desktop/src/App.streaming.test.tsx`

- [ ] **Step 1: Write failing test for singleton sidebar scroll/state**

Add this test near the existing App streaming/session tests:

```tsx
it("keeps the same sidebar instance and scroll position when busy navigation switches tabs", async () => {
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

  const sidebar = document.querySelector(".sidebar") as HTMLElement;
  expect(sidebar).toBeTruthy();
  const list = sidebar.querySelector(".session-list") as HTMLElement;
  expect(list).toBeTruthy();
  list.scrollTop = 240;

  fireEvent.click(screen.getByText("Target old chat").closest(".session-item") as HTMLElement);
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

  expect(document.querySelector(".sidebar")).toBe(sidebar);
  expect((sidebar.querySelector(".session-list") as HTMLElement).scrollTop).toBe(240);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- --run desktop/src/App.streaming.test.tsx -t "same sidebar instance"
```

Expected: FAIL because the active tab switch exposes a different `.sidebar` instance or resets the session list scroll.

- [ ] **Step 3: Write failing test for live state preservation through sidebar switch-back**

Add this test near the previous one:

```tsx
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

  fireEvent.click(screen.getByText("Other chat").closest(".session-item") as HTMLElement);
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

  fireEvent.click(screen.getByText("Running chat").closest(".session-item") as HTMLElement);
  await emitRpc({
    type: "$tab_opened",
    tabId: "tab-running",
    workspaceDir: "/tmp/ws",
    active: true,
    busy: true,
  });

  expect(activeApp().textContent).toContain("half streamed answer");
  expect(within(activeApp()).getByTitle("stop")).toBeTruthy();
});
```

- [ ] **Step 4: Run test to verify it fails before implementation**

Run:

```bash
npm test -- --run desktop/src/App.streaming.test.tsx -t "restores a running session"
```

Expected: FAIL if sidebar click reloads a snapshot, changes active DOM shell, or loses the running tab state.

---

## Task 2: Add App-Level Runtime Snapshots

**Files:**
- Modify: `desktop/src/App.tsx`
- Test: `desktop/src/App.streaming.test.tsx`

- [ ] **Step 1: Define the snapshot type**

Add near `type TabMeta`:

```ts
type TabRuntimeSnapshot = {
  currentSession?: string;
  busy: boolean;
  sessions: SessionInfo[];
  importSources: ExternalSessionApp[];
  workspaceDir?: string;
  recentWorkspaces: string[];
  model?: string;
  hasMessages: boolean;
};
```

- [ ] **Step 2: Add App state for runtime snapshots**

Inside `App()` after `tabsRef`:

```ts
const [runtimeSnapshots, setRuntimeSnapshots] = useState<Record<string, TabRuntimeSnapshot>>({});
const activeRuntimeSnapshot = activeTabId ? runtimeSnapshots[activeTabId] : undefined;
```

- [ ] **Step 3: Add callback prop to `TabRuntimeProps`**

Add:

```ts
onRuntimeSnapshot: (tabId: string, snapshot: TabRuntimeSnapshot) => void;
```

Wire it through `TabRuntimeInner` parameters.

- [ ] **Step 4: Report snapshot from `TabRuntimeInner`**

Inside `TabRuntimeInner`, after state-derived values exist:

```ts
useEffect(() => {
  onRuntimeSnapshot(tabId, {
    currentSession: state.currentSession,
    busy: state.busy,
    sessions: state.sessions,
    importSources: state.externalImportSources,
    workspaceDir: state.settings?.workspaceDir,
    recentWorkspaces: state.settings?.recentWorkspaces ?? [],
    model: state.settings?.model,
    hasMessages: state.messages.length > 0,
  });
}, [
  tabId,
  onRuntimeSnapshot,
  state.currentSession,
  state.busy,
  state.sessions,
  state.externalImportSources,
  state.settings?.workspaceDir,
  state.settings?.recentWorkspaces,
  state.settings?.model,
  state.messages.length,
]);
```

- [ ] **Step 5: Store snapshots in App**

Inside `App()`:

```ts
const onRuntimeSnapshot = useCallback((tabId: string, snapshot: TabRuntimeSnapshot) => {
  setRuntimeSnapshots((prev) => {
    const current = prev[tabId];
    if (
      current &&
      current.currentSession === snapshot.currentSession &&
      current.busy === snapshot.busy &&
      current.sessions === snapshot.sessions &&
      current.importSources === snapshot.importSources &&
      current.workspaceDir === snapshot.workspaceDir &&
      current.recentWorkspaces === snapshot.recentWorkspaces &&
      current.model === snapshot.model &&
      current.hasMessages === snapshot.hasMessages
    ) {
      return prev;
    }
    return { ...prev, [tabId]: snapshot };
  });
}, []);
```

When closing a tab, also delete its snapshot:

```ts
setRuntimeSnapshots((prev) => {
  const next = { ...prev };
  delete next[tabId];
  return next;
});
```

- [ ] **Step 6: Pass `onRuntimeSnapshot` into each `TabRuntime`**

Add:

```tsx
onRuntimeSnapshot={onRuntimeSnapshot}
```

- [ ] **Step 7: Run existing tests**

Run:

```bash
npm test -- --run desktop/src/App.streaming.test.tsx
```

Expected: existing tests still pass; new sidebar singleton tests still fail because rendering has not moved yet.

---

## Task 3: Move RPC Serialization To App-Level Helper

**Files:**
- Modify: `desktop/src/App.tsx`
- Test: `desktop/src/App.streaming.test.tsx`

- [ ] **Step 1: Add shared App-level `sendRpcToTab`**

Inside `App()` near `deliverToTab`:

```ts
const rpcSendQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
const sendRpcToTab = useCallback((tabId: string, cmd: OutgoingCommand) => {
  const payload = { tabId, ...cmd };
  const line = JSON.stringify(payload);
  const write = (): Promise<void> =>
    invoke("rpc_send", { line })
      .then(() => undefined)
      .catch((err) => {
        console.error(`${cmd.cmd} failed`, err);
      });
  const previous = rpcSendQueuesRef.current.get(tabId) ?? Promise.resolve();
  const next = previous.then(write, write);
  rpcSendQueuesRef.current.set(tabId, next.catch(() => undefined));
}, []);
```

When closing a tab, also:

```ts
rpcSendQueuesRef.current.delete(tabId);
```

- [ ] **Step 2: Pass `sendRpcToTab` into `TabRuntime`**

Update `TabRuntimeProps`:

```ts
sendRpcToTab: (tabId: string, cmd: OutgoingCommand) => void;
```

Inside `TabRuntimeInner`, replace the local queue-based `sendRpc` body with:

```ts
const sendRpc = useCallback(
  (cmd: OutgoingCommand) => sendRpcToTab(tabId, cmd),
  [sendRpcToTab, tabId],
);
```

Remove the per-`TabRuntime` `rpcSendQueueRef`.

- [ ] **Step 3: Keep non-tab App-level commands direct**

Do not route `desktop_resync`, `tab_open`, `tab_close`, or `tab_activate` through this helper in this task. They are App-level commands and are not part of the per-tab user-input/session-load ordering bug.

Keep the existing `invoke("rpc_send", { line: JSON.stringify({ cmd: "tab_activate", tabId: activeTabId }) })` effect unchanged.

- [ ] **Step 4: Run RPC serialization regression**

Run:

```bash
npm test -- --run desktop/src/App.streaming.test.tsx -t "serializes rpc sends"
```

Expected: PASS.

---

## Task 4: Extract One App-Owned Shell And Singleton Sidebar

**Files:**
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/styles.css` if layout wrapper is needed
- Test: `desktop/src/App.streaming.test.tsx`

- [ ] **Step 1: Add App-level sidebar model**

Inside `App()`:

```ts
const sidebarSnapshot = activeRuntimeSnapshot;
const sidebarSessions = sidebarSnapshot?.sessions ?? [];
const sidebarImportSources = sidebarSnapshot?.importSources ?? [];
const sidebarWorkspaceDir = sidebarSnapshot?.workspaceDir;
const sidebarRecentWorkspaces = sidebarSnapshot?.recentWorkspaces ?? [];
const sidebarActiveName = sidebarSnapshot?.currentSession;
const activeBusy = tabs.find((tab) => tab.id === activeTabId)?.busy ?? sidebarSnapshot?.busy ?? false;
```

- [ ] **Step 2: Add App-level handlers**

Inside `App()`:

```ts
const loadSessionFromSidebar = useCallback(
  (name: string) => {
    if (!activeTabId) return;
    sendRpcToTab(activeTabId, {
      cmd: "session_load",
      name,
      openInNewTab: activeBusy,
    });
  },
  [activeTabId, activeBusy, sendRpcToTab],
);

const newChatFromSidebar = useCallback(
  (workspaceDir?: string) => {
    if (!activeTabId) return;
    sendRpcToTab(activeTabId, {
      cmd: "new_chat",
      workspaceDir,
      openInNewTab: activeBusy,
    });
  },
  [activeTabId, activeBusy, sendRpcToTab],
);
```

Also add handlers for delete, rename, scan/import:

```ts
const deleteSessionFromSidebar = useCallback(
  (name: string) => {
    if (activeTabId) sendRpcToTab(activeTabId, { cmd: "session_delete", name });
  },
  [activeTabId, sendRpcToTab],
);

const renameSessionFromSidebar = useCallback(
  (name: string, title: string) => {
    if (activeTabId) sendRpcToTab(activeTabId, { cmd: "session_rename", name, title });
  },
  [activeTabId, sendRpcToTab],
);
```

- [ ] **Step 3: Remove the current `Sidebar` block from `TabRuntimeInner`**

Delete the current `<Sidebar>` block inside `TabRuntimeInner`; it starts with `<Sidebar` and passes `sessions={state.sessions}`, `importSources={state.externalImportSources}`, `activeName={state.currentSession}`, and `workspaceDir={state.settings?.workspaceDir}`.

Also remove the outer `.app` wrapper from `TabRuntimeInner`. `TabRuntimeInner` must no longer render:

```tsx
<div className="app">
```

It should return only the grid-area children that belong to that tab:

Keep the existing `TitleBar` JSX and `TabBar` JSX unchanged, but wrap each block with an `active` conditional so inactive runtimes do not render title or tab chrome.

Keep the existing `<main className="main" style={{ position: "relative" }}>` block unchanged, but add active display control:

```tsx
<main
  className="main"
  style={{ display: active ? undefined : "none", position: "relative" }}
>
```

Keep the existing right panel, bottom resize handle, `ContextPanel`, `SettingsStatusCard`, `CommandPalette`, `WorkdirPop`, `AboutModal`, `SettingsModal`, `JobsPop`, `Toast`, `AppContextMenu`, and `Splash` JSX inside `TabRuntimeInner`, but render tab-local overlays only when `active` is true. The unchanged blocks currently appear after the `ContextPanel` block and before `</div>` in `TabRuntimeInner`.

Keep TitleBar/TabBar inside `TabRuntimeInner` for this change because their handlers depend on tab-local state. They are rendered only for the active tab, so they do not create duplicate visible chrome.

- [ ] **Step 4: Move the `.app` grid shell to `App`**

Replace the current `App()` return:

```tsx
return (
  <>
    <div
      className="app"
      data-theme={theme}
      data-theme-style={themeStyle}
      data-side-collapsed={sideCollapsed}
      data-ctx-collapsed={ctxCollapsed}
      data-bottom-collapsed={bottomCollapsed}
      data-context-info-open={activeContextInfoOpen}
      style={{
        ["--side-width" as string]: sideCollapsed ? "0px" : `${sideWidth}px`,
        ["--ctx-width" as string]:
          ctxCollapsed && !activeContextInfoOpen ? "0px" : `${ctxWidth}px`,
        ["--bottom-height" as string]: bottomCollapsed ? "0px" : `${bottomHeight}px`,
        ["--thread-max-width" as string]: `${threadMaxWidth}px`,
        ["--composer-max-width" as string]: `${threadMaxWidth}px`,
      }}
    >
      <Sidebar
        sessions={sidebarSessions}
        importSources={sidebarImportSources}
        activeName={sidebarActiveName}
        workspaceDir={sidebarWorkspaceDir}
        recentWorkspaces={sidebarRecentWorkspaces}
        onNewChat={newChatFromSidebar}
        onLoadSession={loadSessionFromSidebar}
        onDeleteSession={deleteSessionFromSidebar}
        onRenameSession={renameSessionFromSidebar}
        onRefreshImportSources={refreshImportSourcesFromSidebar}
        onImportDetectedSessions={importDetectedSessionsFromSidebar}
        onImportSession={importSessionFromSidebar}
        onOpenSettings={openActiveSettingsCardFromSidebar}
        onOpenCommands={openActiveCommandPaletteFromSidebar}
      />
      {!sideCollapsed ? (
        <div
          className="resize-handle"
          data-side="left"
          data-dragging={undefined}
          onMouseDown={onSideResizeDown}
        />
      ) : null}
      {tabs.map((t) => (
        <TabRuntime
          key={t.id}
          tabId={t.id}
          active={t.id === activeTabId}
        />
      ))}
    </div>
    {pendingUpdate ? (
      <UpdateOverlay
        version={pendingUpdate.version}
        currentVersion={pendingUpdate.currentVersion}
        status={updateStatus}
        progress={updateProgress}
        onInstall={installUpdate}
        onDismiss={() => setPendingUpdate(null)}
      />
    ) : null}
  </>
);
```

`activeContextInfoOpen` and `threadMaxWidth` are currently tab-local. For this task, expose them through `TabRuntimeSnapshot`:

```ts
contextInfoOpen: boolean;
threadMaxWidth: number;
```

Report them from `TabRuntimeInner` and use:

```ts
const activeContextInfoOpen = activeRuntimeSnapshot?.contextInfoOpen ?? false;
const threadMaxWidth = Math.round(
  Math.max(
    720,
    Math.min(
      1120,
      viewportWidth - (sideCollapsed ? 0 : sideWidth) - (ctxCollapsed ? 0 : ctxWidth) - 160,
    ),
  ),
);
```

If the existing local `threadMaxWidth` expression differs, keep the existing expression in `App` and remove the duplicate from `TabRuntimeInner`.

- [ ] **Step 5: Render singleton Sidebar directly in App**

Inside `App()` before `return`:

```tsx
const singletonSidebar = (
  <Sidebar
    sessions={sidebarSessions}
    importSources={sidebarImportSources}
    activeName={sidebarActiveName}
    workspaceDir={sidebarWorkspaceDir}
    recentWorkspaces={sidebarRecentWorkspaces}
    onNewChat={newChatFromSidebar}
    onLoadSession={loadSessionFromSidebar}
    onDeleteSession={deleteSessionFromSidebar}
    onRenameSession={renameSessionFromSidebar}
    onRefreshImportSources={() => activeTabId && sendRpcToTab(activeTabId, { cmd: "session_import_scan" })}
    onImportDetectedSessions={(sources) =>
      activeTabId && sendRpcToTab(activeTabId, { cmd: "session_import_bulk", sources })
    }
    onImportSession={({ source, path, name }) =>
      activeTabId &&
      sendRpcToTab(activeTabId, {
        cmd: "session_import",
        source,
        path,
        ...(name ? { name } : {}),
      })
    }
    onOpenSettings={() => activeTabId && runtimeControlsRef.current.get(activeTabId)?.openSettingsCard()}
    onOpenCommands={() => activeTabId && runtimeControlsRef.current.get(activeTabId)?.openCommandPalette()}
  />
);
```

Add runtime controls registration:

```ts
type TabRuntimeControls = {
  openSettingsCard: () => void;
  openCommandPalette: () => void;
};
```

Add to `TabRuntimeProps`:

```ts
registerRuntimeControls: (tabId: string, controls: TabRuntimeControls | null) => void;
```

Inside `TabRuntimeInner`:

```ts
useEffect(() => {
  registerRuntimeControls(tabId, {
    openSettingsCard: () => setSettingsCardOpen((open) => !open),
    openCommandPalette: () => palette.setOpen(true),
  });
  return () => registerRuntimeControls(tabId, null);
}, [tabId, registerRuntimeControls, palette]);
```

Inside `App()`:

```ts
const runtimeControlsRef = useRef<Map<string, TabRuntimeControls>>(new Map());
const registerRuntimeControls = useCallback((tabId: string, controls: TabRuntimeControls | null) => {
  if (controls) runtimeControlsRef.current.set(tabId, controls);
  else runtimeControlsRef.current.delete(tabId);
}, []);
```

Pass `registerRuntimeControls={registerRuntimeControls}` into each `TabRuntime`.

- [ ] **Step 6: Run sidebar regression**

Run:

```bash
npm test -- --run desktop/src/App.streaming.test.tsx -t "same sidebar instance"
```

Expected: PASS.

---

## Task 5: Make Backend Session Focus Workspace-Tolerant

**Files:**
- Modify: `src/cli/commands/desktop.ts`
- Modify: `tests/desktop-busy-navigation.test.ts`

- [ ] **Step 1: Strengthen source test**

In `tests/desktop-busy-navigation.test.ts`, extend the existing already-open test:

```ts
expect(desktop).toContain("function findOpenSessionTab(session: string, workspaceDir?: string)");
expect(desktop).toContain("if (focusExistingSessionTab(msg.name, targetWorkspace)) return");
expect(desktop.indexOf("if (focusExistingSessionTab(msg.name, targetWorkspace)) return")).toBeLessThan(
  desktop.indexOf("loadSessionIntoTab(tab, msg.name"),
);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- --run tests/desktop-busy-navigation.test.ts -t "already-open"
```

Expected: FAIL because helper signature still requires workspace first and exact workspace match.

- [ ] **Step 3: Implement session-first matching**

Replace helper in `src/cli/commands/desktop.ts`:

```ts
function findOpenSessionTab(session: string, workspaceDir?: string): Tab | undefined {
  const candidates = Array.from(tabs.values()).filter((t) => t.currentSession === session);
  if (candidates.length === 0) return undefined;
  if (!workspaceDir) return candidates[0];
  const targetDir = resolveDesktopRoot(workspaceDir);
  return (
    candidates.find((t) => resolve(t.rootDir) === resolve(targetDir)) ??
    candidates[0]
  );
}

function focusExistingSessionTab(session: string, workspaceDir?: string): boolean {
  const existing = findOpenSessionTab(session, workspaceDir);
  if (!existing) return false;
  focusTab(existing);
  return true;
}
```

Update callers:

```ts
const existing = findOpenSessionTab(session, targetDir);
```

and:

```ts
if (focusExistingSessionTab(msg.name, targetWorkspace)) return;
```

- [ ] **Step 4: Run backend navigation tests**

Run:

```bash
npm test -- --run tests/desktop-busy-navigation.test.ts
```

Expected: PASS.

---

## Task 6: Verify Live State Preservation

**Files:**
- Modify: `desktop/src/App.streaming.test.tsx` only if expectations need async waits after the architecture change.

- [ ] **Step 1: Run the running-session regression**

Run:

```bash
npm test -- --run desktop/src/App.streaming.test.tsx -t "restores a running session"
```

Expected: PASS.

- [ ] **Step 2: Run full App streaming suite**

Run:

```bash
npm test -- --run desktop/src/App.streaming.test.tsx
```

Expected: PASS. The jsdom canvas `getContext` warning is acceptable if exit code is 0.

- [ ] **Step 3: Run related backend suites**

Run:

```bash
npm test -- --run tests/desktop-loaded-session-messages.test.ts tests/desktop-busy-navigation.test.ts tests/desktop-main-overflow.test.ts tests/desktop-user-message.test.ts tests/desktop-session-load.test.ts
```

Expected: PASS.

- [ ] **Step 4: Typecheck**

Run:

```bash
npm run typecheck -- --pretty false
```

Expected: PASS.

- [ ] **Step 5: Desktop build**

Run:

```bash
npm --prefix desktop run build
```

Expected: PASS. Existing Vite warnings about dynamic/static import and large chunks are acceptable if build exit code is 0.

---

## Task 7: Manual Verification

**Files:**
- No code changes.

- [ ] **Step 1: Restart Jupiter dev app**

Run:

```bash
npm --prefix desktop run tauri -- dev
```

Expected: Vite starts on `http://127.0.0.1:1420/`, Tauri starts `target/debug/Jupiter`, and the desktop sidecar starts.

- [ ] **Step 2: Manual scenario**

Use Jupiter UI:

1. Open a long enough conversation list that sidebar can scroll.
2. Scroll sidebar down.
3. Start a new agent message and wait until partial streaming text appears.
4. Click another session in the sidebar.
5. Confirm sidebar scroll position does not reset.
6. Click the original running session in the sidebar.
7. Confirm partial streamed text is still visible.
8. Confirm stop button is still shown while the turn is running.
9. Confirm tool/thinking/process cards are still present if the turn has emitted them.

Expected: no shell-like refresh, no sidebar scroll reset, no lost in-flight text.

---

## Self-Review

**Spec coverage:** The plan covers the two user-visible failures: sidebar remount/scroll reset and live running state loss. It also covers the suspected backend miss where open sessions fail to focus because matching is too strict.

**Placeholder scan:** No task uses TBD/TODO. The plan includes exact files, test snippets, implementation snippets, and commands. Where code is too large to paste safely, the plan names the exact existing JSX blocks to move or keep unchanged rather than using placeholder implementation.

**Type consistency:** `TabRuntimeSnapshot`, `sendRpcToTab`, `onRuntimeSnapshot`, and `renderSingletonSidebar` are consistently named across tasks. Backend helper signatures are changed together in test and implementation.

**Risk review:** The largest risk is moving too much tab-local state into `App`. The plan avoids that by moving only the `.app` grid shell and singleton Sidebar. TitleBar, TabBar, main content, right panel, bottom panel, modals, command palette, and settings remain tab-local and are rendered only for the active tab. If TitleBar/TabBar also cause visible refresh later, they can be lifted in a separate follow-up.
