import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { redactEventText } from "../core/event-redaction.js";
import { writeAndroidChildBootstrap } from "../mobile/bootstrap.js";
import { getAndroidRuntimeContext } from "../mobile/runtime-context.js";
import type { ScheduledExecutor } from "./engine.js";
import { scheduledResumeRun } from "./identity.js";
import { ScheduledProgressMonitor } from "./progress.js";
import { checkpointSchema } from "./types.js";
import {
  type ScheduledEvidence,
  scheduledVerificationPrompt,
  verifyScheduledGoal,
} from "./verification.js";

interface ScheduledChildEvent {
  type: string;
  tabId?: string;
  callId?: string;
  name?: string;
  session?: string;
  output?: string;
  ok?: boolean;
  checkpoint?: unknown;
  reason?: string;
  message?: string;
  content?: string;
  requestId?: string;
  snapshot?: { requestId?: string };
  computerUseEnabled?: boolean;
  computerUseStatus?: { state?: string; reason?: string };
}

/** Reuse the real Desktop RPC execution path in an isolated, non-restoring session. */
export function createScheduledExecutor(entrypoint = process.argv[1]!): ScheduledExecutor {
  return (task, signal, onSession, onProgress) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      if (task.computerUse && getAndroidRuntimeContext()) {
        resolve({ status: "blocked", summary: "Computer Use requires a native desktop runtime" });
        return;
      }
      const previousRun = scheduledResumeRun(task);
      const executionGoal =
        task.goal ??
        (task.mode === "agent"
          ? {
              objective: task.prompt,
              completionCriteria: ["Complete the requested recurring task"],
              allowedScope: `Workspace: ${task.workspaceDir}. External resources and desktop applications only as explicitly requested by the task prompt.`,
            }
          : undefined);
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
            JUPITER_SCHEDULE_REASONING_EFFORT: task.reasoningEffort ?? "high",
            JUPITER_RUNTIME_SURFACE:
              task.computerUse && !getAndroidRuntimeContext() ? "desktop" : "scheduled",
            JUPITER_SCHEDULE_COMPUTER_USE:
              task.computerUse && !getAndroidRuntimeContext() ? "1" : "0",
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
      let verifying = false;
      let verificationText = "";
      let goalVerified = false;
      let stopping = false;
      let restoring = false;
      let restored = !previousRun?.session;
      let configured = !executionGoal && task.budgetUsd === undefined;
      let configuring = false;
      const contextRequestId = randomUUID();
      const restoreRequestId = randomUUID();
      const receipts: ScheduledEvidence[] = [];
      const toolNames = new Map<string, string>();
      let computerStatus: { enabled: boolean; state?: string; reason?: string } | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const monitor = new ScheduledProgressMonitor(Date.now, previousRun?.progress);
      let lastProgressWrite = 0;
      const send = (message: object) => {
        if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ tabId, ...message })}\n`);
      };
      const stop = () => {
        if (stopping) return;
        stopping = true;
        send({ cmd: "abort" });
        child.stdin.end();
        if (!killTimer) killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      };
      const abort = () => stop();
      const watchdog = setInterval(() => {
        if (!completed && !stopping && monitor.checkStagnation(task.stagnationMinutes ?? 15)) {
          blocked = true;
          failure = monitor.progress.pauseReason!;
          persistProgress();
          stop();
        }
      }, 1000);
      const persistProgress = () => {
        try {
          onProgress?.(structuredClone(monitor.progress));
        } catch (error) {
          failure = `Could not persist task progress: ${redactEventText(String(error))}`;
          stop();
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      child.stdin.on("error", () => {}); // Exit/error handlers below own the result.
      child.stderr.on("data", () => {}); // Never persist raw provider/host diagnostics.
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let packet: Record<string, unknown>;
        let event: ScheduledChildEvent;
        try {
          packet = JSON.parse(line);
          event = (
            typeof packet.data === "string" ? JSON.parse(packet.data) : packet
          ) as ScheduledChildEvent;
        } catch {
          return;
        }
        try {
          if (!event || typeof event.type !== "string") return;
          tabId ??= typeof packet.tabId === "string" ? packet.tabId : event.tabId;
          if (stopping || completed) return;
          if (event.type === "tool.intent" && typeof event.callId === "string")
            toolNames.set(event.callId, event.name ?? "tool");
          if (
            event.type === "tool.result" &&
            event.ok === true &&
            typeof event.output === "string" &&
            typeof event.callId === "string"
          ) {
            receipts.push({
              id: String(event.callId),
              text: redactEventText(
                `${toolNames.get(event.callId) ?? "tool"}: ${event.output}`,
              ).slice(0, 4000),
            });
            if (receipts.length > 30) receipts.shift();
            toolNames.delete(event.callId);
          }
          if (event.type === "$scheduled_guard_blocked") {
            blocked = true;
            failure = redactEventText(String(event.reason)).slice(0, 2000);
            monitor.progress.pauseReason = failure;
            persistProgress();
            stop();
            return;
          }
          if (event.type === "$scheduled_checkpoint") {
            const checkpoint = checkpointSchema.parse(event.checkpoint);
            monitor.checkpoint(checkpoint);
            persistProgress();
          }
          if (event.type === "$settings")
            computerStatus = {
              enabled: event.computerUseEnabled === true,
              state: event.computerUseStatus?.state,
              reason: event.computerUseStatus?.reason,
            };
          if (
            task.computerUse &&
            ((event.type === "$ready" &&
              (!computerStatus?.enabled ||
                !computerStatus.state ||
                [
                  "disabled",
                  "unsupported-surface",
                  "unsupported-model",
                  "driver-missing",
                  "fault",
                  "busy",
                ].includes(computerStatus.state))) ||
              (sent &&
                event.type === "$settings" &&
                (!computerStatus?.enabled ||
                  ["fault", "busy"].includes(computerStatus.state ?? ""))))
          ) {
            blocked = true;
            failure =
              computerStatus?.reason ??
              "Computer Use requires enabled desktop access, a visual model, and an installed driver";
            stop();
            return;
          }
          if (
            monitor.observe(event) &&
            (Date.now() - lastProgressWrite >= 1000 || monitor.progress.pauseReason)
          ) {
            persistProgress();
            lastProgressWrite = Date.now();
          }
          if (monitor.progress.pauseReason) {
            blocked = true;
            failure = monitor.progress.pauseReason;
            stop();
            return;
          }
          if (
            event.type === "$session_loaded" ||
            event.type === "$session_empty" ||
            event.type === "$turn_committed"
          )
            session = event.name ?? session;
          if (event.type === "$session_renamed") session = event.session ?? event.name ?? session;
          if (restoring && event.type === "$session_loaded") {
            if (
              event.name !== previousRun?.session ||
              event.snapshot?.requestId !== restoreRequestId
            ) {
              failure = "Task session restoration did not match the requested session";
              stop();
              return;
            }
            restored = true;
          }
          if (restored && session && session !== reportedSession) {
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
          if (event.type === "$scheduled_context_ready" && event.requestId === contextRequestId)
            configured = true;
          if (
            (event.type === "$ready" ||
              (event.type === "$scheduled_context_ready" && configured)) &&
            !sent &&
            !blocked &&
            !failure
          ) {
            if (!restored) {
              if (!restoring) {
                restoring = true;
                send({
                  cmd: "session_load",
                  name: previousRun!.session,
                  requestId: restoreRequestId,
                  historyPaging: true,
                });
              }
              return;
            }
            if (!configured) {
              if (!configuring) {
                configuring = true;
                send({
                  cmd: "scheduled_context",
                  requestId: contextRequestId,
                  goal: executionGoal,
                  budgetUsd: task.budgetUsd,
                });
              }
              return;
            }
            sent = true;
            send({
              cmd: task.mode === "ask" ? "ask_light" : "user_input",
              text: task.goal
                ? `${task.prompt}\n\nObjective: ${task.goal.objective}\nCompletion criteria:\n${task.goal.completionCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n")}\nAllowed scope: ${task.goal.allowedScope}\nDo not exceed this scope. Work in stages. Call scheduled_checkpoint after each meaningful stage with observed evidence and remaining steps. Re-observe external state on resume; never replay old desktop actions blindly.\nPrevious checkpoint:\n${JSON.stringify(monitor.progress.checkpoints.at(-1) ?? null)}`
                : `${task.prompt}${task.mode === "agent" ? "\nCall scheduled_checkpoint after each meaningful stage with observed evidence and remaining steps. Stay within the original task scope." : ""}${previousRun ? `\nResume context: ${JSON.stringify(previousRun.progress?.checkpoints.at(-1) ?? previousRun.summary)}. Recheck current state before acting.` : ""}`,
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
          if (event.type === "$error" || event.type === "error") {
            failure = redactEventText(event.message ?? "Task failed").slice(0, 2000);
            stop();
            return;
          }
          if (event.type === "model.final") {
            if (verifying) verificationText = event.content ?? "";
            else {
              summary = redactEventText(event.content ?? "").slice(0, 4000);
              if (typeof event.content === "string") {
                receipts.push({
                  id: `answer-${receipts.length}`,
                  text: redactEventText(event.content).slice(0, 8000),
                });
                if (receipts.length > 30) receipts.shift();
              }
            }
          }
          if (event.type === "$turn_complete" && sent) {
            if (task.goal && !verifying && !failure && !blocked) {
              verifying = true;
              monitor.progress.currentStep = "Verifying completion criteria";
              persistProgress();
              send({
                cmd: "ask_light",
                clientId: randomUUID(),
                text: scheduledVerificationPrompt(task, receipts),
              });
              return;
            }
            if (task.goal && verifying) {
              try {
                const audit = verifyScheduledGoal(verificationText, task, receipts);
                goalVerified = audit.verified;
                monitor.progress.checkpoints = [
                  ...monitor.progress.checkpoints,
                  {
                    at: Date.now(),
                    step: goalVerified ? "Goal completion verified" : "Goal remains incomplete",
                    evidence: audit.evidence,
                    remaining: audit.remaining,
                  },
                ].slice(-30);
                if (audit.scopeRespected !== true) {
                  blocked = true;
                  failure = "Goal scope verification failed; inspect the run before resuming";
                }
              } catch {
                blocked = true;
                failure =
                  "Goal verification returned invalid evidence; inspect the run before resuming";
              }
              persistProgress();
            }
            if (!task.goal && !failure && !blocked) {
              monitor.checkpoint({
                at: Date.now(),
                step: "Run finished",
                evidence: [summary.slice(0, 2000)],
                remaining: [],
              });
              persistProgress();
            }
            completed = true;
            child.stdin.end();
            if (!killTimer) killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
          }
        } catch (error) {
          failure = `Automation protocol failed: ${redactEventText(String(error)).slice(0, 1600)}`;
          blocked = true;
          stop();
        }
      });
      child.on("error", (error) => {
        clearInterval(watchdog);
        clearTimeout(killTimer);
        signal.removeEventListener("abort", abort);
        reject(error);
      });
      child.on("close", () => {
        clearInterval(watchdog);
        clearTimeout(killTimer);
        lines.close();
        signal.removeEventListener("abort", abort);
        try {
          onProgress?.(structuredClone(monitor.progress));
        } catch (error) {
          failure = `Could not persist task progress: ${redactEventText(String(error))}`;
        }
        resolve({
          status: signal.aborted
            ? "cancelled"
            : blocked
              ? "blocked"
              : failure || !completed || !summary
                ? "failed"
                : "succeeded",
          session,
          ...(task.goal ? { goalVerified } : {}),
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
