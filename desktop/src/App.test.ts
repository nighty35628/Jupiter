import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionLoadedEvent } from "./protocol";

vi.mock("./CommandPalette", () => ({
  CommandPalette: () => null,
  Toast: () => null,
  buildCommands: vi.fn(() => []),
  useCommandPalette: vi.fn(() => ({ open: false, setOpen: vi.fn() })),
}));
vi.mock("./Markdown", () => ({
  WorkspaceProvider: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock("./theme", () => ({
  FONT_FAMILY: "sans-serif",
  FONT_FAMILY_STACK: "sans-serif",
  FONT_SCALE: 1,
  FONT_SCALE_ZOOM: 1,
  THEME: "dark",
  defaultStyleForTheme: vi.fn(() => ({
    bg: "#000",
    surface: "#111",
    border: "#222",
    text: "#fff",
    muted: "#888",
    accent: "#0af",
    danger: "#f00",
    warn: "#fa0",
    success: "#0f0",
    brand: "#0af",
  })),
  isFontFamily: vi.fn(() => true),
  isFontScale: vi.fn(() => true),
  isTheme: vi.fn(() => true),
  isThemeStyle: vi.fn(() => true),
  themeForStyle: vi.fn(() => "dark"),
}));

import {
  canRetryErrorMessage,
  canRollbackMessage,
  chatMessageKey,
  pathToFileUrl,
  pickEmptySuggestions,
  readWindowExpanded,
  reduce,
  rollbackTargetForMessage,
  shouldShowSettingsChangeToast,
  shouldShowThinkingFooter,
  tabBusyFromIncomingEvent,
  toggleWindowExpanded,
} from "./App";
import { getThreadMaxWidth, getVisibleContextWidth } from "./ui/thread-layout";

function initialState(): Parameters<typeof reduce>[0] {
  return {
    ready: false,
    needsSetup: false,
    busy: false,
    transientStatus: null,
    messages: [],
    pendingConfirms: [],
    pendingPathAccess: [],
    pendingChoices: [],
    pendingPlans: [],
    pendingCheckpoints: [],
    pendingRevisions: [],
    activePlan: null,
    usage: {
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
    },
    usageHistory: null,
    sessions: [],
    archivedSessions: [],
    librarySources: [],
    externalImportSources: [],
    externalImportCandidates: [],
    settings: null,
    qq: null,
    feishu: null,
    dingtalk: null,
    balance: null,
    mentionResults: null,
    mentionPreview: null,
    mcpSpecs: [],
    mcpBridged: false,
    subagents: [],
    skills: [],
    skillRoots: [],
    sessionFiles: [],
    memory: [],
    memoryDetail: null,
    storageScan: null,
    sourceSearchResults: null,
    sourceIngestResult: null,
    jobs: [],
    activeSkill: null,
    queuedSends: [],
    sideChats: [],
    bindingId: 0,
    pendingTurnLoads: {},
    expandedTurns: [],
    sessionActionResult: null,
    retryNonce: 0,
  };
}

describe("prompt prediction after shared turn commit", { retry: 0 }, () => {
  const prediction = { completionId: "prediction-1", text: "Run the relevant tests." };
  const base = () => ({ ...initialState(), ready: true, currentSession: "chat", currentSessionId: "sid", conversationViewId: "view-a", bindingId: 1, historyVersion: 3 });
  const snapshot = (reason: SessionLoadedEvent["snapshot"]["reason"] = "resync", version = 4, view = "view-a"): SessionLoadedEvent => ({
    type: "$session_loaded", name: "chat", runtimeReady: true, busy: false,
    messages: [{ kind: "user", text: "Question", turn: 1, messageId: "u-turn-a", turnId: "turn-a", conversationViewId: view }, { kind: "assistant", turn: 1, messageId: "a-turn-a", turnId: "turn-a", conversationViewId: view, pending: false, segments: [{ kind: "text", text: "Answer" }] }],
    snapshot: { sessionId: "sid", bindingId: 1, conversationViewId: "view-a", historyVersion: version, reason, payloadBytes: 0, truncated: false },
    sessionFiles: [], carryover: { totalCostUsd: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalCompletionTokens: 0 },
  });
  const completed = (sourceViewId = "view-a") => {
    let state = reduce(base(), { t: "incoming", event: { type: "$shared_session_updated", sessionId: "sid", historyVersion: 4, sourceViewId, sourceTurnId: "turn-a" } });
    state = reduce(state, { t: "incoming", event: { type: "$prompt_prediction_eligible", completionId: prediction.completionId } });
    return state;
  };

  it.each([false, true])("retains a new own-turn prediction through its delayed committed snapshot (response received=%s)", (received) => {
    let state = completed();
    if (received) state = reduce(state, { t: "incoming", event: { type: "$prompt_prediction", ...prediction } });
    const next = reduce(state, { t: "incoming", event: snapshot() });
    expect(next.promptPrediction).toEqual(received ? prediction : { completionId: prediction.completionId });
    expect(next.historyVersion).toBe(4);
    expect(next.messages).toHaveLength(2);
  });

  it.each(["load", "compact", "rollback"] as const)("still clears prediction for %s snapshots", (reason) => {
    expect(reduce(completed(), { t: "incoming", event: snapshot(reason) }).promptPrediction).toBeUndefined();
  });
  it("does not retain predictions across a sibling commit or an unproven own snapshot", () => {
    expect(reduce(completed("view-b"), { t: "incoming", event: snapshot("resync", 4, "view-b") }).promptPrediction).toBeUndefined();
    expect(reduce(completed(), { t: "incoming", event: { ...snapshot(), messages: [] } }).promptPrediction).toBeUndefined();
    expect(reduce(completed(), { t: "incoming", event: snapshot("resync", 5) }).promptPrediction).toBeUndefined();
  });
  it("accepts older unversioned snapshot events without retaining stale predictions", () => {
    const { snapshot: _metadata, ...legacy } = snapshot();
    const next = reduce(completed(), { t: "incoming", event: legacy as SessionLoadedEvent });
    expect(next.promptPrediction).toBeUndefined();
  });
});

describe("history paging", () => {
  const history = { generation: "g1", beforeCursor: "older", hasMore: true, totalTurns: 50, sourceSize: 1000 };
  const user = (turn: number) => ({ kind: "user" as const, text: `u${turn}`, turn, messageId: `u${turn}`, rollbackRef: { turn, role: "user" as const } });
  const snapshot = (generation = "g1", messages = [user(50)]): SessionLoadedEvent => ({
    type: "$session_loaded", name: "paged", messages,
    history: { ...history, generation }, runtimeReady: false,
    snapshot: { sessionId: "sid", bindingId: 1, reason: "load", payloadBytes: 0, truncated: false },
    sessionFiles: [], carryover: { totalCostUsd: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalCompletionTokens: 0 },
  });
  const loaded = () => reduce(initialState(), { t: "incoming", event: snapshot() });
  const begin = (state = loaded(), requestId = "p1") => reduce(state, { t: "begin_history_page", requestId });
  const page = (requestId = "p1") => ({
    type: "$session_history_page" as const, name: "paged", sessionId: "sid", bindingId: 1, requestId,
    messages: [user(49), user(50)], history: { ...history, beforeCursor: "older-again" },
  });

  it("prepends unique rows without replacing forms or the live tail, and keeps the anchor", () => {
    const live = reduce(loaded(), { t: "send_user", text: "live", clientId: "live" });
    const pending = begin(live);
    const next = reduce(pending, { t: "incoming", event: page() });
    expect(next.messages.map((m) => m.kind === "user" && m.text)).toEqual(["u49", "u50", "live"]);
    expect(next.messages[1]).toBe(live.messages[0]);
    expect(next.messages[2]).toBe(live.messages[1]);
    expect(next.history!.firstItemIndex).toBe(pending.history!.firstItemIndex - 1);
    expect(reduce(next, { t: "incoming", event: page() })).toBe(next);
  });

  it.each([{ name: "other" }, { sessionId: "other" }, { bindingId: 2 }, { requestId: "old" }, { history: { ...history, generation: "old" } }])(
    "rejects stale or rebound page %j", (patch) => {
      const state = begin();
      expect(reduce(state, { t: "incoming", event: { ...page(), ...patch } })).toBe(state);
    },
  );

  it("keeps the cursor after failure and permits one retry", () => {
    const state = begin();
    expect(begin(state, "second")).toBe(state);
    const failed = reduce(state, { t: "incoming", event: { ...page(), messages: [], history: undefined, error: "read failed" } });
    expect(failed.history).toMatchObject({ beforeCursor: "older", error: "read failed", pending: undefined });
    const retried = begin(failed, "retry");
    expect(retried.history!.pending).toMatchObject({ requestId: "retry", cursor: "older", generation: "g1" });
    expect(reduce(retried, { t: "incoming", event: page("retry") }).messages).toHaveLength(2);
  });

  it("resets old pages and expanded detail on a new generation snapshot", () => {
    const state = reduce(begin(), { t: "incoming", event: page() });
    const pending = reduce(begin(state, "late"), { t: "begin_turn_load", turn: 49, requestId: "detail" });
    const next = reduce(pending, { t: "incoming", event: { ...snapshot("g2", [user(2)]), type: "$session_reconciled" } });
    expect(next.messages).toMatchObject([{ turn: 2 }]);
    expect(next.pendingTurnLoads).toEqual({});
    expect(next.history!.pending).toBeUndefined();
    expect(reduce(next, { t: "incoming", event: page("late") })).toBe(next);
  });

  it("accepts a correlated reset page but rejects its replay", () => {
    const state = begin();
    const reset = { ...page(), reset: true, messages: [user(2)], history: { ...history, generation: "g2" } };
    const next = reduce(state, { t: "incoming", event: reset });
    expect(next.messages).toMatchObject([{ turn: 2 }]);
    expect(next.history!.generation).toBe("g2");
    expect(reduce(next, { t: "incoming", event: reset })).toBe(next);
  });

  it("preserves older pages across same-generation latest snapshots", () => {
    const state = reduce(begin(), { t: "incoming", event: page() });
    const next = reduce(state, { t: "incoming", event: { ...snapshot(), type: "$session_reconciled" } });
    expect(next.messages).toEqual(state.messages);
    expect(next.messages[0]).toBe(state.messages[0]);
    expect(next.history!.beforeCursor).toBe("older-again");
  });

  it("holds composer readiness until ready after a not-ready snapshot", () => {
    const next = reduce({ ...initialState(), ready: true }, { t: "incoming", event: snapshot() });
    expect(next.ready).toBe(false);
    expect(reduce(next, { t: "incoming", event: { type: "$ready" } }).ready).toBe(true);
  });

  it("uses absolute rollback refs in partial arrays, including explicit null", () => {
    const state = loaded();
    const message = state.messages[0];
    if (message.kind !== "user") throw new Error("expected user");
    expect(rollbackTargetForMessage(state.messages, 0)).toEqual({ turn: 50, role: "user" });
    expect(rollbackTargetForMessage([{ ...message, rollbackRef: null }], 0)).toBeNull();
    expect(canRollbackMessage([{ ...message, rollbackRef: null }, ...state.messages], 0, false)).toBe(false);
  });

  it("rejects stale generation details and pages while switching sessions", () => {
    const state = reduce(loaded(), { t: "begin_turn_load", turn: 50, requestId: "detail" });
    expect(reduce(state, { t: "incoming", event: { type: "$session_turn_loaded", name: "paged", sessionId: "sid", bindingId: 1, requestId: "detail", turn: 50, generation: "g0", messages: [user(50)] } })).toBe(state);
    const switching = reduce(begin(state), { t: "begin_session_load", requestId: "switch" });
    expect(reduce(switching, { t: "incoming", event: page() })).toBe(switching);
  });

  it("clears a failed detail request without replacing messages or marking it expanded", () => {
    const state = reduce(loaded(), { t: "begin_turn_load", turn: 50, requestId: "detail" });
    const next = reduce(state, { t: "incoming", event: {
      type: "$session_turn_loaded", name: "paged", sessionId: "sid", bindingId: 1,
      requestId: "detail", turn: 50, generation: "g1", messages: [], error: "Turn exceeds display limit",
    } });
    expect(next.pendingTurnLoads).toEqual({});
    expect(next.expandedTurns).toEqual([]);
    expect(next.messages[0]).toBe(state.messages[0]);
    expect(next.messages.at(-1)).toMatchObject({ kind: "error", recoverable: true, message: "Turn exceeds display limit" });
  });

  it("upserts persisted identities over live aliases without duplicating a streaming turn", () => {
    const state = reduce(loaded(), { t: "send_user", text: "live", clientId: "client51" });
    const streaming = reduce(state, { t: "incoming", event: { type: "model.delta", id: 51, ts: "2026-10-26T00:00:00Z", turn: 51, channel: "content", text: "live answer" } });
    const next = reduce(streaming, { t: "incoming", event: { ...snapshot(), type: "$session_reconciled", messages: [
      user(50), { ...user(51), clientId: "client51", text: "live" },
      { kind: "assistant", turn: 51, messageId: "a-51", segments: [{ kind: "text", text: "live" }], pending: false, rollbackRef: { turn: 51, role: "assistant" } },
    ] } });
    expect(next.messages).toHaveLength(3);
    expect(next.messages[2]).toMatchObject({ pending: true, segments: [{ kind: "text", text: "live answer" }] });
    expect(chatMessageKey(next.messages[1], 1)).toBe(chatMessageKey(streaming.messages[1], 1));
    expect(chatMessageKey(next.messages[2], 2)).toBe(chatMessageKey(streaming.messages[2], 2));
    expect(rollbackTargetForMessage(next.messages, 1)).toEqual({ turn: 51, role: "user" });
  });

  it("uses the authoritative committed turn for new live rollback refs in a paged session", () => {
    const state = reduce(loaded(), { t: "send_user", text: "live", clientId: "client51" });
    const next = reduce(state, { t: "incoming", event: {
      type: "$turn_committed", name: "paged", sessionId: "sid", bindingId: 1, turn: 51,
      clientId: "client51", sessionFiles: [], carryover: snapshot().carryover,
    } });
    expect(rollbackTargetForMessage(next.messages, 1)).toEqual({ turn: 51, role: "user" });
    expect(next.messages[0]).toBe(state.messages[0]);
  });

  it.each(["$session_loaded", "$session_reconciled"] as const)("keeps the active live tail and forms across a same-binding busy rewrite (%s)", (type) => {
    let state = reduce(begin(), { t: "incoming", event: page() });
    state = reduce(state, { t: "send_user", text: "live question", clientId: "active-client" });
    state = reduce(state, { t: "incoming", event: { type: "model.delta", id: 1, ts: "now", turn: 51, channel: "content", text: "live answer" } });
    state = { ...state, pendingConfirms: [{ id: 7, kind: "run_command", command: "pwd", prompt: makeShellPrompt("pwd") }] };
    const next = reduce(state, { t: "incoming", event: { ...snapshot("g2", [user(2)]), type, busy: true } });
    expect(next.messages).toHaveLength(3);
    expect(next.messages[0]).toMatchObject({ turn: 2 });
    expect(next.messages[1]).toBe(state.messages[2]);
    expect(next.messages[2]).toBe(state.messages[3]);
    expect(next.pendingConfirms).toBe(state.pendingConfirms);
    expect(next.history!.generation).toBe("g2");
    expect(next.busy).toBe(true);
  });

  it("deduplicates the rebased live turn in a rewrite and adopts only new-generation rollback refs", () => {
    let state = reduce(loaded(), { t: "send_user", text: "live question", clientId: "active-client" });
    state = reduce(state, { t: "incoming", event: { type: "model.delta", id: 1, ts: "now", turn: 51, channel: "content", text: "live answer" } });
    const next = reduce(state, { t: "incoming", event: { ...snapshot("g2", [user(2)]), busy: true, messages: [
      user(2), { ...user(3), text: "live question", clientId: "active-client" },
      { kind: "assistant", messageId: "a3", turn: 3, pending: false, segments: [{ kind: "text", text: "live" }], rollbackRef: { turn: 3, role: "assistant" } },
    ] } });
    expect(next.messages).toHaveLength(3);
    expect(next.messages[1]).toMatchObject({ turn: 3, rollbackRef: { turn: 3, role: "user" } });
    expect(next.messages[2]).toMatchObject({ turn: 3, pending: true, segments: [{ kind: "text", text: "live answer" }] });
    expect(chatMessageKey(next.messages[1], 1)).toBe(chatMessageKey(state.messages[1], 1));
    expect(chatMessageKey(next.messages[2], 2)).toBe(chatMessageKey(state.messages[2], 2));
  });

  it("preserves the live tail on a correlated history reset page too", () => {
    const live = reduce(loaded(), { t: "send_user", text: "live question", clientId: "live" });
    const next = reduce(begin(live), { t: "incoming", event: { ...page(), reset: true, history: { ...history, generation: "g2" }, messages: [user(2)] } });
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1]).toBe(live.messages[1]);
  });

  it.each([false, true])("accepts generation-tagged detail for legacy snapshots and clears pending, error=%s", (error) => {
    const state = { ...loaded(), history: undefined, pendingTurnLoads: { 50: "legacy-detail" } };
    const next = reduce(state, { t: "incoming", event: { type: "$session_turn_loaded", name: "paged", sessionId: "sid", bindingId: 1,
      turn: 50, requestId: "legacy-detail", generation: "g1", messages: [user(50)], ...(error ? { error: "display limit" } : {}) } });
    expect(next.pendingTurnLoads).toEqual({});
    expect(next.expandedTurns).toEqual(error ? [] : [50]);
    if (error) expect(next.messages.at(-1)).toMatchObject({ recoverable: true, message: "display limit" });
  });

  it("upserts first-turn detail by identity without duplicating or discarding leading orphans", () => {
    const orphan = (turn: number) => ({ kind: "assistant" as const, messageId: `a-orphan-${turn}`, turn, pending: false as const,
      segments: [{ kind: "text" as const, text: `orphan ${turn}` }], rollbackRef: null });
    const state = reduce(initialState(), { t: "incoming", event: { ...snapshot(), messages: [orphan(1), orphan(2), orphan(3), user(1), user(2)] } });
    const pending = reduce(state, { t: "begin_turn_load", turn: 1, requestId: "detail" });
    const next = reduce(pending, { t: "incoming", event: { type: "$session_turn_loaded", name: "paged", sessionId: "sid", bindingId: 1,
      turn: 1, requestId: "detail", generation: "g1", messages: [orphan(1), orphan(2), { ...user(1), text: "full first turn" }] } });
    expect(next.messages.map((message, index) => chatMessageKey(message, index))).toEqual([
      "assistant-a-orphan-1", "assistant-a-orphan-2", "assistant-a-orphan-3", "user-u1", "user-u2",
    ]);
    expect(next.messages[2]).toBe(state.messages[2]);
    expect(next.messages[3]).toMatchObject({ text: "full first turn" });
    expect(next.messages[4]).toBe(state.messages[4]);
  });
});

function loadedSnapshot(
  reason: SessionLoadedEvent["snapshot"]["reason"] = "load",
  bindingId = 1,
): Pick<SessionLoadedEvent, "snapshot" | "sessionFiles"> {
  return {
    snapshot: {
      sessionId: "session-1",
      bindingId,
      reason,
      payloadBytes: 0,
      truncated: false,
    },
    sessionFiles: [],
  };
}

function makeShellPrompt(
  command: string,
): import("@jupiter/core-utils").ApprovalPrompt {
  return {
    id: 1,
    kind: "shell",
    tone: "warn",
    title: "Run command",
    subtitle: command,
    preview: command,
    meta: {},
    actions: [
      { id: "run_once", label: "Run once", kind: "allow_once" },
      { id: "always_allow", label: "Always allow", kind: "allow_always" },
      {
        id: "deny",
        label: "Deny",
        kind: "reject",
        secondaryInput: { hint: "Reason", required: false },
      },
    ],
    data: { prefix: command.split(" ")[0] ?? "" },
  };
}

function makePathPrompt(
  path: string,
  intent: "read" | "write",
): import("@jupiter/core-utils").ApprovalPrompt {
  return {
    id: 2,
    kind: "path",
    tone: "warn",
    title: `Access path — ${intent}`,
    subtitle: path,
    preview: `tool → ${path}`,
    meta: { sandboxRoot: "/workspace" },
    actions: [
      {
        id: "run_once",
        label: intent === "write" ? "Allow write" : "Allow read",
        kind: "allow_once",
      },
      { id: "always_allow", label: "Always allow", kind: "allow_always" },
      {
        id: "deny",
        label: "Deny",
        kind: "reject",
        secondaryInput: { hint: "Reason", required: false },
      },
    ],
    data: { prefix: "/workspace", intent },
  };
}

describe("Desktop App error lifecycle", () => {
  it("keeps a running turn busy until the explicit completion event", () => {
    const busy = {
      ...initialState(),
      busy: true,
      activeSkill: { name: "review", runAs: "inline" as const },
    };
    const withError = reduce(busy, {
      t: "incoming",
      event: { type: "$error", message: "Stop hook warning" },
    });

    expect(withError.busy).toBe(true);
    expect(withError.activeSkill).toEqual(busy.activeSkill);
    expect(tabBusyFromIncomingEvent({ type: "$error", message: "warning" })).toBeNull();

    const completed = reduce(withError, {
      t: "incoming",
      event: { type: "$turn_complete" },
    });
    expect(completed.busy).toBe(false);
    expect(completed.activeSkill).toBeNull();
  });
});

describe("Desktop App reducer — usage", () => {
  it("replaces manual compaction progress in place instead of leaving a starting banner", () => {
    const started = reduce(initialState(), { t: "push_status", text: "starting", activity: "compaction" });
    const key = chatMessageKey(started.messages[0], 0);
    const done = reduce(started, { t: "incoming", event: { type: "$compact_result", folded: true, beforeMessages: 20, afterMessages: 4, summaryChars: 100 } });
    expect(done.messages).toHaveLength(1);
    expect(done.messages[0]).toMatchObject({ kind: "status", pending: false });
    expect(chatMessageKey(done.messages[0], 20)).toBe(key);
    expect(done.messages[0]).not.toMatchObject({ text: "starting" });
  });
  it("updates inline compaction in place and puts subsequent output after it", () => {
    let state = initialState();
    state.messages = [{ kind: "assistant", turn: 1, messageId: "a", pending: true, segments: [{ kind: "text", text: "before" }] }];
    for (const event of [
      { type: "status", id: 1, ts: "", turn: 1, text: "Compacting", activity: "compaction", activityState: "running" },
      { type: "status", id: 2, ts: "", turn: 1, text: "Compacted", activity: "compaction", activityState: "complete" },
      { type: "model.delta", id: 3, ts: "", turn: 1, text: "after", channel: "content" },
    ] as const) state = reduce(state, { t: "incoming", event });
    expect(state.messages).toHaveLength(1);
    const message = state.messages[0];
    if (message.kind !== "assistant") throw new Error("Expected assistant");
    expect(message.segments).toEqual([
      { kind: "text", text: "before" },
      { kind: "compaction", id: "compact-1", text: "Compacted", pending: false },
      { kind: "text", text: "after" },
    ]);
    expect(state.transientStatus).toBeNull();
  });
  it("keeps canonical long text across unrelated updates and turn completion", () => {
    const state = initialState();
    const text = "paragraph\n".repeat(40_000);
    state.messages = [{ kind: "assistant", turn: 1, messageId: "long", pending: true, segments: [{ kind: "text", text }] }];
    let next = reduce(state, { t: "set_busy", busy: false });
    for (let i = 0; i < 5; i++) next = reduce(next, { t: "push_status", text: "event" });
    expect(next.messages[0]).toEqual(state.messages[0]);
  });
  it("keeps fallback keys stable when surrounding rows change", () => {
    const message = { kind: "status" as const, text: "compressed" };
    expect(chatMessageKey(message, 1)).toBe(chatMessageKey(message, 42));
  });
  it("uses stable transcript keys for virtualized message rendering", () => {
    expect(
      chatMessageKey(
        { kind: "user", text: "hello", clientId: "c-1", turn: 7 },
        0,
      ),
    ).toBe("user-c-1");
    expect(
      chatMessageKey(
        { kind: "assistant", turn: 7, segments: [], pending: false },
        1,
      ),
    ).toMatch(/^assistant-local-/);
    expect(
      chatMessageKey(
        { kind: "assistant", turn: 7, segments: [], pending: true },
        2,
      ),
    ).toMatch(/^assistant-local-/);
    expect(
      chatMessageKey(
        {
          kind: "workflow",
          run: {
            id: "wf-1",
            workflowId: "release-readiness-check",
            workflowVersion: 1,
            title: "Release Readiness Check",
            status: "running",
            phase: "release-workflow",
            input: { prompt: "check release" },
            startedAt: "2026-06-11T00:00:00.000Z",
            tokenUsage: { prompt: 0, completion: 0, total: 0 },
            agents: [],
            logs: [],
            sources: [],
          },
        },
        2,
      ),
    ).toBe("workflow-wf-1");
  });

  it("updates workflow run cards from live workflow events", () => {
    const started = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "workflow_started",
        run: {
          id: "wf-1",
          workflowId: "release-readiness-check",
          workflowVersion: 1,
          title: "Release Readiness Check",
          status: "running",
          phase: "release-workflow",
          input: { prompt: "check release" },
          startedAt: "2026-06-11T00:00:00.000Z",
          tokenUsage: { prompt: 0, completion: 0, total: 0 },
          agents: [],
          logs: [],
          sources: [],
        },
      },
    });

    const completed = reduce(started, {
      t: "incoming",
      event: {
        type: "workflow_completed",
        run: {
          id: "wf-1",
          workflowId: "release-readiness-check",
          workflowVersion: 1,
          title: "Release Readiness Check",
          status: "completed",
          phase: "completed",
          input: { prompt: "check release" },
          startedAt: "2026-06-11T00:00:00.000Z",
          completedAt: "2026-06-11T00:00:05.000Z",
          tokenUsage: { prompt: 100, completion: 50, total: 150 },
          agents: [
            {
              id: "agent-1",
              label: "Release workflow",
              status: "completed",
              phase: "release-workflow",
              summary: "Release workflow checked",
              tokenUsage: { prompt: 100, completion: 50, total: 150 },
            },
          ],
          logs: [{ ts: "2026-06-11T00:00:04.000Z", message: "final report ready" }],
          sources: [{ title: "release.yml", path: ".github/workflows/release.yml" }],
          result: { summary: "Ready with caveats" },
        },
      },
    });

    expect(completed.busy).toBe(false);
    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0]).toMatchObject({
      kind: "workflow",
      run: {
        id: "wf-1",
        status: "completed",
        phase: "completed",
        tokenUsage: { total: 150 },
        logs: [{ message: "final report ready" }],
      },
    });
  });

  it("deduplicates local user message echoes by client id", () => {
    const base = initialState();
    const state = {
      ...base,
      busy: true,
      messages: [
        {
          kind: "user" as const,
          text: "make a ppt",
          clientId: "c-local",
          turn: 12,
        },
      ],
    };

    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "user.message",
        id: 99,
        ts: "2026-06-03T00:00:00.000Z",
        turn: 12,
        text: "make a ppt",
        clientId: "c-local",
      },
    });

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toEqual({
      kind: "user",
      text: "make a ppt",
      clientId: "c-local",
      turn: 12,
    });
  });

  it("keeps local command echoes from advancing conversation rollback turns", () => {
    const state = {
      ...initialState(),
      messages: [
        { kind: "user" as const, text: "first", clientId: "c-1", turn: 1 },
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "text" as const, text: "done" }],
          pending: false,
        },
      ],
    };

    const withCommand = reduce(state, {
      t: "send_user",
      text: "/undo",
      clientId: "slash-1",
      rollbackable: false,
    });

    expect(withCommand.messages.at(-1)).toMatchObject({
      kind: "user",
      turn: 1,
      rollbackable: false,
    });
    expect(canRollbackMessage(withCommand.messages, 2, false)).toBe(false);
    expect(canRollbackMessage(withCommand.messages, 1, false)).toBe(false);

    const withNextUser = reduce(
      { ...withCommand, busy: false },
      { t: "send_user", text: "next real prompt", clientId: "c-2" },
    );

    expect(withNextUser.messages.at(-1)).toMatchObject({
      kind: "user",
      turn: 2,
    });
  });

  it("removes only the definitely-unsent optimistic user message", () => {
    const state = {
      ...initialState(),
      ready: true,
      busy: true,
      messages: [
        { kind: "user" as const, text: "older", clientId: "c-1", turn: 1 },
        { kind: "user" as const, text: "unsent", clientId: "c-2", turn: 2 },
      ],
    };

    const next = reduce(state, { t: "rpc_not_sent", clientId: "c-2" });
    expect(next.busy).toBe(false);
    expect(next.messages).toEqual([
      { kind: "user", text: "older", clientId: "c-1", turn: 1 },
    ]);
  });

  it("removes only a backend-confirmed unaccepted preflight message on cancellation", () => {
    const state = reduce(
      { ...initialState(), messages: [{ kind: "user", text: "saved", clientId: "saved", turn: 1 }] },
      { t: "send_user", text: "cancel before admission", clientId: "preflight" },
    );
    const cancelled = reduce(state, {
      t: "incoming",
      event: { type: "$turn_complete", unacceptedClientId: "preflight" },
    });
    expect(cancelled.busy).toBe(false);
    expect(cancelled.messages).toEqual([{ kind: "user", text: "saved", clientId: "saved", turn: 1 }]);
    const recovered = reduce(cancelled, { t: "send_user", text: "try again", clientId: "recovery" });
    expect(recovered.messages.at(-1)).toMatchObject({ clientId: "recovery", turn: 2 });
    const normalCompletion = reduce(state, { t: "incoming", event: { type: "$turn_complete" } });
    expect(normalCompletion.messages).toHaveLength(2);
  });

  it("clears stale approvals when the shared RPC process exits", () => {
    const prompt = makeShellPrompt("echo ok");
    const state = {
      ...initialState(),
      ready: true,
      busy: true,
      pendingConfirms: [
        { id: 1, kind: "run_command" as const, command: "echo ok", prompt },
      ],
      pendingPathAccess: [
        {
          id: 2,
          path: "/tmp",
          intent: "read" as const,
          toolName: "read_file",
          sandboxRoot: "/tmp",
          allowPrefix: "/tmp",
          prompt,
        },
      ],
      pendingChoices: [{ id: 3, question: "Pick", options: [], allowCustom: false }],
    };

    const next = reduce(state, { t: "rpc_exit", code: 1 });
    expect(next.ready).toBe(false);
    expect(next.busy).toBe(false);
    expect(next.pendingConfirms).toEqual([]);
    expect(next.pendingPathAccess).toEqual([]);
    expect(next.pendingChoices).toEqual([]);
  });

  it("computes rollback targets from conversation messages instead of stale UI turns", () => {
    const messages = [
      { kind: "user" as const, text: "first", clientId: "c-1", turn: 1 },
      {
        kind: "assistant" as const,
        turn: 1,
        segments: [{ kind: "text" as const, text: "done" }],
        pending: false,
      },
      { kind: "user" as const, text: "/undo", clientId: "slash-1", turn: 2 },
      { kind: "user" as const, text: "second", clientId: "c-2", turn: 3 },
      {
        kind: "assistant" as const,
        turn: 3,
        segments: [{ kind: "text" as const, text: "done again" }],
        pending: false,
      },
    ];

    expect(rollbackTargetForMessage(messages, 3)).toEqual({
      turn: 2,
      role: "user",
    });
    expect(rollbackTargetForMessage(messages, 4)).toEqual({
      turn: 2,
      role: "assistant",
    });
    expect(rollbackTargetForMessage(messages, 2)).toBeNull();
  });

  it("encodes local html paths as file URLs for sidebar browser preview", () => {
    expect(pathToFileUrl("/Users/me/My Site/index #1.html")).toBe(
      "file:///Users/me/My%20Site/index%20%231.html",
    );
  });

  it("falls back prompt tokens to cache miss tokens when cache fields are absent", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "model.final",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "ok",
        usage: {
          prompt_tokens: 1234,
          completion_tokens: 56,
          total_tokens: 1290,
        },
        costUsd: 0.001,
      },
    });

    expect(next.usage.totalPromptTokens).toBe(1234);
    expect(next.usage.cacheHitTokens).toBe(0);
    expect(next.usage.cacheMissTokens).toBe(1234);
    expect(next.usage.lastCallCacheMiss).toBe(1234);
  });

  it("settles pending assistant content on error but waits for explicit turn completion", () => {
    const base = initialState();
    const state = {
      ...base,
      busy: true,
      messages: [
        ...base.messages,
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "reasoning" as const, text: "thinking…" }],
          pending: true,
        },
      ],
    };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "error",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        message: "SSE body read failed: terminated",
        recoverable: false,
      },
    });

    expect(next.busy).toBe(true);
    const assistant = next.messages.find((m) => m.kind === "assistant");
    expect(assistant?.pending).toBe(false);
    const error = next.messages.find((m) => m.kind === "error");
    expect(error?.message).toBe("SSE body read failed: terminated");

    const completed = reduce(next, {
      t: "incoming",
      event: { type: "$turn_complete" },
    });
    expect(completed.busy).toBe(false);
  });

  it("creates a pending assistant when a live delta arrives before turn started", () => {
    let next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "model.delta",
        id: 1,
        ts: "2026-06-06T00:00:00.000Z",
        turn: 1,
        channel: "reasoning",
        text: "thinking",
      },
    });
    next = reduce(next, {
      t: "incoming",
      event: {
        type: "model.delta",
        id: 2,
        ts: "2026-06-06T00:00:00.000Z",
        turn: 1,
        channel: "reasoning",
        text: "...",
      },
    });
    next = reduce(next, {
      t: "incoming",
      event: {
        type: "model.delta",
        id: 3,
        ts: "2026-06-06T00:00:00.000Z",
        turn: 1,
        channel: "content",
        text: "hello",
      },
    });

    expect(next.busy).toBe(true);
    expect(next.messages).toEqual([
      {
        kind: "assistant",
        turn: 1,
        messageId: "a-live-1",
        pending: true,
        segments: [
          { kind: "reasoning", text: "thinking..." },
          { kind: "text", text: "hello" },
        ],
      },
    ]);
  });

  it("keeps cumulative usage when live context breakdown refreshes", () => {
    const base = initialState();
    const next = reduce(
      {
        ...base,
        usage: {
          ...base.usage,
          cacheHitTokens: 80,
          cacheMissTokens: 20,
          totalPromptTokens: 100,
        },
      },
      {
        t: "incoming",
        event: { type: "$ctx_breakdown", reservedTokens: 10, logTokens: 42 },
      },
    );

    expect(next.usage.cacheHitTokens).toBe(80);
    expect(next.usage.cacheMissTokens).toBe(20);
    expect(next.usage.liveLogTokens).toBe(42);
  });

  it("preserves live context breakdown when a session snapshot refreshes usage carryover", () => {
    const withBreakdown = reduce(initialState(), {
      t: "incoming",
      event: { type: "$ctx_breakdown", reservedTokens: 10, logTokens: 42 },
    });
    const next = reduce(withBreakdown, {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: "desktop-20260617000100-1",
        busy: false,
        messages: [],
        ...loadedSnapshot(),
        carryover: {
          totalCostUsd: 0.12,
          cacheHitTokens: 80,
          cacheMissTokens: 20,
          totalCompletionTokens: 5,
        },
      },
    });

    expect(next.usage.reservedTokens).toBe(10);
    expect(next.usage.liveLogTokens).toBe(42);
    expect(next.usage.totalPromptTokens).toBe(100);
  });
});

