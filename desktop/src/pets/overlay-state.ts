import type { PetTaskActivity, PetTaskStatus } from "./overlay-protocol";
import type { PetTabActivity } from "./types";

export type PetTaskSource = {
  tabId: string;
  title: string;
  active: boolean;
  busy: boolean;
  modifiedAt?: number;
  activity?: PetTabActivity;
};

const STATUS_PRIORITY: Record<PetTaskStatus, number> = {
  waiting: 0,
  blocked: 1,
  ready: 2,
  working: 3,
  thinking: 3,
  idle: 4,
};

export function compactPetTaskTitle(value: string, fallback: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return fallback;
  return compact.length > 72 ? `${compact.slice(0, 71).trimEnd()}...` : compact;
}

export function derivePetTaskStatus(source: PetTaskSource): PetTaskStatus {
  const activity = source.activity;
  if (activity?.pendingApprovals.length) return "waiting";
  if (activity?.turnFailed) return "blocked";
  if (!source.active && activity?.completionOutcome === "failure") return "blocked";
  if (!source.active && activity?.completionOutcome === "success") return "ready";
  if (activity?.activeToolCalls.length || activity?.skillRunning) return "working";
  if (source.busy || activity?.busy) return "thinking";
  return "idle";
}

export function derivePetTaskActivities(sources: readonly PetTaskSource[]): PetTaskActivity[] {
  return sources
    .map((source) => ({
      tabId: source.tabId,
      title: source.title,
      status: derivePetTaskStatus(source),
      active: source.active,
      updatedAt: source.activity?.updatedAt || source.modifiedAt || 0,
      completionSequence: source.activity?.completionSequence ?? 0,
      completionOutcome: source.activity?.completionOutcome ?? null,
    }))
    .sort((left, right) => {
      const byPriority = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
      if (byPriority !== 0) return byPriority;
      const byRecency = right.updatedAt - left.updatedAt;
      if (byRecency !== 0) return byRecency;
      if (left.active !== right.active) return left.active ? -1 : 1;
      return left.tabId.localeCompare(right.tabId);
    });
}
