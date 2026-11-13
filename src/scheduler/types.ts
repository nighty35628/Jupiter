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
export const scheduledGoalSchema = z
  .object({
    objective: z.string().trim().min(1).max(8000),
    completionCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(30),
    allowedScope: z.string().trim().min(1).max(8000),
  })
  .strict();
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
    reasoningEffort: z.enum(["low", "medium", "high", "max"]).optional(),
    goal: scheduledGoalSchema.optional(),
    computerUse: z.boolean().optional(),
    stagnationMinutes: z.number().int().min(1).max(180).optional(),
    outputMode: z.enum(["new", "continue"]).optional(),
  })
  .strict();
export type TaskSchedule = z.infer<typeof scheduleSchema>;
export type ScheduledTaskInput = z.infer<typeof taskInputSchema>;
export const checkpointSchema = z
  .object({
    at: z.number().finite(),
    step: z.string().max(2000),
    evidence: z.array(z.string().max(2000)).max(30),
    remaining: z.array(z.string().max(2000)).max(30),
  })
  .strict();
export type ScheduledCheckpoint = z.infer<typeof checkpointSchema>;
export const progressSchema = z
  .object({
    updatedAt: z.number().finite(),
    currentStep: z.string().max(2000),
    recentActions: z
      .array(z.object({ at: z.number().finite(), text: z.string().max(2000) }).strict())
      .max(50),
    checkpoints: z.array(checkpointSchema).max(30),
    pauseReason: z.string().max(2000).optional(),
  })
  .strict();
export type ScheduledProgress = z.infer<typeof progressSchema>;
export interface ScheduledRun {
  id: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "succeeded" | "failed" | "cancelled" | "blocked" | "interrupted" | "paused";
  session?: string;
  summary?: string;
  ownerPid: number;
  cancelRequested?: boolean;
  progress?: ScheduledProgress;
  goalVerified?: boolean;
  executionKey?: string;
  stopReason?: "paused" | "cancelled";
}
export interface ScheduledTask extends ScheduledTaskInput {
  id: string;
  workspaceDir: string;
  revision: number;
  createdAt: number;
  nextRunAt: number | null;
  runs: ScheduledRun[];
  manualRun?: boolean;
  goalCompletedAt?: number;
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
