import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

export const COMPUTER_USE_RESOURCE_KEY = "computer-use";

export interface WorkspaceMutationLease {
  /** Release this reference once the operation is known to have stopped. */
  release(): void;
  /** Transfer ongoing work to a job by retaining a separately releasable reference. */
  retain(): WorkspaceMutationLease;
}

export interface ResourceMutationOptions {
  /** Parent/child operations must share this ID; unrelated runs must not. */
  ownerId: string;
  /** Cancels waiting only. Aborting does not prove an acquired operation stopped. */
  signal?: AbortSignal;
}

export interface WorkspaceMutationOptions extends ResourceMutationOptions {
  workspace: string;
}

interface Waiter extends ResourceMutationOptions {
  resolve(lease: WorkspaceMutationLease): void;
  reject(reason: unknown): void;
  onAbort?: () => void;
}

interface ResourceState {
  ownerId: string | null;
  references: number;
  revision: number;
  queue: Waiter[];
}

// Process-local only: these resources never acquire the session commit/writer lock.
const resources = new Map<string, ResourceState>();

/** Resolve aliases, including an existing ancestor of a not-yet-created workspace. */
export function canonicalWorkspacePath(
  workspace: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!workspace.trim()) throw new Error("Workspace must not be blank");
  const path = platform === "win32" ? win32 : posix;
  const unprefixed =
    platform === "win32"
      ? workspace.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "")
      : workspace;
  let ancestor = path.resolve(unprefixed);
  const suffix: string[] = [];
  while (true) {
    try {
      ancestor = realpathSync(ancestor);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Permission and I/O errors must not silently bypass alias coordination.
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  let canonical = path.join(ancestor, ...suffix);
  if (platform === "win32") {
    canonical = canonical.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
    canonical = win32.normalize(canonical).toLowerCase();
  }
  return canonical;
}

function workspaceKey(workspace: string): string {
  return `workspace:${canonicalWorkspacePath(workspace)}`;
}

function stateFor(key: string): ResourceState {
  let state = resources.get(key);
  if (!state) {
    state = { ownerId: null, references: 0, revision: 0, queue: [] };
    // Keep idle revision counters so an old reader cannot become valid again.
    resources.set(key, state);
  }
  return state;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Mutation wait cancelled", "AbortError");
}

function detachAbort(waiter: Waiter): void {
  if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
}

function createLease(state: ResourceState): WorkspaceMutationLease {
  state.references += 1;
  let released = false;
  return {
    retain() {
      if (released) throw new Error("Cannot retain a released mutation lease");
      return createLease(state);
    },
    release() {
      if (released) return;
      released = true;
      state.references -= 1;
      if (state.references !== 0) return;
      state.revision += 1;
      state.ownerId = null;
      // Grant synchronously: new arrivals cannot jump ahead during handoff.
      const next = state.queue.shift();
      if (next) {
        detachAbort(next);
        state.ownerId = next.ownerId;
        state.revision += 1;
        next.resolve(createLease(state));
      }
    },
  };
}

async function acquireResource(
  key: string,
  { ownerId, signal }: ResourceMutationOptions,
): Promise<WorkspaceMutationLease> {
  if (!ownerId.trim()) throw new Error("Mutation ownerId must not be blank");
  if (signal?.aborted) throw abortReason(signal);
  const state = stateFor(key);
  // Reentry deliberately bypasses unrelated waiters to avoid parent/child deadlock.
  if (state.ownerId === ownerId) return createLease(state);
  if (state.ownerId === null) {
    state.ownerId = ownerId;
    state.revision += 1;
    return createLease(state);
  }
  return new Promise<WorkspaceMutationLease>((resolve, reject) => {
    const waiter: Waiter = { ownerId, signal, resolve, reject };
    if (signal) {
      waiter.onAbort = () => {
        const index = state.queue.indexOf(waiter);
        if (index < 0) return;
        state.queue.splice(index, 1);
        detachAbort(waiter);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    state.queue.push(waiter);
  });
}

export async function acquireWorkspaceMutation(
  options: WorkspaceMutationOptions,
): Promise<WorkspaceMutationLease> {
  return acquireResource(workspaceKey(options.workspace), options);
}

/** One global desktop resource, independent of workspace mutations. */
export async function acquireComputerUse(
  options: ResourceMutationOptions,
): Promise<WorkspaceMutationLease> {
  return acquireResource(COMPUTER_USE_RESOURCE_KEY, options);
}

export function isWorkspaceMutationActive(options: {
  workspace: string;
  excludeOwnerId?: string;
}): boolean {
  const state = resources.get(workspaceKey(options.workspace));
  return state?.ownerId != null && state.ownerId !== options.excludeOwnerId;
}

export function isComputerUseActive(options: { excludeOwnerId?: string } = {}): boolean {
  const state = resources.get(COMPUTER_USE_RESOURCE_KEY);
  return state?.ownerId != null && state.ownerId !== options.excludeOwnerId;
}

export function getWorkspaceMutationRevision(workspace: string): number {
  return resources.get(workspaceKey(workspace))?.revision ?? 0;
}

/** Invalidate old read observations during a long-running mutation or background job. */
export function markWorkspaceMutation(workspace: string): number {
  return ++stateFor(workspaceKey(workspace)).revision;
}