describe("Desktop App reducer — side chat", () => {
  it("renders sidebar btw answers without appending them to the main transcript", () => {
    const pending = reduce(initialState(), {
      t: "side_chat_sent",
      id: "side-1",
      question: "what is a closure?",
    });

    expect(pending.sideChats).toEqual([
      {
        id: "side-1",
        question: "what is a closure?",
        status: "pending",
      },
    ]);

    const answered = reduce(pending, {
      t: "incoming",
      event: {
        type: "$btw_result",
        clientId: "side-1",
        question: "what is a closure?",
        answer: "A closure captures variables from its outer scope.",
      },
    });

    expect(answered.messages).toHaveLength(0);
    expect(answered.sideChats).toEqual([
      {
        id: "side-1",
        question: "what is a closure?",
        answer: "A closure captures variables from its outer scope.",
        status: "done",
      },
    ]);
  });

  it("keeps normal /btw results in the main transcript", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$btw_result",
        question: "quick aside",
        answer: "short answer",
      },
    });

    expect(next.sideChats).toEqual([]);
    expect(next.messages).toEqual([
      { kind: "status", text: "≫ btw\nshort answer" },
    ]);
  });

  it("does not append transient kernel statuses to the main transcript", () => {
    const next = reduce(
      {
        ...initialState(),
        busy: true,
        messages: [{ kind: "assistant", turn: 1, pending: true, segments: [] }],
      },
      {
        t: "incoming",
        event: {
          type: "status",
          id: 1,
          ts: "2026-06-10T00:00:00.000Z",
          turn: 1,
          text: "tool result uploaded · model thinking before next response…",
        },
      },
    );

    expect(next.messages).toEqual([
      { kind: "assistant", turn: 1, pending: true, segments: [] },
    ]);
    expect(next.transientStatus).toBe("tool result uploaded · model thinking before next response…");
  });

  it("drops stale sidebar btw answers after their temporary chat is gone", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$btw_result",
        clientId: "side-stale",
        question: "stale",
        answer: "late answer",
      },
    });

    expect(next.sideChats).toEqual([]);
    expect(next.messages).toEqual([]);
  });
});

