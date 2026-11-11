import { randomUUID } from "node:crypto";
import { redactEventText } from "../core/event-redaction.js";
import { nextScheduledTime } from "./schedule.js";
import type { ScheduledTaskStore } from "./store.js";
import type { ScheduledRun, ScheduledTask } from "./types.js";

export type ScheduledExecutor = (
  task: ScheduledTask,
  signal: AbortSignal,
  onSession?: (name: string) => void,
) => Promise<Pick<ScheduledRun, "status" | "summary" | "session">>;

export class ScheduledTaskEngine {
  private timer?: ReturnType<typeof setInterval>;
  private active?: { taskId: string; runId: string; aborter: AbortController; done: Promise<void> };
  private stopped = false;
  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly execute: ScheduledExecutor,
    private readonly now = Date.now,
    private readonly onError: (error: unknown) => void = console.error,
    private readonly canRun: (task: ScheduledTask) => boolean = () => true,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.onError(error);
      }
    }, 1000);
    this.timer.unref();
  }

  /** Future schedules do not keep a background Android host alive. */
  hasPendingActivity(): boolean {
    if (this.active) return true;
    const now = this.now();
    return this.store
      .list()
      .some(
        (task) =>
          task.runs.some((run) => run.status === "running") ||
          (this.canRun(task) &&
            (task.manualRun || (task.enabled && task.nextRunAt !== null && task.nextRunAt <= now))),
      );
  }

  tick(): void {
    if (this.stopped) return;
    if (this.active) {
      const run = this.store
        .list()
        .find((t) => t.id === this.active!.taskId)
        ?.runs.find((r) => r.id === this.active!.runId);
      if (run?.cancelRequested) this.active.aborter.abort();
      return;
    }
    const now = this.now();
    const tasks = this.store.list();
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    if (
      !tasks.some(
        (t) =>
          t.runs.some((r) => r.status === "running" && !alive(r.ownerPid)) ||
          (this.canRun(t) &&
            (t.manualRun || (t.enabled && t.nextRunAt !== null && t.nextRunAt <= now))),
      )
    )
      return;
    const claimed = this.store.transaction((all) => {
      for (const task of all)
        for (const run of task.runs)
          if (run.status === "running" && !alive(run.ownerPid)) {
            run.status = "interrupted";
            run.finishedAt = now;
            run.summary =
              "Jupiter stopped before this run finished; inspect its session before retrying.";
            task.revision++;
          }
      if (all.some((t) => t.runs.some((r) => r.status === "running"))) return undefined;
      const task = all.find(
        (t) =>
          this.canRun(t) &&
          (t.manualRun || (t.enabled && t.nextRunAt !== null && t.nextRunAt <= now)),
      );
      if (!task) return undefined;
      const manual = task.manualRun;
      task.manualRun = undefined;
      if (!manual || (task.enabled && task.nextRunAt !== null && task.nextRunAt <= now)) {
        task.nextRunAt = nextScheduledTime(task.schedule, now);
        if (task.schedule.kind === "once") {
          task.enabled = false;
          task.nextRunAt = null;
        }
      }
      const run: ScheduledRun = {
        id: randomUUID(),
        startedAt: now,
        ownerPid: process.pid,
        status: "running",
      };
      task.runs = [run, ...task.runs].slice(0, 20);
      task.revision++;
      return { task: structuredClone(task), runId: run.id };
    });
    if (!claimed) return;
    const aborter = new AbortController();
    const signal = AbortSignal.any([
      aborter.signal,
      AbortSignal.timeout(claimed.task.timeoutMinutes * 60_000),
    ]);
    const done = Promise.resolve()
      .then(() =>
        this.execute(claimed.task, signal, (name) => {
          this.store.transaction((all) => {
            const task = all.find((t) => t.id === claimed.task.id);
            const run = task?.runs.find((r) => r.id === claimed.runId);
            if (run && task && run.session !== name) {
              run.session = name;
              task.revision++;
            }
          });
        }),
      )
      .catch(
        (error) =>
          ({ status: signal.aborted ? "cancelled" : "failed", summary: String(error) }) as Pick<
            ScheduledRun,
            "status" | "summary" | "session"
          >,
      )
      .then((result) => {
        this.store.transaction((all) => {
          const task = all.find((t) => t.id === claimed.task.id);
          const run = task?.runs.find((r) => r.id === claimed.runId);
          if (run && task) {
            Object.assign(run, result, {
              status: signal.aborted ? "cancelled" : result.status,
              summary: redactEventText(result.summary ?? "").slice(0, 4000),
              finishedAt: this.now(),
            });
            task.revision++;
          }
        });
      })
      .catch(this.onError)
      .finally(() => {
        this.active = undefined;
      });
    this.active = { taskId: claimed.task.id, runId: claimed.runId, aborter, done };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.active?.aborter.abort();
    await this.active?.done;
  }
}
