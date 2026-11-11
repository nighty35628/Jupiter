import { z } from "zod";

export const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.string().datetime() }).strict(),
  z.object({ kind: z.literal("interval"), minutes: z.number().int().min(1).max(43_200) }).strict(),
  z
    .object({
      kind: z.literal("daily"),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      timezone: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("weekly"),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      timezone: z.string().min(1).max(100),
      day: z.number().int().min(0).max(6),
    })
    .strict(),
]);
export const taskInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(32_000),
    mode: z.enum(["ask", "agent"]),
    editMode: z.enum(["plan", "review", "auto", "yolo"]).default("review"),
    model: z.string().trim().min(1).max(200),
    schedule: scheduleSchema,
    enabled: z.boolean(),
    timeoutMinutes: z.number().int().min(1).max(180),
    budgetUsd: z.number().positive().max(100).optional(),
  })
  .strict();
export type TaskSchedule = z.infer<typeof scheduleSchema>;
export type ScheduledTaskInput = z.infer<typeof taskInputSchema>;
export interface ScheduledRun {
  id: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "succeeded" | "failed" | "cancelled" | "blocked" | "interrupted";
  session?: string;
  summary?: string;
  ownerPid: number;
  cancelRequested?: boolean;
}
export interface ScheduledTask extends ScheduledTaskInput {
  id: string;
  workspaceDir: string;
  revision: number;
  createdAt: number;
  nextRunAt: number | null;
  runs: ScheduledRun[];
  manualRun?: boolean;
}
export type ScheduledCommand =
  | { cmd: "scheduled_list"; requestId: string }
  | {
      cmd: "scheduled_save";
      requestId: string;
      id?: string;
      revision?: number;
      task: ScheduledTaskInput;
    }
  | {
      cmd: "scheduled_action";
      requestId: string;
      id: string;
      revision: number;
      action: "pause" | "resume" | "run" | "cancel" | "delete";
    };
export interface ScheduledTasksEvent {
  type: "$scheduled_tasks";
  requestId: string;
  workspaceDir: string;
  tasks: ScheduledTask[];
  error?: string;
}
export type ScheduledTaskReceipt = Pick<
  ScheduledTasksEvent,
  "requestId" | "workspaceDir" | "error"
>;