describe("Desktop App reducer — subagents", () => {
  it("tracks a child session and keeps later updates attached to the same parent session", () => {
    const state = { ...initialState(), currentSession: "desktop-parent" };
    const started = reduce(state, {
      t: "incoming",
      event: {
        type: "$subagent_event",
        kind: "start",
        runId: "sub-1",
        parentSession: "desktop-parent",
        sessionName: "subagent-sub-1-20260531120000",
        task: "Explore renderer",
        skillName: "explorer",
        model: "deepseek-v4-flash",
        iter: 0,
        elapsedMs: 0,
      },
    });
    const done = reduce(started, {
      t: "incoming",
      event: {
        type: "$subagent_event",
        kind: "end",
        runId: "sub-1",
        parentSession: "desktop-parent",
        sessionName: "subagent-sub-1-20260531120000",
        task: "Explore renderer",
        skillName: "explorer",
        elapsedMs: 2000,
        turns: 2,
      },
    });

    expect(done.subagents).toHaveLength(1);
    expect(done.subagents[0]).toMatchObject({
      runId: "sub-1",
      status: "done",
      parentSession: "desktop-parent",
      sessionName: "subagent-sub-1-20260531120000",
      task: "Explore renderer",
      skillName: "explorer",
      turns: 2,
      elapsedMs: 2000,
    });
  });

  it("ignores subagent events from a different parent session", () => {
    const state = { ...initialState(), currentSession: "desktop-current" };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$subagent_event",
        kind: "start",
        runId: "sub-old",
        parentSession: "desktop-old",
        sessionName: "subagent-sub-old",
        task: "old child",
      },
    });

    expect(next.subagents).toEqual([]);
  });
});

