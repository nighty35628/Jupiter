import type { IncomingEvent, OutgoingCommand } from "../protocol";
import { EMPTY_PET_TAB_ACTIVITY, type PetBaseActivity, type PetTabActivity } from "./types";

function appendUnique(items: readonly string[], value: string): readonly string[] {
  return items.includes(value) ? items : [...items, value];
}

function remove(items: readonly string[], values: readonly string[]): readonly string[] {
  const next = items.filter((item) => !values.includes(item));
  return next.length === items.length ? items : next;
}

function updateActivity(state: PetTabActivity, patch: Partial<PetTabActivity>): PetTabActivity {
  return { ...state, ...patch, updatedAt: Date.now() };
}

function approvalKey(event: IncomingEvent): string | null {
  switch (event.type) {
    case "$confirm_required":
      return `confirm:${event.id}`;
    case "$path_access_required":
      return `path:${event.id}`;
    case "$choice_required":
      return `choice:${event.id}`;
    case "$plan_required":
      return `plan:${event.id}`;
    case "$checkpoint_required":
      return `checkpoint:${event.id}`;
    case "$revision_required":
      return `revision:${event.id}`;
    default:
      return null;
  }
}

export function petIncomingAffectsActivity(event: IncomingEvent): boolean {
  if (approvalKey(event)) return true;
  switch (event.type) {
    case "$tab_opened":
    case "user.message":
    case "model.turn.started":
    case "tool.preparing":
    case "tool.intent":
    case "tool.result":
    case "$error":
    case "error":
    case "$turn_complete":
    case "$session_loaded":
    case "$session_reconciled":
    case "$session_empty":
      return true;
    default:
      return false;
  }
}

export function derivePetBaseActivity(
  activity?: PetTabActivity,
  busyFallback = false,
): PetBaseActivity {
  const current = activity ?? EMPTY_PET_TAB_ACTIVITY;
  if (current.pendingApprovals.length > 0) return "waiting";
  if (current.activeToolCalls.length > 0 || current.skillRunning) return "working";
  return current.busy || busyFallback ? "thinking" : "idle";
}

export function petOutgoingWaitsForDelivery(command: OutgoingCommand): boolean {
  switch (command.cmd) {
    case "user_input":
    case "ask_light":
    case "skill_run":
    case "confirm_response":
    case "choice_response":
    case "plan_response":
    case "checkpoint_response":
    case "revision_response":
      return true;
    default:
      return false;
  }
}

export function reducePetIncoming(
  current: PetTabActivity | undefined,
  event: IncomingEvent,
): PetTabActivity {
  const state = current ?? EMPTY_PET_TAB_ACTIVITY;
  const required = approvalKey(event);
  if (required) {
    const pendingApprovals = appendUnique(state.pendingApprovals, required);
    return pendingApprovals === state.pendingApprovals
      ? state
      : updateActivity(state, { pendingApprovals });
  }

  switch (event.type) {
    case "$tab_opened":
      return event.busy === state.busy
        ? state
        : updateActivity(state, { busy: Boolean(event.busy) });
    case "user.message":
    case "model.turn.started":
      if (
        state.busy &&
        !state.turnFailed &&
        !state.turnAborted &&
        state.completionOutcome === null
      ) {
        return state;
      }
      return updateActivity(state, {
        busy: true,
        turnFailed: false,
        turnAborted: false,
        completionOutcome: null,
      });
    case "tool.preparing":
    case "tool.intent": {
      const activeToolCalls = appendUnique(state.activeToolCalls, event.callId);
      if (activeToolCalls === state.activeToolCalls && state.busy) return state;
      return updateActivity(state, {
        busy: true,
        activeToolCalls,
      });
    }
    case "tool.result": {
      const activeToolCalls = remove(state.activeToolCalls, [event.callId]);
      return activeToolCalls === state.activeToolCalls
        ? state
        : updateActivity(state, { activeToolCalls });
    }
    case "$error":
      return state.turnFailed ? state : updateActivity(state, { turnFailed: true });
    case "error":
      return event.recoverable || state.turnFailed
        ? state
        : updateActivity(state, { turnFailed: true });
    case "$turn_complete":
      return updateActivity(state, {
        busy: false,
        activeToolCalls: [],
        pendingApprovals: [],
        skillRunning: false,
        completionSequence: state.completionSequence + 1,
        completionOutcome: state.turnAborted ? null : state.turnFailed ? "failure" : "success",
        turnFailed: false,
        turnAborted: false,
      });
    case "$session_loaded":
    case "$session_reconciled":
      return updateActivity(state, {
        busy: Boolean(event.busy),
        activeToolCalls: [],
        pendingApprovals: [],
        skillRunning: false,
        turnFailed: false,
        turnAborted: false,
        completionOutcome: null,
        resetSequence: state.resetSequence + 1,
      });
    case "$session_empty":
      return updateActivity(state, {
        busy: false,
        activeToolCalls: [],
        pendingApprovals: [],
        skillRunning: false,
        turnFailed: false,
        turnAborted: false,
        completionOutcome: null,
        resetSequence: state.resetSequence + 1,
      });
    default:
      return state;
  }
}

export function reducePetOutgoing(
  current: PetTabActivity | undefined,
  command: OutgoingCommand,
): PetTabActivity {
  const state = current ?? EMPTY_PET_TAB_ACTIVITY;
  switch (command.cmd) {
    case "user_input":
    case "ask_light":
      return updateActivity(state, {
        busy: true,
        turnFailed: false,
        turnAborted: false,
        completionOutcome: null,
      });
    case "skill_run":
      return updateActivity(state, {
        busy: true,
        skillRunning: true,
        turnFailed: false,
        turnAborted: false,
        completionOutcome: null,
      });
    case "abort":
      return state.turnAborted ? state : updateActivity(state, { turnAborted: true });
    case "confirm_response": {
      const pendingApprovals = remove(state.pendingApprovals, [
        `confirm:${command.id}`,
        `path:${command.id}`,
      ]);
      return pendingApprovals === state.pendingApprovals
        ? state
        : updateActivity(state, { pendingApprovals });
    }
    case "choice_response":
    case "plan_response":
    case "checkpoint_response":
    case "revision_response": {
      const kind = command.cmd.replace("_response", "");
      const pendingApprovals = remove(state.pendingApprovals, [`${kind}:${command.id}`]);
      return pendingApprovals === state.pendingApprovals
        ? state
        : updateActivity(state, { pendingApprovals });
    }
    case "new_chat":
      if (command.openInNewTab) return state;
      return updateActivity(state, {
        busy: false,
        activeToolCalls: [],
        pendingApprovals: [],
        skillRunning: false,
        turnFailed: false,
        turnAborted: false,
        completionOutcome: null,
        resetSequence: state.resetSequence + 1,
      });
    case "session_load":
      if (command.openInNewTab) return state;
      return updateActivity(state, {
        busy: false,
        activeToolCalls: [],
        pendingApprovals: [],
        skillRunning: false,
        turnFailed: false,
        turnAborted: false,
        completionOutcome: null,
        resetSequence: state.resetSequence + 1,
      });
    default:
      return state;
  }
}
