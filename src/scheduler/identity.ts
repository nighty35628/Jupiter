import { createHash } from "node:crypto";
import type { ScheduledTask, ScheduledTaskInput } from "./types.js";

export function scheduledExecutionKey(task: ScheduledTaskInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        prompt: task.prompt,
        mode: task.mode,
        editMode: task.editMode,
        model: task.model,
        reasoningEffort: task.reasoningEffort,
        budgetUsd: task.budgetUsd,
        goal: task.goal,
        computerUse: task.computerUse ?? false,
        stagnationMinutes: task.stagnationMinutes,
        outputMode: task.outputMode ?? "new",
        timeoutMinutes: task.timeoutMinutes,
      }),
    )
    .digest("hex");
}

export function scheduledResumeRun(task: ScheduledTask) {
  const key = scheduledExecutionKey(task);
  return task.runs.find(
    (run) =>
      run.executionKey === key &&
      run.session &&
      (task.goal ||
        task.outputMode === "continue" ||
        ["paused", "blocked", "interrupted"].includes(run.status)),
  );
}