describe("Desktop App window controls", () => {
  it("keeps titlebar actions clickable at the fullscreen edge on Windows", () => {
    const css = readFileSync(resolve(__dirname, "styles.css"), "utf8");
    const rightRule = css.match(/\.titlebar \.tb-right \{[\s\S]*?\n\}/)?.[0] ?? "";
    const winControlsRule = css.match(/\.win-controls \{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(rightRule).toContain("padding-right:");
    expect(rightRule).toContain("position: relative");
    expect(rightRule).toContain("z-index:");
    expect(winControlsRule).toContain("position: relative");
    expect(winControlsRule).toContain("z-index:");
  });

  it("treats macOS zoom state as fullscreen", async () => {
    const win = {
      isFullscreen: vi.fn(async () => true),
      isMaximized: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
    };

    await expect(readWindowExpanded(win, true)).resolves.toBe(true);
    expect(win.isFullscreen).toHaveBeenCalledTimes(1);
    expect(win.isMaximized).not.toHaveBeenCalled();
  });

  it("uses native fullscreen for macOS zoom button", async () => {
    const win = {
      isFullscreen: vi.fn(async () => false),
      isMaximized: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
    };

    await toggleWindowExpanded(win, true, false);
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
    expect(win.toggleMaximize).not.toHaveBeenCalled();
  });

  it("keeps maximize behavior off macOS", async () => {
    const win = {
      isFullscreen: vi.fn(async () => false),
      isMaximized: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => {}),
      toggleMaximize: vi.fn(async () => {}),
    };

    await toggleWindowExpanded(win, false, false);
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(win.setFullscreen).not.toHaveBeenCalled();
  });
});

describe("Desktop App reducer — ApprovalPrompt integration", () => {
  it("stores shell confirm with prompt on $confirm_required", () => {
    const state = initialState();
    const prompt = makeShellPrompt("git status");
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$confirm_required",
        id: 7,
        kind: "run_command",
        command: "git status",
        prompt,
      },
    });
    expect(next.pendingConfirms).toHaveLength(1);
    expect(next.pendingConfirms[0]).toMatchObject({
      id: 7,
      kind: "run_command",
      command: "git status",
    });
    expect(next.pendingConfirms[0].prompt).toEqual(prompt);
  });

  it("stores path access with prompt on $path_access_required", () => {
    const state = initialState();
    const prompt = makePathPrompt("/etc/passwd", "read");
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$path_access_required",
        id: 8,
        path: "/etc/passwd",
        intent: "read",
        toolName: "read_file",
        sandboxRoot: "/workspace",
        allowPrefix: "/workspace",
        prompt,
      },
    });
    expect(next.pendingPathAccess).toHaveLength(1);
    expect(next.pendingPathAccess[0]).toMatchObject({
      id: 8,
      path: "/etc/passwd",
      intent: "read",
    });
    expect(next.pendingPathAccess[0].prompt).toEqual(prompt);
  });

  it("removes confirm on resolve_confirm", () => {
    const prompt = makeShellPrompt("ls");
    const state = {
      ...initialState(),
      pendingConfirms: [
        { id: 1, kind: "run_command" as const, command: "ls", prompt },
        {
          id: 2,
          kind: "run_command" as const,
          command: "pwd",
          prompt: { ...prompt, id: 2, subtitle: "pwd" },
        },
      ],
    };
    const next = reduce(state, { t: "resolve_confirm", id: 1 });
    expect(next.pendingConfirms).toHaveLength(1);
    expect(next.pendingConfirms[0].id).toBe(2);
  });

  it("removes path access on resolve_path_access", () => {
    const prompt = makePathPrompt("/tmp", "write");
    const state = {
      ...initialState(),
      pendingPathAccess: [
        {
          id: 3,
          path: "/tmp",
          intent: "write" as const,
          toolName: "write_file",
          sandboxRoot: "/workspace",
          allowPrefix: "/workspace",
          prompt,
        },
      ],
    };
    const next = reduce(state, { t: "resolve_path_access", id: 3 });
    expect(next.pendingPathAccess).toHaveLength(0);
  });

  it("clears all pending on clear action", () => {
    const shellPrompt = makeShellPrompt("echo hi");
    const pathPrompt = makePathPrompt("/x", "read");
    const state = {
      ...initialState(),
      pendingConfirms: [
        {
          id: 1,
          kind: "run_command" as const,
          command: "echo hi",
          prompt: shellPrompt,
        },
      ],
      pendingPathAccess: [
        {
          id: 2,
          path: "/x",
          intent: "read" as const,
          toolName: "read_file",
          sandboxRoot: "/ws",
          allowPrefix: "/ws",
          prompt: pathPrompt,
        },
      ],
    };
    const next = reduce(state, { t: "clear" });
    expect(next.pendingConfirms).toHaveLength(0);
    expect(next.pendingPathAccess).toHaveLength(0);
  });

  it("patches settings optimistically for desktop setting commands", () => {
    const state: Parameters<typeof reduce>[0] = {
      ...initialState(),
      settings: {
        reasoningEffort: "medium",
        editMode: "review",
        budgetUsd: null,
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-flash",
        version: "0.50.1",
      },
    };

    const next = reduce(state, {
      t: "settings_patch",
      patch: { reasoningEffort: "low", editMode: "auto" },
    });

    expect(next.settings?.reasoningEffort).toBe("low");
    expect(next.settings?.editMode).toBe("auto");
  });
});

