import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { defaultConfigPath } from "../config.js";
import { atomicWriteSync } from "../core/atomic-write.js";
import { SessionWriterLease } from "../memory/session-writer-lock.js";
import { nextScheduledTime } from "./schedule.js";
import { type ScheduledTask, type ScheduledTaskInput, taskInputSchema } from "./types.js";

const recordSchema = taskInputSchema
  .extend({
    id: z.string().uuid(),
    workspaceDir: z.string().min(1),
    revision: z.number().int().positive(),
    createdAt: z.number().finite(),
    nextRunAt: z.number().finite().nullable(),
    manualRun: z.boolean().optional(),
    runs: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            startedAt: z.number().finite(),
            finishedAt: z.number().finite().optional(),
            status: z.enum([
              "running",
              "succeeded",
              "failed",
              "cancelled",
              "blocked",
              "interrupted",
            ]),
            session: z.string().optional(),
            summary: z.string().max(4000).optional(),
            ownerPid: z.number().int().positive(),
            cancelRequested: z.boolean().optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export class ScheduledTaskStore {
  constructor(
    readonly path = join(dirname(defaultConfigPath()), "scheduled-tasks.json"),
    private readonly now = Date.now,
  ) {}

  list(): ScheduledTask[] {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.tasks) || data.tasks.length > 100)
        throw Error("Invalid scheduled task store");
      return data.tasks.map((task: unknown) => recordSchema.parse(task));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  transaction<T>(change: (tasks: ScheduledTask[]) => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lease = SessionWriterLease.acquire({
      key: `scheduler:${resolve(this.path)}`,
      ownerId: randomUUID(),
      label: "Scheduled tasks",
    });
    try {
      const tasks = this.list();
      const result = change(tasks);
      atomicWriteSync(
        this.path,
        JSON.stringify({ version: 1, tasks }),
        `${this.path}.${randomUUID()}.tmp`,
      );
      return result;
    } finally {
      lease.release();
    }
  }

  save(
    input: ScheduledTaskInput,
    workspaceDir: string,
    id?: string,
    revision?: number,
  ): ScheduledTask {
    const task = taskInputSchema.parse(input);
    if (task.mode === "ask" && task.budgetUsd !== undefined)
      throw Error("Per-run budgets require Agent mode");
    const nextRunAt = nextScheduledTime(task.schedule, this.now());
    if (task.enabled && nextRunAt === null) throw Error("The scheduled time must be in the future");
    return this.transaction((tasks) => {
      const previous = id ? this.find(tasks, id, workspaceDir, revision) : undefined;
      if (previous?.runs.some((run) => run.status === "running"))
        throw Error("Stop the running task before editing");
      if (!previous && tasks.length >= 100) throw Error("Maximum 100 scheduled tasks");
      const record: ScheduledTask = {
        ...task,
        id: previous?.id ?? randomUUID(),
        workspaceDir: resolve(workspaceDir),
        revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? this.now(),
        nextRunAt: task.enabled ? nextRunAt : null,
        runs: previous?.runs ?? [],
      };
      if (previous) tasks[tasks.indexOf(previous)] = record;
      else tasks.push(record);
      return record;
    });
  }

  find(tasks: ScheduledTask[], id: string, workspace: string, revision?: number): ScheduledTask {
    const task = tasks.find((t) => t.id === id && t.workspaceDir === resolve(workspace));
    if (!task) throw Error("Scheduled task not found in this workspace");
    if (revision !== undefined && task.revision !== revision)
      throw Error("Task changed; refresh before editing");
    return task;
  }

  action(id: string, workspace: string, revision: number, action: string): void {
    this.transaction((tasks) => {
      const task = this.find(tasks, id, workspace, revision);
      const running = task.runs.find((run) => run.status === "running");
      if (action === "cancel") {
        if (running) running.cancelRequested = true;
      } else if (action === "pause") {
        task.enabled = false;
        task.nextRunAt = null;
        task.manualRun = undefined;
      } else if (action === "resume") {
        const next = nextScheduledTime(task.schedule, this.now());
        if (next === null) throw Error("Edit the completed one-time task before resuming");
        task.enabled = true;
        task.nextRunAt = next;
      } else if (action === "run") {
        if (running) throw Error("Task is already running");
        // A manual run is queued durably without changing the recurrence.
        task.manualRun = true;
      } else if (action === "delete") {
        if (running) throw Error("Stop the running task before deleting");
        tasks.splice(tasks.indexOf(task), 1);
      } else throw Error("Invalid scheduled task action");
      task.revision++;
    });
  }
}
