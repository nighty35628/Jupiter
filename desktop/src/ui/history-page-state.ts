import type { ChatMessage } from "../App";
import type { SessionHistory } from "../protocol";

export const HISTORY_INDEX_ORIGIN = 1_000_000_000;

export type ActiveConversationTurn = { turnId?: string; conversationViewId?: string; clientId?: string };

function matchesActiveTurn(row: ChatMessage, active?: ActiveConversationTurn): boolean {
  if (!active || (row.kind !== "user" && row.kind !== "assistant")) return false;
  if (active.conversationViewId && row.conversationViewId && row.conversationViewId !== active.conversationViewId) return false;
  return !!((active.turnId && row.turnId === active.turnId) ||
    (row.kind === "user" && active.clientId && row.clientId === active.clientId));
}

/** Stable logical identity wins over a branch-local display turn number. */
export function sameConversationTurn(a: ChatMessage, b: ChatMessage): boolean {
  if ((a.kind !== "user" && a.kind !== "assistant") || (b.kind !== "user" && b.kind !== "assistant")) return false;
  if (a.turnId && b.turnId) return a.turnId === b.turnId;
  if (a.conversationViewId && b.conversationViewId && a.conversationViewId !== b.conversationViewId) return false;
  // A stable incoming turn must not absorb an unrelated numbered history row.
  if (a.turnId || b.turnId) {
    const user = a.kind === "user" ? a : b.kind === "user" ? b : undefined;
    const other = user === a ? b : a;
    return !!user && other.kind === "user" && !!user.clientId && user.clientId === other.clientId;
  }
  return a.turn === b.turn;
}

export type HistoryPageState = SessionHistory & {
  firstItemIndex: number;
  viewId?: string;
  pending?: { requestId: string; cursor?: string; generation: string };
  error?: string;
  retiredGenerations?: string[];
};

export function historyPageState(history: SessionHistory): HistoryPageState {
  return { ...history, firstItemIndex: HISTORY_INDEX_ORIGIN, viewId: history.generation };
}

export function retainedHistoryTailIndex(
  current: ChatMessage[], next: ChatMessage[], firstItemIndex: number,
  key: (message: ChatMessage, index: number) => string,
): number {
  const last = current.length - 1;
  if (last < 0) return HISTORY_INDEX_ORIGIN;
  const lastKey = key(current[last], last);
  const retainedAt = next.findIndex((row, index) => key(row, index) === lastKey);
  return retainedAt < 0 ? HISTORY_INDEX_ORIGIN : firstItemIndex + last - retainedAt;
}

/** Rewrites replace persisted pages, but the in-flight turn still owns its UI. */
export function replaceHistoryKeepingLiveTail(
  current: ChatMessage[],
  incoming: ChatMessage[],
  key: (message: ChatMessage, index: number) => string,
  active?: ActiveConversationTurn,
): ChatMessage[] {
  let pendingIndex = -1;
  for (let index = current.length - 1; index >= 0; index--) {
    const row = current[index];
    if (row.kind === "assistant" && (active?.turnId ? row.turnId === active.turnId : row.pending &&
      (!active?.conversationViewId || !row.conversationViewId || row.conversationViewId === active.conversationViewId))) { pendingIndex = index; break; }
  }
  let start = pendingIndex;
  for (let index = pendingIndex < 0 ? current.length - 1 : pendingIndex; index >= 0; index--) {
    const row = current[index];
    if (row.kind === "user" && (!(active?.turnId || active?.clientId) || matchesActiveTurn(row, active)) &&
      (!active?.conversationViewId || !row.conversationViewId || row.conversationViewId === active.conversationViewId)) { start = index; break; }
  }
  if (start < 0) return incoming;
  const anchor = current[start];
  const live = current.slice(start).filter((row) => !active ||
    (row.kind !== "user" && row.kind !== "assistant") ||
    (active.turnId || active.clientId ? matchesActiveTurn(row, active) || sameConversationTurn(row, anchor)
      : !row.conversationViewId || row.conversationViewId === active.conversationViewId));
  const activeUser = live.find((row) => row.kind === "user");
  const snapshotUser = activeUser?.kind === "user" ? incoming.find((row): row is Extract<ChatMessage, { kind: "user" }> => row.kind === "user" &&
    ((!!row.clientId && row.clientId === activeUser.clientId) || (row.turnId && row.turnId === activeUser.turnId) || (key(row, 0) === key(activeUser, 0) && row.text === activeUser.text))) : undefined;
  const snapshotAssistant = snapshotUser?.kind === "user"
    ? incoming.find((row): row is Extract<ChatMessage, { kind: "assistant" }> => row.kind === "assistant" && sameConversationTurn(row, snapshotUser) && row.rollbackRef !== null) : undefined;
  const preserved = live.map((row) => {
    if (row.kind !== "user" && row.kind !== "assistant") return row;
    const replacement = row === activeUser ? snapshotUser
      : row.kind === "assistant" && activeUser && sameConversationTurn(row, activeUser) ? snapshotAssistant : undefined;
    const turn = replacement && "turn" in replacement ? replacement.turn
      : snapshotUser && activeUser && sameConversationTurn(row, activeUser) ? snapshotUser.turn : row.turn;
    // A ref from the retired generation must never authorize a new turn.
    const rollbackRef = replacement && "rollbackRef" in replacement ? replacement.rollbackRef
      : row.rollbackRef === undefined ? undefined : null;
    if (row.turn === turn && JSON.stringify(row.rollbackRef) === JSON.stringify(rollbackRef) &&
      (!replacement?.turnId || row.turnId === replacement.turnId) &&
      (!replacement?.conversationViewId || row.conversationViewId === replacement.conversationViewId)) return row;
    return { ...row, turn, rollbackRef, turnId: replacement?.turnId ?? row.turnId, conversationViewId: replacement?.conversationViewId ?? row.conversationViewId };
  });
  const liveKeys = new Set(preserved.map(key));
  const prefix = incoming.filter((row, index) => row !== snapshotUser && row !== snapshotAssistant && !liveKeys.has(key(row, index)));
  return [...prefix, ...preserved];
}

