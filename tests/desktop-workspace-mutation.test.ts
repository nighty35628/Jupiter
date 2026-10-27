import { getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type WorkspaceMutationLease,
  acquireComputerUse,
  acquireWorkspaceMutation,
  canonicalWorkspacePath,
  getWorkspaceMutationRevision,
  isComputerUseActive,
  isWorkspaceMutationActive,
  markWorkspaceMutation,
} from "../src/desktop/workspace-mutation.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});

const roots: string[] = [];
const leases: WorkspaceMutationLease[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "jupiter-mutation-"));
  roots.push(root);
  return root;
}

function track(lease: WorkspaceMutationLease): WorkspaceMutationLease {
  leases.push(lease);
  return lease;
}

afterEach(() => {
  for (const lease of leases.splice(0)) lease.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace mutation coordination", { retry: 0 }, () => {
  it("actually queues different owners in FIFO order without an unlocked handoff gap", async () => {
    const path = workspace();
    const first = track(await acquireWorkspaceMutation({ workspace: path, ownerId: "a" }));
    const order: string[] = [];
    const second = acquireWorkspaceMutation({ workspace: path, ownerId: "b" }).then((lease) => {
      order.push("b");
      return track(lease);
    });
    const third = acquireWorkspaceMutation({ workspace: path, ownerId: "c" }).then((lease) => {
      order.push("c");
      return track(lease);
    });
    await setImmediate();
    expect(order).toEqual([]);
    first.release();
    expect(isWorkspaceMutationActive({ workspace: path })).toBe(true);
    const fourth = acquireWorkspaceMutation({ workspace: path, ownerId: "d" }).then(track);
    const b = await second;
    expect(order).toEqual(["b"]);
    b.release();
    const c = await third;
    expect(order).toEqual(["b", "c"]);
    c.release();
    (await fourth).release();
    expect(isWorkspaceMutationActive({ workspace: path })).toBe(false);
  });

  it("removes an aborted waiter and continues to the next owner", async () => {
    const path = workspace();
    const a = track(await acquireWorkspaceMutation({ workspace: path, ownerId: "a" }));
    const controller = new AbortController();
    const waiting = acquireWorkspaceMutation({
      workspace: path,
      ownerId: "b",
      signal: controller.signal,
    });
    const rejection = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    const next = acquireWorkspaceMutation({ workspace: path, ownerId: "c" }).then(track);
    controller.abort();
    await rejection;
    a.release();
    (await next).release();
    expect(isWorkspaceMutationActive({ workspace: path })).toBe(false);
  });

  it("rejects pre-aborted waits without changing revision or ownership", async () => {
    const path = workspace();
    const controller = new AbortController();
    const reason = new Error("cancelled before enqueue");
    controller.abort(reason);
    await expect(
      acquireWorkspaceMutation({ workspace: path, ownerId: "a", signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(getWorkspaceMutationRevision(path)).toBe(0);
    expect(isWorkspaceMutationActive({ workspace: path })).toBe(false);
  });

  it("allows parent/child reentry ahead of unrelated waiters and counts every lease", async () => {
    const path = workspace();
    const parent = track(await acquireWorkspaceMutation({ workspace: path, ownerId: "family" }));
    let entered = false;
    const other = acquireWorkspaceMutation({ workspace: path, ownerId: "other" }).then((lease) => {
      entered = true;
      return track(lease);
    });
    const child = track(await acquireWorkspaceMutation({ workspace: path, ownerId: "family" }));
    expect(isWorkspaceMutationActive({ workspace: path, excludeOwnerId: "family" })).toBe(false);
    expect(isWorkspaceMutationActive({ workspace: path, excludeOwnerId: "other" })).toBe(true);
    parent.release();
    parent.release();
    await setImmediate();
    expect(entered).toBe(false);
    child.release();
    (await other).release();
  });

  it("keeps independent workspaces running concurrently", async () => {
    const left = workspace();
    const right = workspace();
    track(await acquireWorkspaceMutation({ workspace: left, ownerId: "a" }));
    const b = track(await acquireWorkspaceMutation({ workspace: right, ownerId: "b" }));
    b.release();
    expect(isWorkspaceMutationActive({ workspace: left })).toBe(true);
    expect(isWorkspaceMutationActive({ workspace: right })).toBe(false);
  });

  it("serializes real paths, symlink aliases, and not-yet-created children", async () => {
    const root = workspace();
    const real = join(root, "real");
    const alias = join(root, "alias");
    mkdirSync(real);
    symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    expect(canonicalWorkspacePath(alias)).toBe(canonicalWorkspacePath(real));
    const path = join(real, "future", "child");
    const aliasPath = join(alias, "future", "child");
    expect(canonicalWorkspacePath(aliasPath)).toBe(canonicalWorkspacePath(path));
    const a = track(await acquireWorkspaceMutation({ workspace: path, ownerId: "a" }));
    let entered = false;
    const pending = acquireWorkspaceMutation({ workspace: aliasPath, ownerId: "b" }).then(
      (lease) => {
        entered = true;
        return track(lease);
      },
    );
    await setImmediate();
    expect(entered).toBe(false);
    a.release();
    (await pending).release();
    expect(getWorkspaceMutationRevision(aliasPath)).toBe(getWorkspaceMutationRevision(path));
  });

  it("normalizes Windows casing, separators, and extended paths", () => {
    // These synthetic paths must not contact a real Windows network share.
    const originalRealpath = vi.mocked(realpathSync).getMockImplementation()!;
    vi.mocked(realpathSync).mockImplementation(() => {
      throw Object.assign(new Error("Synthetic path does not exist"), { code: "ENOENT" });
    });
    try {
      expect(canonicalWorkspacePath("C:\\Project\\Code\\..\\APP\\", "win32")).toBe(
        "c:\\project\\app",
      );
      expect(canonicalWorkspacePath("c:/PROJECT/app", "win32")).toBe("c:\\project\\app");
      expect(canonicalWorkspacePath("\\\\?\\C:\\Project\\APP", "win32")).toBe("c:\\project\\app");
      expect(canonicalWorkspacePath("\\\\?\\UNC\\Server\\Share\\APP", "win32")).toBe(
        "\\\\server\\share\\app",
      );
    } finally {
      vi.mocked(realpathSync).mockImplementation(originalRealpath);
    }
  });

  it("marks acquisition, explicit changes, and final release without resetting idle revision", async () => {
    const path = workspace();
    expect(getWorkspaceMutationRevision(path)).toBe(0);
    const a = track(await acquireWorkspaceMutation({ workspace: path, ownerId: "a" }));
    expect(getWorkspaceMutationRevision(path)).toBe(1);
    const child = track(await acquireWorkspaceMutation({ workspace: path, ownerId: "a" }));
    expect(getWorkspaceMutationRevision(path)).toBe(1);
    expect(markWorkspaceMutation(path)).toBe(2);
    a.release();
    expect(getWorkspaceMutationRevision(path)).toBe(2);
    child.release();
    expect(getWorkspaceMutationRevision(path)).toBe(3);
    child.release();
    expect(getWorkspaceMutationRevision(path)).toBe(3);
    track(await acquireWorkspaceMutation({ workspace: path, ownerId: "b" }));
    expect(getWorkspaceMutationRevision(path)).toBe(4);
  });

  it("does not release acquired mutations on abort or fake an unknown job's completion", async () => {
    const path = workspace();
    const controller = new AbortController();
    const parent = track(
      await acquireWorkspaceMutation({ workspace: path, ownerId: "a", signal: controller.signal }),
    );
    const job = track(parent.retain());
    let entered = false;
    const waiting = acquireWorkspaceMutation({ workspace: path, ownerId: "b" }).then((lease) => {
      entered = true;
      return track(lease);
    });
    controller.abort();
    parent.release();
    await setImmediate();
    expect(entered).toBe(false);
    expect(isWorkspaceMutationActive({ workspace: path })).toBe(true);
    expect(() => parent.retain()).toThrow(/released/i);
    // Only the job owner can confirm termination; there is no timeout/abort unlock.
    job.release();
    (await waiting).release();
  });

  it("ignores abort after handoff instead of abandoning an already granted lease", async () => {
    const path = workspace();
    const a = track(await acquireWorkspaceMutation({ workspace: path, ownerId: "a" }));
    const controller = new AbortController();
    const b = acquireWorkspaceMutation({
      workspace: path,
      ownerId: "b",
      signal: controller.signal,
    });
    a.release();
    controller.abort();
    const granted = track(await b);
    expect(isWorkspaceMutationActive({ workspace: path, excludeOwnerId: "a" })).toBe(true);
    granted.release();
  });

  it("rejects blank owners and workspaces", async () => {
    await expect(
      acquireWorkspaceMutation({ workspace: workspace(), ownerId: " " }),
    ).rejects.toThrow();
    await expect(acquireWorkspaceMutation({ workspace: " ", ownerId: "a" })).rejects.toThrow();
    await expect(acquireComputerUse({ ownerId: "" })).rejects.toThrow();
  });

  it("uses a global, reentrant Computer Use resource independent of workspace locks", async () => {
    const a = track(await acquireComputerUse({ ownerId: "a" }));
    const child = track(await acquireComputerUse({ ownerId: "a" }));
    const workspaceLease = track(
      await acquireWorkspaceMutation({ workspace: workspace(), ownerId: "b" }),
    );
    let entered = false;
    const b = acquireComputerUse({ ownerId: "b" }).then((lease) => {
      entered = true;
      return track(lease);
    });
    expect(isComputerUseActive({ excludeOwnerId: "a" })).toBe(false);
    a.release();
    await setImmediate();
    expect(entered).toBe(false);
    child.release();
    (await b).release();
    workspaceLease.release();
    expect(isComputerUseActive()).toBe(false);
  });

  it("serializes real overlapping asynchronous work without starvation", async () => {
    const path = workspace();
    const order: number[] = [];
    let active = 0;
    let maximum = 0;
    await Promise.all(
      Array.from({ length: 30 }, async (_, index) => {
        const lease = track(
          await acquireWorkspaceMutation({ workspace: path, ownerId: `run-${index}` }),
        );
        try {
          active += 1;
          maximum = Math.max(maximum, active);
          order.push(index);
          await setImmediate();
          active -= 1;
        } finally {
          lease.release();
        }
      }),
    );
    expect(maximum).toBe(1);
    expect(order).toEqual(Array.from({ length: 30 }, (_, index) => index));
    expect(getWorkspaceMutationRevision(path)).toBe(60);
    expect(isWorkspaceMutationActive({ workspace: path })).toBe(false);
  });

  it("detaches abort listeners on cancellation and grant", async () => {
    const path = workspace();
    const a = track(await acquireWorkspaceMutation({ workspace: path, ownerId: "a" }));
    const cancelled = new AbortController();
    const granted = new AbortController();
    const b = acquireWorkspaceMutation({ workspace: path, ownerId: "b", signal: cancelled.signal });
    const rejection = expect(b).rejects.toMatchObject({ name: "AbortError" });
    const c = acquireWorkspaceMutation({ workspace: path, ownerId: "c", signal: granted.signal });
    expect(getEventListeners(cancelled.signal, "abort")).toHaveLength(1);
    expect(getEventListeners(granted.signal, "abort")).toHaveLength(1);
    cancelled.abort();
    await rejection;
    expect(getEventListeners(cancelled.signal, "abort")).toHaveLength(0);
    a.release();
    const lease = track(await c);
    const revision = getWorkspaceMutationRevision(path);
    a.release();
    expect(getWorkspaceMutationRevision(path)).toBe(revision);
    expect(getEventListeners(granted.signal, "abort")).toHaveLength(0);
    lease.release();
  });

  it("cancels global Computer Use waiting without releasing its active owner", async () => {
    const a = track(await acquireComputerUse({ ownerId: "a" }));
    const controller = new AbortController();
    const waiting = acquireComputerUse({ ownerId: "b", signal: controller.signal });
    const rejection = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    expect(isComputerUseActive()).toBe(true);
    expect(isComputerUseActive({ excludeOwnerId: "a" })).toBe(false);
    a.release();
    expect(isComputerUseActive()).toBe(false);
  });
});
