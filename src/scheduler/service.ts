import { resolve } from "node:path";
import { z } from "zod";
import type { ScheduledTaskStore } from "./store.js";
import { type ScheduledTasksEvent, taskInputSchema } from "./types.js";

const command = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("scheduled_list"), requestId: z.string().uuid() }),
  z.object({
    cmd: z.literal("scheduled_save"),
    requestId: z.string().uuid(),
    id: z.string().uuid().optional(),
    revision: z.number().int().positive().optional(),
    task: taskInputSchema,
  }),
  z.object({
    cmd: z.literal("scheduled_action"),
    requestId: z.string().uuid(),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    action: z.enum(["pause", "resume", "run", "cancel", "delete"]),
  }),
]);

export function handleScheduledCommand(
  store: ScheduledTaskStore,
  input: unknown,
  workspace: string,
): ScheduledTasksEvent {
  const msg = command.parse(input);
  let error: string | undefined;
  try {
    if (msg.cmd === "scheduled_save") {
      if (msg.id && msg.revision === undefined) throw Error("A task revision is required");
      store.save(msg.task, workspace, msg.id, msg.revision);
    }
    if (msg.cmd === "scheduled_action") store.action(msg.id, workspace, msg.revision, msg.action);
  } catch (e) {
    error = e instanceof Error ? e.message : "Scheduled task operation failed";
  }
  return {
    type: "$scheduled_tasks",
    requestId: msg.requestId,
    workspaceDir: resolve(workspace),
    tasks: store.list().filter((t) => t.workspaceDir === resolve(workspace)),
    ...(error ? { error } : {}),
  };
}