/** Detail may contain leading orphan rows whose display turns overlap user turns. */
export function upsertHistoryTurn(
  current: ChatMessage[], incoming: ChatMessage[], turn: number,
  key: (message: ChatMessage, index: number) => string,
): ChatMessage[] {
  const loaded = [...new Map(incoming.map((row, index) => [key(row, index), row])).values()];
  const loadedKeys = new Set(loaded.map(key));
  const target = loaded.find((row) => (row.kind === "user" || row.kind === "assistant") && row.turn === turn);
  const belongsToTurn = (row: ChatMessage) => (row.kind === "user" || row.kind === "assistant") && (target ? sameConversationTurn(row, target) : row.turn === turn) &&
    !(row.kind === "assistant" && (row.rollbackRef === null || row.messageId?.startsWith("a-orphan-")));
  const firstIndex = current.findIndex(belongsToTurn);
  const messages = current.filter((row, index) => !belongsToTurn(row) || loadedKeys.has(key(row, index)));
  for (let index = 0; index < loaded.length; index++) {
    const row = loaded[index];
    const position = messages.findIndex((message, at) => key(message, at) === key(row, index));
    if (position >= 0) {
      if (JSON.stringify(messages[position]) !== JSON.stringify(row)) messages[position] = row;
      continue;
    }
    const nextKeys = new Set(loaded.slice(index + 1).map(key));
    const nextIndex = messages.findIndex((message, at) => nextKeys.has(key(message, at)));
    const previousKey = index > 0 ? key(loaded[index - 1], index - 1) : undefined;
    const previousIndex = previousKey === undefined ? -1 : messages.findIndex((message, at) => key(message, at) === previousKey);
    const at = nextIndex >= 0 ? nextIndex : previousIndex >= 0 ? previousIndex + 1 : firstIndex < 0 ? messages.length : Math.min(firstIndex, messages.length);
    messages.splice(at, 0, row);
  }
  return messages;
}