describe("desktop thread layout", () => {
  it("picks a fixed number of unique blank-chat suggestions from a fixed pool", () => {
    expect(pickEmptySuggestions([" a ", "b", "a", "", "c"], 10, () => 0.99)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(pickEmptySuggestions(["a", "b", "c", "d", "e"], 3, () => 0.99)).toEqual(["a", "b", "c"]);
  });

  it("recomputes the thread cap from the latest viewport width", () => {
    const side = 244;
    const ctx = 320;

    expect(
      getThreadMaxWidth({
        viewportWidth: 1000,
        visibleSide: side,
        visibleCtx: ctx,
      }),
    ).toBe(580);
    expect(
      getThreadMaxWidth({
        viewportWidth: 1400,
        visibleSide: side,
        visibleCtx: ctx,
      }),
    ).toBe(756);
    expect(
      getThreadMaxWidth({
        viewportWidth: 1800,
        visibleSide: side,
        visibleCtx: ctx,
      }),
    ).toBe(1120);
  });

  it("treats the context info panel as occupied right-side width", () => {
    expect(
      getVisibleContextWidth({
        ctxCollapsed: true,
        contextInfoOpen: false,
        ctxWidth: 318,
      }),
    ).toBe(0);
    expect(
      getVisibleContextWidth({
        ctxCollapsed: true,
        contextInfoOpen: true,
        ctxWidth: 318,
      }),
    ).toBe(318);
    expect(
      getVisibleContextWidth({
        ctxCollapsed: false,
        contextInfoOpen: false,
        ctxWidth: 318,
      }),
    ).toBe(318);
  });
});

describe("desktop message rollback availability", () => {
  it("allows rollback only for settled non-latest messages", () => {
    const messages = [
      { kind: "user" as const, text: "one", clientId: "u1", turn: 1 },
      {
        kind: "assistant" as const,
        turn: 1,
        segments: [{ kind: "text" as const, text: "done" }],
        pending: false,
      },
    ];

    expect(canRollbackMessage(messages, 0, false)).toBe(true);
    expect(canRollbackMessage(messages, 1, false)).toBe(false);
    expect(canRollbackMessage(messages, 0, true)).toBe(false);
  });

  it("preserves user turn numbers when loading a prior session", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: "demo-session",
        ...loadedSnapshot(),
        messages: [
          { kind: "user", text: "first", turn: 1, messageId: "u-1" },
          {
            kind: "assistant",
            turn: 1,
            messageId: "a-1",
            segments: [{ kind: "text", text: "done" }],
            pending: false,
          },
          { kind: "user", text: "second", turn: 2, messageId: "u-2" },
          {
            kind: "assistant",
            turn: 2,
            messageId: "a-2",
            segments: [{ kind: "text", text: "done again" }],
            pending: false,
          },
        ],
        carryover: {
          totalCostUsd: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          totalCompletionTokens: 0,
        },
      },
    });

    expect(next.messages).toMatchObject([
      { kind: "user", turn: 1 },
      { kind: "assistant", turn: 1 },
      { kind: "user", turn: 2 },
      { kind: "assistant", turn: 2 },
    ]);
  });

  it("streams into the assistant after the current user when loaded turns collide", () => {
    let state = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: "legacy-session",
        ...loadedSnapshot(),
        messages: [
          { kind: "user", text: "first", turn: 1, messageId: "u-1" },
          {
            kind: "assistant",
            turn: 1,
            messageId: "a-1",
            segments: [{ kind: "text", text: "old answer" }],
            pending: false,
          },
          {
            kind: "assistant",
            turn: 2,
            messageId: "a-2",
            segments: [{ kind: "text", text: "legacy colliding answer" }],
            pending: false,
          },
        ],
        carryover: {
          totalCostUsd: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          totalCompletionTokens: 0,
        },
      },
    });

    state = reduce(state, {
      t: "incoming",
      event: {
        type: "user.message",
        id: 1,
        ts: "2026-06-06T00:00:00.000Z",
        turn: 2,
        text: "new prompt",
      },
    });
    state = reduce(state, {
      t: "incoming",
      event: {
        type: "model.turn.started",
        id: 2,
        ts: "2026-06-06T00:00:00.000Z",
        turn: 2,
        model: "deepseek-v4-flash",
        reasoningEffort: "high",
        prefixHash: "test-prefix",
      },
    });
    state = reduce(state, {
      t: "incoming",
      event: {
        type: "model.delta",
        id: 3,
        ts: "2026-06-06T00:00:00.000Z",
        turn: 2,
        channel: "content",
        text: "live answer",
      },
    });

    const turnTwoAssistants = state.messages.filter(
      (m) => m.kind === "assistant" && m.turn === 2,
    );
    expect(turnTwoAssistants).toHaveLength(2);
    expect(turnTwoAssistants[0]).toMatchObject({
      kind: "assistant",
      segments: [{ kind: "text", text: "legacy colliding answer" }],
      pending: false,
    });
    expect(turnTwoAssistants[1]).toMatchObject({
      kind: "assistant",
      segments: [{ kind: "text", text: "live answer" }],
      pending: true,
    });
  });

  it("reconciles the current session without dropping queued sends", () => {
    const state = {
      ...initialState(),
      busy: true,
      currentSession: "demo-session",
      queuedSends: ["next task"],
      messages: [
        { kind: "user" as const, text: "hello", clientId: "c-1", turn: 1 },
        { kind: "assistant" as const, turn: 1, segments: [], pending: true },
      ],
    };

    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$session_reconciled",
        name: "demo-session",
        ...loadedSnapshot("resync"),
        messages: [
          { kind: "user", text: "hello", turn: 1, messageId: "u-1" },
          {
            kind: "assistant",
            turn: 1,
            messageId: "a-1",
            segments: [
              { kind: "reasoning", text: "thinking" },
              { kind: "text", text: "done" },
            ],
            pending: false,
          },
        ],
        carryover: {
          totalCostUsd: 0.01,
          cacheHitTokens: 10,
          cacheMissTokens: 5,
          totalCompletionTokens: 3,
        },
      },
    });

    expect(next.busy).toBe(true);
    expect(next.queuedSends).toEqual(["next task"]);
    expect(next.messages).toMatchObject([
      { kind: "user", turn: 1, text: "hello" },
      {
        kind: "assistant",
        turn: 1,
        pending: false,
        segments: [
          { kind: "reasoning", text: "thinking" },
          { kind: "text", text: "done" },
        ],
      },
    ]);
    expect(next.usage.totalPromptTokens).toBe(15);
  });

  it("keeps live assistant content when a reconcile snapshot is older", () => {
    const state = {
      ...initialState(),
      currentSession: "demo-session",
      messages: [
        { kind: "user" as const, text: "hello", clientId: "c-1", turn: 1 },
        {
          kind: "assistant" as const,
          turn: 1,
          pending: false,
          segments: [{ kind: "text" as const, text: "live answer" }],
        },
      ],
    };

    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$session_reconciled",
        name: "demo-session",
        ...loadedSnapshot("resync"),
        messages: [
          { kind: "user", text: "hello", turn: 1, messageId: "u-1" },
        ],
        carryover: {
          totalCostUsd: 0.01,
          cacheHitTokens: 10,
          cacheMissTokens: 5,
          totalCompletionTokens: 3,
        },
      },
    });

    expect(next.messages).toMatchObject([
      { kind: "user", turn: 1, text: "hello" },
      {
        kind: "assistant",
        turn: 1,
        pending: false,
        segments: [{ kind: "text", text: "live answer" }],
      },
    ]);
    expect(next.usage.totalPromptTokens).toBe(15);
  });

  it("ignores a stale session load after a newer sidebar selection", () => {
    const state = {
      ...initialState(),
      currentSession: "new-session",
      currentSessionId: "new-id",
      bindingId: 4,
      pendingLoadRequestId: "load-new",
      messages: [{ kind: "user" as const, text: "keep me", clientId: "c-1", turn: 1 }],
    };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: "old-session",
        ...loadedSnapshot("load", 3),
        snapshot: {
          ...loadedSnapshot("load", 3).snapshot,
          requestId: "load-old",
        },
        messages: [],
        carryover: {
          totalCostUsd: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          totalCompletionTokens: 0,
        },
      },
    });

    expect(next).toBe(state);
  });

  it("ignores a full-turn response from an old session binding", () => {
    const state = {
      ...initialState(),
      currentSession: "demo-session",
      currentSessionId: "current-id",
      bindingId: 2,
      pendingTurnLoads: { 1: "turn-current" },
    };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$session_turn_loaded",
        name: "demo-session",
        sessionId: "old-id",
        bindingId: 1,
        requestId: "turn-current",
        turn: 1,
        messages: [],
      },
    });

    expect(next).toBe(state);
  });

  it("shows the thinking footer only until live assistant output starts", () => {
    expect(shouldShowThinkingFooter([], true)).toBe(true);
    expect(
      shouldShowThinkingFooter(
        [
          { kind: "user", text: "hello", clientId: "c-1", turn: 1 },
          { kind: "assistant", turn: 1, pending: true, segments: [] },
        ],
        true,
      ),
    ).toBe(true);
    expect(
      shouldShowThinkingFooter(
        [
          { kind: "user", text: "hello", clientId: "c-1", turn: 1 },
          {
            kind: "assistant",
            turn: 1,
            pending: true,
            segments: [{ kind: "reasoning", text: "thinking" }],
          },
        ],
        true,
      ),
    ).toBe(true);
    expect(
      shouldShowThinkingFooter(
        [
          { kind: "user", text: "hello", clientId: "c-1", turn: 1 },
          {
            kind: "assistant",
            turn: 1,
            pending: true,
            segments: [{ kind: "text", text: "answer" }],
          },
        ],
        true,
      ),
    ).toBe(false);
  });
});

