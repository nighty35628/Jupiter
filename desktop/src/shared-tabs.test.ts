// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyIncoming, chatMessageKey, reduce, type ChatMessage } from "./App";
import type { LoadedMessage, SessionLoadedEvent } from "./protocol";
import { mergeHistoryMessages, replaceHistoryKeepingLiveTail, upsertHistoryTurn } from "./ui/history-page-state";
import { conversationDraftKey, handoffImageDraft, migrateConversationDraft, readImageDraft, writeImageDraft } from "./ui/image-draft-store";

vi.mock("./CommandPalette", () => ({ CommandPalette: () => null, Toast: () => null, buildCommands: () => [], useCommandPalette: () => ({ open: false, setOpen: vi.fn() }) }));
vi.mock("./Markdown", () => ({ WorkspaceProvider: ({ children }: { children: unknown }) => children }));

const assistant = (turnId: string, turn = 1, pending = false): ChatMessage => ({
  kind: "assistant", turn, turnId, conversationViewId: turnId === "A" ? "default" : "view-b",
  messageId: pending ? `a-live-${turn}` : `persisted-${turnId}`, pending,
  segments: [{ kind: "text", text: turnId }],
});
const loaded = (messages: LoadedMessage[] = []): SessionLoadedEvent => ({
  type: "$session_loaded", name: "shared", messages, runtimeReady: true,
  snapshot: { sessionId: "sid", bindingId: 1, reason: "resync", conversationViewId: "default", payloadBytes: 0, truncated: false },
  history: { generation: "g1", totalTurns: 1, sourceSize: 100, hasMore: false },
  sessionFiles: [], carryover: { totalCostUsd: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalCompletionTokens: 0 },
});
function state() {
  return { ready: true, busy: true, bindingId: 1, currentSession: "shared", currentSessionId: "sid", conversationViewId: "default",
    messages: [assistant("A", 1, true)], pendingConfirms: [{ id: 1 }], pendingPathAccess: [], pendingChoices: [], pendingPlans: [], pendingCheckpoints: [], pendingRevisions: [],
    pendingTurnLoads: {}, expandedTurns: [1], queuedSends: ["queued"], sideChats: [], sessionFiles: [],
    activePlan: { plan: "keep" }, transientStatus: "running", history: { ...loaded().history!, firstItemIndex: 1_000_000_000, viewId: "stable-page" },
    promptPrediction: { completionId: "prediction" }, usage: { reservedTokens: 1 },
  } as unknown as Parameters<typeof applyIncoming>[0];
}

