import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduledTaskEngine } from "../src/scheduler/engine.js";
import { nextScheduledTime } from "../src/scheduler/schedule.js";
import { handleScheduledCommand } from "../src/scheduler/service.js";
import { ScheduledTaskStore } from "../src/scheduler/store.js";
import type { ScheduledTaskInput } from "../src/scheduler/types.js";

let root: string;
let store: ScheduledTaskStore;
let now: number;
const input = (): ScheduledTaskInput => ({
  title: "QA",
  prompt: "Synthetic task",
  mode: "ask",
  editMode: "review",
  model: "synthetic",
  enabled: true,
  timeoutMinutes: 1,
  schedule: { kind: "interval", minutes: 1 },
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jupiter-scheduler-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  now = Date.parse("2026-10-30T00:00:00Z");
  store = new ScheduledTaskStore(join(root, "tasks.json"), () => now);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("persistent scheduler", { retry: 0 }, () => {
  it("idle readiness ignores future schedules but protects eligible manual/due work", async () => {
    const task = store.save(input(), root);
    const engine = new ScheduledTaskEngine(store, vi.fn(), () => now);
    expect(engine.hasPendingActivity()).toBe(false);
    now += 60_000;
    expect(engine.hasPendingActivity()).toBe(true);
    const restricted = new ScheduledTaskEngine(
      store,
      vi.fn(),
      () => now,
      vi.fn(),
      () => false,
    );
    expect(restricted.hasPendingActivity()).toBe(false);
    now -= 60_000;
    store.action(task.id, root, task.revision, "run");
    expect(engine.hasPendingActivity()).toBe(true);
    expect(restricted.hasPendingActivity()).toBe(false);
    await engine.stop();
    await restricted.stop();
  });

  it("protects a claimed run through executor settlement without cancelling it", async () => {
    store.save(input(), root);
    now += 60_000;
    let finish!: () => void;
    let signal!: AbortSignal;
    const engine = new ScheduledTaskEngine(
      store,
      (_task, inputSignal) => {
        signal = inputSignal;
        return new Promise((resolve) => {
          finish = () => resolve({ status: "succeeded", summary: "done" });
        });
      },
      () => now,
    );
    engine.tick();
    expect(engine.hasPendingActivity()).toBe(true);
    await settle();
    expect(engine.hasPendingActivity()).toBe(true);
    expect(signal.aborted).toBe(false);
    finish();
    await settle();
    expect(engine.hasPendingActivity()).toBe(false);
    expect(signal.aborted).toBe(false);
    await engine.stop();
  });
  it("coalesces a manual request with the same overdue occurrence and records the live session", async () => {
    let task = store.save(input(), root);
    now += 60_000;
    store.action(task.id, root, task.revision, "run");
    const execute = vi.fn(async (_task, _signal, onSession?: (name: string) => void) => {
      onSession?.("live-session");
      expect(store.list()[0]!.runs[0]!.session).toBe("live-session");
      return { status: "succeeded" as const, session: "live-session", summary: "done" };
    });
    const engine = new ScheduledTaskEngine(store, execute, () => now);
    engine.tick();
    await settle();
    engine.tick();
    await settle();
    task = store.list()[0]!;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(task.nextRunAt).toBe(now + 60_000);
    await engine.stop();
  });
  it("calculates daily/weekly schedules in their IANA timezone", () => {
    expect(
      new Date(
        nextScheduledTime({ kind: "daily", time: "09:00", timezone: "Asia/Hong_Kong" }, now)!,
      ).toISOString(),
    ).toBe("2026-10-30T01:00:00.000Z");
    expect(
      new Date(
        nextScheduledTime(
          { kind: "weekly", time: "09:00", timezone: "Asia/Hong_Kong", day: 1 },
          now,
        )!,
      ).toISOString(),
    ).toBe("2026-11-02T01:00:00.000Z");
    expect(() =>
      nextScheduledTime({ kind: "daily", time: "09:00", timezone: "Invalid" }, now),
    ).toThrow();
    // The wall-clock hour is preserved across the autumn DST transition.
    expect(
      new Date(
        nextScheduledTime(
          { kind: "daily", time: "09:00", timezone: "America/New_York" },
          Date.parse("2026-11-01T01:00:00Z"),
        )!,
      ).toISOString(),
    ).toBe("2026-11-01T14:00:00.000Z");
  });

  it("persists definitions and rejects invalid, stale, and cross-workspace edits", () => {
    const task = store.save(input(), root);
    expect(new ScheduledTaskStore(store.path).list()[0]).toEqual(task);
    expect(() =>
      store.save({ ...input(), schedule: { kind: "interval", minutes: 0 } }, root),
    ).toThrow();
    expect(() => store.save(input(), root, task.id, 9)).toThrow(/changed/);
    expect(() => store.save(input(), join(root, "other"), task.id, task.revision)).toThrow(
      /not found/,
    );
    expect(() =>
      store.save(
        { ...input(), schedule: { kind: "once", at: new Date(now - 1).toISOString() } },
        root,
      ),
    ).toThrow(/future/);
    expect(readFileSync(store.path, "utf8")).not.toContain("apiKey");
  });

  it("coalesces missed repeats and prevents two runtime owners from executing twice", async () => {
    const task = store.save(input(), root);
    now += 24 * 3600_000;
    let finish!: () => void;
    const execute = vi.fn(
      () =>
        new Promise<{ status: "succeeded"; summary: string }>((resolve) => {
          finish = () => resolve({ status: "succeeded", summary: "OK" });
        }),
    );
    const a = new ScheduledTaskEngine(store, execute, () => now);
    const b = new ScheduledTaskEngine(new ScheduledTaskStore(store.path), execute, () => now);
    a.tick();
    b.tick();
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.list()[0]!.nextRunAt).toBe(now + 60_000);
    expect(() => store.action(task.id, root, store.list()[0]!.revision, "delete")).toThrow(/Stop/);
    finish();
    await settle();
    await a.stop();
    await b.stop();
    expect(store.list()[0]!.runs[0]!.status).toBe("succeeded");
  });

  it("runs overdue one-time tasks once, pauses and resumes, and runs paused tasks manually", async () => {
    let task = store.save(
      { ...input(), schedule: { kind: "once", at: new Date(now + 1000).toISOString() } },
      root,
    );
    const execute = vi.fn(async () => ({
      status: "succeeded" as const,
      summary: "done",
      session: "qa",
    }));
    const engine = new ScheduledTaskEngine(store, execute, () => now);
    now += 5000;
    engine.tick();
    await settle();
    engine.tick();
    await settle();
    task = store.list()[0]!;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(task.enabled).toBe(false);
    expect(() => store.action(task.id, root, task.revision, "resume")).toThrow(/Edit/);
    store.action(task.id, root, task.revision, "run");
    engine.tick();
    await settle();
    expect(execute).toHaveBeenCalledTimes(2);
    await engine.stop();
  });

  it("pauses pending manual requests and does not advance recurrence for a manual run", async () => {
    let task = store.save(input(), root);
    const due = task.nextRunAt;
    store.action(task.id, root, task.revision, "run");
    task = store.list()[0]!;
    store.action(task.id, root, task.revision, "pause");
    const execute = vi.fn(async () => ({ status: "succeeded" as const, summary: "done" }));
    const engine = new ScheduledTaskEngine(store, execute, () => now);
    engine.tick();
    await settle();
    expect(execute).not.toHaveBeenCalled();
    task = store.list()[0]!;
    store.action(task.id, root, task.revision, "resume");
    task = store.list()[0]!;
    expect(task.nextRunAt).toBe(due);
    store.action(task.id, root, task.revision, "run");
    engine.tick();
    await settle();
    expect(store.list()[0]!.nextRunAt).toBe(due);
    await engine.stop();
  });

  it("cancels through persisted requests and shuts down without re-running", async () => {
    let task = store.save(input(), root);
    const execute = vi.fn(
      (_t, signal: AbortSignal) =>
        new Promise<{ status: "cancelled" }>((resolve) =>
          signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true }),
        ),
    );
    const engine = new ScheduledTaskEngine(store, execute, () => now);
    now += 60_000;
    engine.tick();
    await settle();
    task = store.list()[0]!;
    store.action(task.id, root, task.revision, "cancel");
    engine.tick();
    await settle();
    expect(store.list()[0]!.runs[0]!.status).toBe("cancelled");
    await engine.stop();
    now += 60_000;
    engine.tick();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("marks crashed runs interrupted without replaying the old occurrence", async () => {
    const task = store.save(input(), root);
    store.transaction((all) => {
      all[0]!.runs = [
        { id: randomUUID(), startedAt: now, ownerPid: 2_000_000_000, status: "running" },
      ];
    });
    const execute = vi.fn(async () => ({ status: "failed" as const }));
    const engine = new ScheduledTaskEngine(store, execute, () => now);
    engine.tick();
    await settle();
    expect(store.list()[0]!.runs[0]!.status).toBe("interrupted");
    expect(execute).not.toHaveBeenCalled();
    await engine.stop();
    expect(store.list()[0]!.id).toBe(task.id);
  });

  it("records execution errors and respects a runtime workspace restriction", async () => {
    store.save(input(), root);
    now += 60_000;
    const execute = vi.fn(async () => {
      throw Error("synthetic offline");
    });
    const restricted = new ScheduledTaskEngine(
      store,
      execute,
      () => now,
      vi.fn(),
      () => false,
    );
    restricted.tick();
    await settle();
    expect(execute).not.toHaveBeenCalled();
    await restricted.stop();
    const engine = new ScheduledTaskEngine(store, execute, () => now);
    engine.tick();
    await settle();
    await engine.stop();
    expect(store.list()[0]!.runs[0]).toMatchObject({
      status: "failed",
      summary: "Error: synthetic offline",
    });
  });

  it("returns correlated errors without overwriting definitions or accepting caller-supplied paths", () => {
    const task = store.save(input(), root);
    const reply = handleScheduledCommand(
      store,
      {
        cmd: "scheduled_action",
        requestId: randomUUID(),
        id: task.id,
        revision: 50,
        action: "delete",
      },
      root,
    );
    expect(reply.error).toMatch(/changed/);
    expect(reply.tasks).toHaveLength(1);
    const other = handleScheduledCommand(
      store,
      { cmd: "scheduled_list", requestId: randomUUID() },
      join(root, "other"),
    );
    expect(other.tasks).toHaveLength(0);
    writeFileSync(store.path, "broken json");
    expect(() => store.save(input(), root)).toThrow();
    expect(readFileSync(store.path, "utf8")).toBe("broken json");
  });
});