/** Page overlap must not remount forms or replace streamed/expanded detail. */
export function mergeHistoryMessages(
  current: ChatMessage[],
  incoming: ChatMessage[],
  key: (message: ChatMessage, index: number) => string,
  preferCurrent = true,
  active?: ActiveConversationTurn,
): { messages: ChatMessage[]; prepended: number } {
  const messages = [...current];
  const positions = new Map(current.map((message, index) => [key(message, index), index]));
  const stablePositions = new Map(current.flatMap((row, index) =>
    (row.kind === "user" || row.kind === "assistant") && row.turnId ? [[`${row.kind}:${row.turnId}`, index] as const] : []));
  const additions = new Map<string, ChatMessage>();
  for (const message of incoming) {
    const id = key(message, 0);
    const stable = (message.kind === "user" || message.kind === "assistant") && message.turnId ? stablePositions.get(`${message.kind}:${message.turnId}`) : undefined;
    const direct = positions.get(id);
    const directRow = direct === undefined ? undefined : current[direct];
    const directCompatible = !directRow || !((directRow.kind === "user" || directRow.kind === "assistant") && (message.kind === "user" || message.kind === "assistant")) ||
      (!(directRow.turnId && message.turnId && directRow.turnId !== message.turnId) &&
        !(directRow.conversationViewId && message.conversationViewId && directRow.conversationViewId !== message.conversationViewId));
    const matched = stable ?? (directCompatible ? direct : undefined) ?? current.findIndex((row) => {
      if (row.kind === "user" && message.kind === "user") {
        return sameConversationTurn(row, message) && row.rollbackable !== false &&
          ((!!row.clientId && row.clientId === message.clientId) || (row.messageId === row.clientId && row.text === message.text));
      }
      return row.kind === "assistant" && message.kind === "assistant" && sameConversationTurn(row, message) &&
        (!row.messageId || row.messageId.startsWith("a-live-") || row.messageId.startsWith("a-retry-"));
    });
    if (matched < 0) {
      additions.set(id, message);
      continue;
    }
    const previous = messages[matched];
    const replacement = previous.kind === "user" && message.kind === "user"
      ? { ...message, messageId: previous.messageId ?? message.messageId, clientId: previous.clientId }
      : previous.kind === "assistant" && message.kind === "assistant"
        ? { ...message, messageId: previous.messageId ?? message.messageId } : message;
    const withRollback = (previous.kind === "user" || previous.kind === "assistant") &&
      (message.kind === "user" || message.kind === "assistant") && message.rollbackRef !== undefined &&
      JSON.stringify(previous.rollbackRef) !== JSON.stringify(message.rollbackRef)
      ? { ...previous, rollbackRef: message.rollbackRef } : previous;
    if (
      preferCurrent ||
      (previous.kind === "assistant" && previous.pending) ||
      ((previous.kind === "assistant" || previous.kind === "user") &&
        !previous.displayTruncated &&
        (message.kind === "assistant" || message.kind === "user") && message.displayTruncated) ||
      JSON.stringify(previous) === JSON.stringify(replacement)
    ) {
      messages[matched] = (withRollback.kind === "user" || withRollback.kind === "assistant") && (message.kind === "user" || message.kind === "assistant") &&
        (withRollback.turn !== message.turn || (message.turnId !== undefined && message.turnId !== withRollback.turnId) ||
          (message.conversationViewId !== undefined && message.conversationViewId !== withRollback.conversationViewId))
        ? { ...withRollback, turn: message.turn, turnId: message.turnId ?? withRollback.turnId, conversationViewId: message.conversationViewId ?? withRollback.conversationViewId } : withRollback;
      continue;
    }
    messages[matched] = replacement;
  }
  const activeUser = messages.find((row) => row.kind === "user" && matchesActiveTurn(row, active));
  const liveTurns = new Set(messages.flatMap((row) => row.kind === "assistant" && row.turnId && row.rollbackRef === undefined &&
    (row.pending || row.messageId?.startsWith("a-live-")) ? [row.turnId] : []));
  const isLive = (row: ChatMessage): boolean => matchesActiveTurn(row, active) ||
    !!(activeUser && sameConversationTurn(row, activeUser)) ||
    ((row.kind === "user" || row.kind === "assistant") && !!row.turnId && liveTurns.has(row.turnId));
  // Both pages and snapshots may overlap; insert only missing identities in turn order.
  for (const message of additions.values()) {
    if (message.kind !== "user" && message.kind !== "assistant") continue;
    if (message.turnId) {
      const group = messages.findIndex((row) => sameConversationTurn(row, message));
      if (group >= 0) {
        const at = message.kind === "user" ? group : group + 1;
        messages.splice(at, 0, message);
        continue;
      }
      const at = messages.findIndex((row) => (row.kind === "user" || row.kind === "assistant") &&
        (isLive(row) || row.turn > message.turn));
      messages.splice(at < 0 ? messages.length : at, 0, message);
      continue;
    }
    const at = messages.findIndex((row) =>
      (row.kind === "user" || row.kind === "assistant") &&
      (isLive(row) || row.turn > message.turn || (row.turn === message.turn && row.kind === "assistant" && message.kind === "user")),
    );
    messages.splice(at < 0 ? messages.length : at, 0, message);
  }
  const firstKey = current[0] ? key(current[0], 0) : undefined;
  const prepended = firstKey === undefined ? 0 : Math.max(0, messages.findIndex((row, index) => key(row, index) === firstKey));
  const unchanged = messages.length === current.length && messages.every((row, index) => row === current[index]);
  return { messages: unchanged ? current : messages, prepended };
}