describe("shared tabs identity and refresh", { retry: 0 }, () => {
  it.each([true, false])("keeps a user-only live turn together before its first assistant (acknowledged=%s)", (acknowledged) => {
    const user: ChatMessage = { kind: "user", text: "A", turn: 1, clientId: "c-A", messageId: "c-A", conversationViewId: "default", ...(acknowledged ? { turnId: "A" } : {}) };
    const incoming: ChatMessage[] = [
      { kind: "user", text: "B", turn: 1, clientId: "c-B", messageId: "u-B", turnId: "B", conversationViewId: "view-b" }, assistant("B"),
    ];
    const next = mergeHistoryMessages([user], incoming, chatMessageKey, false,
      { turnId: acknowledged ? "A" : undefined, conversationViewId: "default", clientId: "c-A" });
    expect(next.messages.map((row) => row.kind === "user" ? row.text : "turnId" in row ? row.turnId : row.kind)).toEqual(["B", "B", "A"]);
    expect(next.messages.at(-1)).toBe(user);
  });

  it.each(["$session_loaded", "$session_reconciled"] as const)("rejects %s below the newest notification even after dismissing it", (type) => {
    const before = { ...state(), historyVersion: 1 };
    const notified = applyIncoming(before, { type: "$shared_session_updated", sessionId: "sid", historyVersion: 3, sourceViewId: "view-b" });
    const stale = { ...loaded([assistant("B") as LoadedMessage]), type, busy: false,
      snapshot: { ...loaded().snapshot, historyVersion: 2 } };
    expect(applyIncoming(notified, stale)).toBe(notified);
    const dismissed = reduce(notified, { t: "dismiss_shared_update" });
    expect(dismissed.sharedSessionUpdate).toBeUndefined();
    expect(applyIncoming(dismissed, stale)).toBe(dismissed);
    const fresh = applyIncoming(dismissed, { ...stale, busy: true, snapshot: { ...stale.snapshot, historyVersion: 3 } });
    expect(fresh.historyVersion).toBe(3);
    expect(fresh.pendingConfirms).toBe(before.pendingConfirms);
    expect(fresh.queuedSends).toBe(before.queuedSends);
  });

  it("resets the notification floor when explicitly loading a different session", () => {
    const notified = applyIncoming({ ...state(), historyVersion: 1 }, { type: "$shared_session_updated", sessionId: "sid", historyVersion: 9, sourceViewId: "view-b" });
    const next = applyIncoming(notified, { ...loaded(), name: "other", snapshot: {
      ...loaded().snapshot, sessionId: "other-sid", bindingId: 2, reason: "load", historyVersion: 1,
    } });
    expect(next.currentSessionId).toBe("other-sid");
    expect(next.historyVersion).toBe(1);
    expect(next.sharedSessionUpdate).toBeUndefined();
  });
  it("does not attach another view's committed assistant to a same-number live turn", () => {
    const current = assistant("A", 1, true);
    const next = mergeHistoryMessages([current], [assistant("B")], chatMessageKey, false);
    expect(next.messages).toHaveLength(2);
    expect(next.messages.find((row) => "turnId" in row && row.turnId === "A")).toBe(current);
  });
  it("matches a live turn by stable identity when its committed display number changes", () => {
    const current = assistant("A", 1, true);
    const next = mergeHistoryMessages([current], [assistant("A", 3)], chatMessageKey, false);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({ turnId: "A", turn: 3, pending: true });
  });
  it("keeps a committed foreign turn contiguous before the in-flight local turn", () => {
    const user = (id: string): ChatMessage => ({ kind: "user", turn: 1, turnId: id, conversationViewId: id === "A" ? "default" : "view-b", clientId: `c-${id}`, messageId: `u-${id}`, text: id });
    const next = mergeHistoryMessages([user("A"), assistant("A", 1, true)], [user("B"), assistant("B")], chatMessageKey, false);
    expect(next.messages.map((row) => "turnId" in row ? `${row.turnId}:${row.kind}` : row.kind)).toEqual(["B:user", "B:assistant", "A:user", "A:assistant"]);
  });
  it("uses stable row keys even if two views reuse a provisional message ID", () => {
    expect(chatMessageKey(assistant("A", 1, true), 0)).not.toBe(chatMessageKey(assistant("B", 1, true), 0));
    const merged = mergeHistoryMessages([assistant("A", 1, true)], [assistant("B", 1, true)], chatMessageKey);
    expect(merged.messages).toHaveLength(2);
  });
  it("loading detail for one stable turn never deletes a same-number sibling", () => {
    const a = assistant("A");
    const b = assistant("B");
    const detailed = { ...b, segments: [{ kind: "text" as const, text: "full B" }] };
    const rows = upsertHistoryTurn([a, b], [detailed], 1, chatMessageKey);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(a);
    expect(rows[1]).toBe(detailed);
  });
  it("a rewrite keeps the owning turn even after its final event and another view's commit", () => {
    const a = assistant("A");
    const current: ChatMessage[] = [
      { kind: "user", text: "A", clientId: "cA", turn: 1, turnId: "A", conversationViewId: "default" }, a,
      { kind: "user", text: "B", clientId: "cB", turn: 1, turnId: "B", conversationViewId: "view-b" }, assistant("B"),
    ];
    const rows = replaceHistoryKeepingLiveTail(current, [assistant("B")], chatMessageKey, { turnId: "A", conversationViewId: "default" });
    expect(rows.filter((row) => "turnId" in row && row.turnId === "A")).toHaveLength(2);
    expect(rows.at(-1)).toMatchObject({ turnId: "A", kind: "assistant" });
    expect(rows.filter((row) => "turnId" in row && row.turnId === "B")).toHaveLength(1);
  });
  it("shared notices invalidate prediction without touching runtime state", () => {
    const before = state();
    const next = applyIncoming(before, { type: "$shared_session_updated", sessionId: "sid", historyVersion: 2, sourceViewId: "view-b" });
    expect(next.promptPrediction).toBeUndefined();
    expect(next.sharedSessionUpdate).toMatchObject({ historyVersion: 2, sourceViewId: "view-b" });
    expect(next.messages).toBe(before.messages);
    expect(next.pendingConfirms).toBe(before.pendingConfirms);
    expect(next.queuedSends).toBe(before.queuedSends);
    expect(next.busy).toBe(true);
    expect(applyIncoming(next, { type: "$shared_session_updated", sessionId: "other", historyVersion: 3, sourceViewId: "view-b" })).toBe(next);
  });
  it("rejects stale resync snapshots and does not cancel an explicitly requested session switch", () => {
    const before = { ...state(), historyVersion: 3 };
    expect(applyIncoming(before, { ...loaded(), snapshot: { ...loaded().snapshot, historyVersion: 2 } })).toBe(before);
    const switching = { ...before, pendingLoadRequestId: "switch" };
    expect(applyIncoming(switching, loaded())).toBe(switching);
  });
  it("same-number tool IDs in a sibling turn do not absorb progress or results", () => {
    const tool = { kind: "tool" as const, callId: "same-call", name: "read_file", args: "{}", startedAt: 0 };
    const a = { ...assistant("A", 1, true), segments: [tool] } as ChatMessage;
    const b = { ...assistant("B"), segments: [{ ...tool, result: "B result", ok: true }] } as ChatMessage;
    const next = applyIncoming({ ...state(), activeTurnId: "A", messages: [a, b] }, {
      type: "tool.result", id: 3, ts: "now", turn: 1, callId: "same-call", ok: true, output: "A result",
    });
    expect(next.messages[0]).toMatchObject({ segments: [{ result: "A result" }] });
    expect(next.messages[1]).toBe(b);
  });
  it("a resync snapshot preserves approvals, status, queue and pagination identity", () => {
    const before = state();
    const next = applyIncoming(before, loaded([assistant("B") as LoadedMessage]));
    expect(next.pendingConfirms).toBe(before.pendingConfirms);
    expect(next.queuedSends).toBe(before.queuedSends);
    expect(next.activePlan).toBe(before.activePlan);
    expect(next.expandedTurns).toBe(before.expandedTurns);
    expect(next.transientStatus).toBe("running");
    expect(next.history?.viewId).toBe("stable-page");
    expect(next.messages.some((row) => row.kind === "assistant" && row.turnId === "A" && row.pending)).toBe(true);
  });
  it("live events address their stable turn instead of the other view's matching display number", () => {
    const before = { ...state(), messages: [assistant("B")] };
    const next = applyIncoming(before, { type: "model.delta", id: 1, ts: "now", turn: 1, turnId: "A", conversationViewId: "default", channel: "content", text: "new" });
    expect(next.messages).toHaveLength(2);
    expect(next.messages[0]).toBe(before.messages[0]);
    expect(next.messages[1]).toMatchObject({ turnId: "A", conversationViewId: "default", pending: true });
  });
});