describe("desktop API error retry availability", () => {
  const retryableError = {
    kind: "error" as const,
    id: "error-1",
    message: "connection refused",
    turn: 1,
    retryable: true,
  };

  it("offers retry only for the latest retryable API failure while idle", () => {
    const messages = [
      { kind: "user" as const, text: "hello", clientId: "client-1", turn: 1 },
      retryableError,
      { kind: "status" as const, text: "request ended" },
    ];

    expect(canRetryErrorMessage(messages, 1, false)).toBe(true);
    expect(canRetryErrorMessage(messages, 1, true)).toBe(false);
    expect(
      canRetryErrorMessage(
        [...messages, { kind: "user", text: "new", clientId: "client-2", turn: 2 }],
        1,
        false,
      ),
    ).toBe(false);
    expect(canRetryErrorMessage([{ ...retryableError, retryable: false }], 0, false)).toBe(false);
  });
});

describe("settings change notifications", () => {
  it("suppresses right-bottom toast for settings-only changes", () => {
    expect(shouldShowSettingsChangeToast("model")).toBe(false);
    expect(shouldShowSettingsChangeToast("reasoningEffort")).toBe(false);
    expect(shouldShowSettingsChangeToast("editMode")).toBe(false);
    expect(shouldShowSettingsChangeToast("language")).toBe(false);
  });
});

describe("Desktop App reducer — queued sends", () => {
  it("moves a queued send to the front when prioritizing", () => {
    const next = reduce(
      { ...initialState(), queuedSends: ["first", "second", "third"] },
      { t: "prioritize_queued_send", index: 2 },
    );

    expect(next.queuedSends).toEqual(["third", "first", "second"]);
  });
});
