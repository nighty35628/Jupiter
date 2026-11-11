import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { redactEventText } from "../core/event-redaction.js";
import { writeAndroidChildBootstrap } from "../mobile/bootstrap.js";
import { getAndroidRuntimeContext } from "../mobile/runtime-context.js";
import type { ScheduledExecutor } from "./engine.js";

/** Reuse the real Desktop RPC execution path in an isolated, non-restoring session. */
export function createScheduledExecutor(entrypoint = process.argv[1]!): ScheduledExecutor {
  return (task, signal, onSession) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const child = spawn(
        process.execPath,
        [
          ...(getAndroidRuntimeContext() ? ["--max-old-space-size=768"] : []),
          entrypoint,
          "desktop",
          "--dir",
          task.workspaceDir,
          "--model",
          task.model,
          ...(task.budgetUsd ? ["--budget", String(task.budgetUsd)] : []),
        ],
        {
          cwd: task.workspaceDir,
          env: {
            ...process.env,
            JUPITER_SCHEDULE_CHILD: "1",
            JUPITER_SCHEDULE_PARENT_PID: String(process.pid),
            JUPITER_SCHEDULE_EDIT_MODE: task.editMode,
            JUPITER_RUNTIME_SURFACE: "scheduled",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let sent = false;
      let completed = false;
      let session: string | undefined;
      let reportedSession: string | undefined;
      let summary = "";
      let failure = "";
      let blocked = false;
      let tabId: string | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const send = (message: object) => {
        if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ tabId, ...message })}\n`);
      };
      const stop = () => {
        send({ cmd: "abort" });
        child.stdin.end();
        if (!killTimer) killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      };
      const abort = () => stop();
      signal.addEventListener("abort", abort, { once: true });
      child.stdin.on("error", () => {}); // Exit/error handlers below own the result.
      child.stderr.on("data", () => {}); // Never persist raw provider/host diagnostics.
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const packet = JSON.parse(line);
          const event = typeof packet.data === "string" ? JSON.parse(packet.data) : packet;
          tabId ??= packet.tabId ?? event.tabId;
          if (
            event.type === "$session_loaded" ||
            event.type === "$session_empty" ||
            event.type === "$turn_committed"
          )
            session = event.name ?? session;
          if (event.type === "$session_renamed") session = event.session ?? event.name ?? session;
          if (session && session !== reportedSession) {
            try {
              onSession?.(session);
              reportedSession = session;
            } catch (error) {
              failure = `Could not persist task session: ${redactEventText(String(error))}`;
              stop();
              return;
            }
          }
          if (event.type === "$needs_setup") {
            failure = "Provider is not configured";
            stop();
          }
          if (event.type === "$ready" && !sent) {
            sent = true;
            send({
              cmd: task.mode === "ask" ? "ask_light" : "user_input",
              text: task.prompt,
              clientId: randomUUID(),
            });
          }
          if (
            [
              "$confirm_required",
              "$path_access_required",
              "$choice_required",
              "$plan_required",
              "$checkpoint_required",
              "$revision_required",
            ].includes(event.type)
          ) {
            blocked = true;
            failure =
              "This task requires confirmation. Open the result session to continue interactively.";
            stop();
          }
          if (event.type === "$error" || event.type === "error")
            failure = redactEventText(event.message ?? "Task failed").slice(0, 2000);
          if (event.type === "model.final")
            summary = redactEventText(event.content ?? "").slice(0, 4000);
          if (event.type === "$turn_complete" && sent) {
            completed = true;
            child.stdin.end();
            if (!killTimer) killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
          }
        } catch {
          /* Non-protocol stdout cannot change the run state. */
        }
      });
      child.on("error", (error) => {
        clearTimeout(killTimer);
        signal.removeEventListener("abort", abort);
        reject(error);
      });
      child.on("close", () => {
        clearTimeout(killTimer);
        lines.close();
        signal.removeEventListener("abort", abort);
        resolve({
          status: signal.aborted
            ? "cancelled"
            : blocked
              ? "blocked"
              : failure || !completed || !summary
                ? "failed"
                : "succeeded",
          session,
          summary: failure || summary || "The task ended without a completed response",
        });
      });
      if (getAndroidRuntimeContext()) {
        void writeAndroidChildBootstrap(child.stdin, "scheduled").catch(() => {
          failure = "Could not initialize the Android task runtime";
          stop();
        });
      }
      if (signal.aborted) stop();
    });
}