describe("shared tabs draft migration", { retry: 0 }, () => {
  beforeEach(() => localStorage.clear());
  it("keeps the complete local draft on a failed handoff and retries without claiming legacy state", () => {
    const source = `new:${crypto.randomUUID()}`;
    const sid = crypto.randomUUID();
    const target = conversationDraftKey(sid, crypto.randomUUID());
    const image = { kind: "image" as const, id: "a".repeat(64), name: "draft.png", mime: "image/png" as const, width: 2, height: 1, bytes: 12 };
    const record = { text: "local", attachments: [image], queue: [{ text: "", payload: { clientId: "queued", attachments: [image], ask: true } }], pending: { clientId: "pending", draft: { text: "sent", attachments: [image] }, ask: true, plan: false } };
    writeImageDraft(source, () => record);
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    try { expect(handoffImageDraft(source, target)).toBe(false); } finally { setItem.mockRestore(); }
    expect(readImageDraft(source)).toEqual(record);
    expect(localStorage.getItem(`jupiter.image-draft.v1:${source}`)).toContain("local");
    expect(handoffImageDraft(source, target)).toBe(true);
    expect(readImageDraft(target)).toEqual(record);
    expect(localStorage.getItem(`jupiter.image-draft.v1:${source}`)).toBeNull();
    expect(localStorage.getItem(`jupiter.image-draft.migrated:${sid}`)).toBeNull();
  });

  it("keeps both drafts when a local handoff conflicts with a real scoped draft", () => {
    const source = `new:${crypto.randomUUID()}`;
    const target = conversationDraftKey(crypto.randomUUID(), crypto.randomUUID());
    writeImageDraft(source, () => ({ text: "local must survive" }));
    writeImageDraft(target, () => ({ text: "scoped must survive" }));
    expect(handoffImageDraft(source, target)).toBe(false);
    expect(readImageDraft(source).text).toBe("local must survive");
    expect(readImageDraft(target).text).toBe("scoped must survive");
  });
  it("repairs an empty scoped placeholder when the actual default identity arrives late", () => {
    const sid = crypto.randomUUID();
    const view = crypto.randomUUID();
    const record = { text: "legacy", queue: [{ text: "queued", payload: { clientId: "once" } }], pending: { clientId: "pending", draft: { text: "sent" }, ask: false, plan: false } };
    writeImageDraft(sid, () => record);
    migrateConversationDraft(sid, view, [], undefined);
    writeImageDraft(conversationDraftKey(sid, view), () => ({ text: "", attachments: [], queue: [] }));
    migrateConversationDraft(sid, view, [], view);
    expect(readImageDraft(conversationDraftKey(sid, view))).toEqual(record);
    expect(localStorage.getItem(`jupiter.image-draft.v1:${sid}`)).toBeNull();
  });

  it("does not delete an unclaimed legacy draft when a real scoped draft already exists", () => {
    const sid = crypto.randomUUID();
    writeImageDraft(sid, () => ({ text: "legacy must survive", queue: ["legacy queued"] }));
    writeImageDraft(conversationDraftKey(sid, "default"), () => ({ text: "new scoped draft" }));
    migrateConversationDraft(sid, "default");
    expect(readImageDraft(conversationDraftKey(sid, "default")).text).toBe("new scoped draft");
    expect(localStorage.getItem(`jupiter.image-draft.v1:${sid}`)).toContain("legacy must survive");
    expect(localStorage.getItem(`jupiter.image-draft.migrated:${sid}`)).toBeNull();
  });
  it("only the default view claims the legacy draft including its queue and pending identity", () => {
    const sid = crypto.randomUUID();
    const record = { text: "draft", attachments: [], queue: [{ text: "queued", payload: { clientId: "queued-id", ask: true } }], pending: { clientId: "pending-id", draft: { text: "sent" }, ask: true, plan: false } };
    writeImageDraft(sid, () => record);
    migrateConversationDraft(sid, "view-b");
    expect(readImageDraft(conversationDraftKey(sid, "view-b"))).toMatchObject({ text: "" });
    migrateConversationDraft(sid, "default");
    expect(readImageDraft(conversationDraftKey(sid, "default"))).toEqual(record);
    writeImageDraft(conversationDraftKey(sid, "default"), () => ({ text: "new" }));
    migrateConversationDraft(sid, "default");
    expect(readImageDraft(conversationDraftKey(sid, "default")).text).toBe("new");
    expect(localStorage.getItem(`jupiter.image-draft.v1:${sid}`)).toBeNull();
  });
  it("does not overwrite an existing scoped draft", () => {
    const sid = crypto.randomUUID();
    writeImageDraft(sid, () => ({ text: "old" }));
    writeImageDraft(conversationDraftKey(sid, "default"), () => ({ text: "existing" }));
    migrateConversationDraft(sid, "default");
    expect(readImageDraft(conversationDraftKey(sid, "default")).text).toBe("existing");
  });
  it("falls back to the old name key and remains claimed after a module reload", async () => {
    const sid = crypto.randomUUID();
    const name = crypto.randomUUID();
    writeImageDraft(name, () => ({ text: "name-key draft" }));
    migrateConversationDraft(sid, "default", [name]);
    vi.resetModules();
    const fresh = await import("./ui/image-draft-store");
    expect(fresh.readImageDraft(fresh.conversationDraftKey(sid, "default")).text).toBe("name-key draft");
    fresh.migrateConversationDraft(sid, "view-c", [name]);
    expect(fresh.readImageDraft(fresh.conversationDraftKey(sid, "view-c")).text).toBe("");
  });
  it("retains the legacy draft if saving the scoped copy fails", () => {
    const sid = crypto.randomUUID();
    writeImageDraft(sid, () => ({ text: "must survive" }));
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    try { migrateConversationDraft(sid, "default"); } finally { setItem.mockRestore(); }
    expect(localStorage.getItem(`jupiter.image-draft.v1:${sid}`)).toContain("must survive");
    expect(localStorage.getItem(`jupiter.image-draft.migrated:${sid}`)).toBeNull();
    migrateConversationDraft(sid, "default");
    expect(readImageDraft(conversationDraftKey(sid, "default")).text).toBe("must survive");
  });
});
