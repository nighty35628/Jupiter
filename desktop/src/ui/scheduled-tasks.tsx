import { Clock, Pause, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  ScheduledCommand,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskReceipt,
  ScheduledTasksEvent,
  TaskSchedule,
} from "../../../src/scheduler/types";
import { t, useLang } from "../i18n";
import { I } from "../icons";

export interface ScheduledTasksProps {
  workspaceDir: string;
  model: string;
  active: boolean;
  result?: ScheduledTasksEvent;
  results?: Record<string, ScheduledTaskReceipt>;
  send: (command: ScheduledCommand) => Promise<void>;
  onOpenSession: (name: string) => void;
  writable: boolean;
}

function initial(model: string): ScheduledTaskInput {
  return {
    title: "",
    prompt: "",
    model,
    mode: "ask",
    editMode: "review",
    enabled: true,
    timeoutMinutes: 30,
    schedule: {
      kind: "daily",
      time: "09:00",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };
}
const stamp = (value?: number | null) => (value ? new Date(value).toLocaleString() : "-");
const localDateTime = (iso: string) => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function PageScheduledTasks({
  workspaceDir,
  model,
  active,
  result,
  results,
  send,
  onOpenSession,
  writable,
}: ScheduledTasksProps) {
  useLang();
  const [editing, setEditing] = useState<{
    id?: string;
    revision?: number;
    task: ScheduledTaskInput;
  } | null>(null);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const sending = useRef(false);
  const previousWorkspace = useRef(workspaceDir);
  useEffect(() => {
    if (previousWorkspace.current === workspaceDir) return;
    previousWorkspace.current = workspaceDir;
    setEditing(null);
    setPending(undefined);
    setError(undefined);
    sending.current = false;
  }, [workspaceDir]);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => {
      sending.current = false;
      setPending(undefined);
      setError(t("scheduler.unconfirmed"));
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [pending]);
  useEffect(() => {
    if (!active || !workspaceDir) return;
    const poll = () => {
      void send({ cmd: "scheduled_list", requestId: crypto.randomUUID() }).catch((e) =>
        setError(String(e)),
      );
    };
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => window.clearInterval(timer);
  }, [active, send, workspaceDir]);
  useEffect(() => {
    if (!pending) return;
    const reply = results?.[pending] ?? (result?.requestId === pending ? result : undefined);
    if (!reply || reply.workspaceDir !== workspaceDir) return;
    sending.current = false;
    setPending(undefined);
    setError(reply.error);
    if (!reply.error) {
      setEditing(null);
      setDeleting(undefined);
    }
  }, [pending, result, results, workspaceDir]);
  const mutate = (command: ScheduledCommand) => {
    if (sending.current || !writable) return;
    sending.current = true;
    setPending(command.requestId);
    setError(undefined);
    void send(command).catch((e) => {
      sending.current = false;
      setPending(undefined);
      setError(String(e));
    });
  };
  const tasks = result?.workspaceDir === workspaceDir ? result.tasks : undefined;
  const update = (patch: Partial<ScheduledTaskInput>) =>
    setEditing((old) => (old ? { ...old, task: { ...old.task, ...patch } } : old));
  const schedule = (kind: TaskSchedule["kind"]) => {
    if (kind === "once")
      return { kind, at: new Date(Date.now() + 3600_000).toISOString() } as const;
    if (kind === "interval") return { kind, minutes: 60 } as const;
    return {
      kind,
      time: "09:00",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(kind === "weekly" ? { day: 1 } : {}),
    } as TaskSchedule;
  };
  const action = (
    task: ScheduledTask,
    action: Extract<ScheduledCommand, { cmd: "scheduled_action" }>["action"],
  ) =>
    mutate({
      cmd: "scheduled_action",
      requestId: crypto.randomUUID(),
      id: task.id,
      revision: task.revision,
      action,
    });
  const draft = editing?.task;
  return (
    <div className="scheduled-page">
      <div className="scheduled-toolbar">
        <span className="scheduled-scope" title={workspaceDir}>
          {workspaceDir}
        </span>
        <button
          type="button"
          className="btn"
          disabled={!writable || !!pending}
          onClick={() => setEditing({ task: initial(model) })}
        >
          <I.plus size={14} />
          {t("scheduler.create")}
        </button>
      </div>
      <p className="scheduled-runtime">{t("scheduler.runtime")}</p>
      {!writable && <output>{t("scheduler.readOnly")}</output>}
      {(error || result?.error) && <p role="alert">{error || result?.error}</p>}
      {draft && (
        <form
          className="scheduled-editor"
          aria-label={t("scheduler.edit")}
          onSubmit={(event) => {
            event.preventDefault();
            if (editing)
              mutate({
                cmd: "scheduled_save",
                requestId: crypto.randomUUID(),
                id: editing.id,
                revision: editing.revision,
                task: draft,
              });
          }}
        >
          <fieldset disabled={!!pending || !writable}>
            <label>
              {t("scheduler.title")}
              <input
                className="field"
                required
                maxLength={120}
                value={draft.title}
                onChange={(e) => update({ title: e.target.value })}
              />
            </label>
            <label>
              {t("scheduler.prompt")}
              <textarea
                className="field"
                required
                maxLength={32_000}
                rows={4}
                value={draft.prompt}
                onChange={(e) => update({ prompt: e.target.value })}
              />
            </label>
            <div className="scheduled-grid">
              <label>
                {t("scheduler.frequency")}
                <select
                  className="field"
                  aria-label={t("scheduler.frequency")}
                  value={draft.schedule.kind}
                  onChange={(e) =>
                    update({ schedule: schedule(e.target.value as TaskSchedule["kind"]) })
                  }
                >
                  {["once", "interval", "daily", "weekly"].map((k) => (
                    <option key={k} value={k}>
                      {t(`scheduler.${k}` as "scheduler.once")}
                    </option>
                  ))}
                </select>
              </label>
              {draft.schedule.kind === "once" && (
                <label>
                  {t("scheduler.time")}
                  <input
                    className="field"
                    required
                    type="datetime-local"
                    value={localDateTime(draft.schedule.at)}
                    onChange={(e) => {
                      const date = new Date(e.target.value);
                      if (Number.isFinite(date.getTime()))
                        update({ schedule: { kind: "once", at: date.toISOString() } });
                    }}
                  />
                </label>
              )}
              {draft.schedule.kind === "interval" && (
                <label>
                  {t("scheduler.minutes")}
                  <input
                    className="field"
                    required
                    type="number"
                    min={1}
                    max={43200}
                    value={draft.schedule.minutes}
                    onChange={(e) =>
                      update({ schedule: { kind: "interval", minutes: Number(e.target.value) } })
                    }
                  />
                </label>
              )}
              {(draft.schedule.kind === "daily" || draft.schedule.kind === "weekly") && (
                <>
                  <label>
                    {t("scheduler.time")}
                    <input
                      className="field"
                      required
                      type="time"
                      value={draft.schedule.time}
                      onChange={(e) =>
                        update({
                          schedule: {
                            ...(draft.schedule as Extract<
                              TaskSchedule,
                              { kind: "daily" | "weekly" }
                            >),
                            time: e.target.value,
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    {t("scheduler.timezone")}
                    <input
                      className="field"
                      required
                      value={draft.schedule.timezone}
                      onChange={(e) =>
                        update({
                          schedule: {
                            ...(draft.schedule as Extract<
                              TaskSchedule,
                              { kind: "daily" | "weekly" }
                            >),
                            timezone: e.target.value,
                          },
                        })
                      }
                    />
                  </label>
                  {draft.schedule.kind === "weekly" && (
                    <label>
                      {t("scheduler.weekday")}
                      <select
                        className="field"
                        aria-label={t("scheduler.weekday")}
                        value={draft.schedule.day}
                        onChange={(e) =>
                          update({
                            schedule: {
                              ...(draft.schedule as Extract<TaskSchedule, { kind: "weekly" }>),
                              day: Number(e.target.value),
                            },
                          })
                        }
                      >
                        {[0, 1, 2, 3, 4, 5, 6].map((day) => (
                          <option key={day} value={day}>
                            {new Intl.DateTimeFormat(undefined, {
                              weekday: "long",
                              timeZone: "UTC",
                            }).format(new Date(Date.UTC(2026, 0, 4 + day)))}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
              <label>
                {t("scheduler.mode")}
                <select
                  className="field"
                  aria-label={t("scheduler.mode")}
                  value={draft.mode}
                  onChange={(e) =>
                    update({
                      mode: e.target.value as "ask" | "agent",
                      ...(e.target.value === "ask"
                        ? { budgetUsd: undefined, computerUse: false }
                        : {}),
                    })
                  }
                >
                  <option value="ask">Ask</option>
                  <option value="agent">Agent</option>
                </select>
              </label>
              <label>
                {t("scheduler.model")}
                <input
                  className="field"
                  required
                  maxLength={200}
                  value={draft.model}
                  onChange={(e) => update({ model: e.target.value })}
                />
              </label>
              <label>
                {t("scheduler.effort")}
                <select
                  className="field"
                  value={draft.reasoningEffort ?? "high"}
                  onChange={(e) =>
                    update({
                      reasoningEffort: e.target.value as ScheduledTaskInput["reasoningEffort"],
                    })
                  }
                >
                  {["low", "medium", "high", "max"].map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("scheduler.outputMode")}
                <select
                  className="field"
                  value={draft.outputMode ?? "new"}
                  onChange={(e) => update({ outputMode: e.target.value as "new" | "continue" })}
                >
                  <option value="new">{t("scheduler.newOutput")}</option>
                  <option value="continue">{t("scheduler.continueOutput")}</option>
                </select>
              </label>
              <label>
                {t("scheduler.stagnation")}
                <input
                  className="field"
                  type="number"
                  min={1}
                  max={180}
                  value={draft.stagnationMinutes ?? 15}
                  onChange={(e) => update({ stagnationMinutes: Number(e.target.value) })}
                />
              </label>
              {draft.mode === "agent" && (
                <label>
                  {t("scheduler.permission")}
                  <select
                    className="field"
                    aria-label={t("scheduler.permission")}
                    value={draft.editMode}
                    onChange={(e) =>
                      update({ editMode: e.target.value as ScheduledTaskInput["editMode"] })
                    }
                  >
                    {["plan", "review", "auto", "yolo"].map((k) => (
                      <option key={k} value={k}>
                        {t(`scheduler.${k}` as "scheduler.plan")}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                {t("scheduler.timeout")}
                <input
                  className="field"
                  type="number"
                  min={1}
                  max={180}
                  required
                  value={draft.timeoutMinutes}
                  onChange={(e) => update({ timeoutMinutes: Number(e.target.value) })}
                />
              </label>
              {draft.mode === "agent" && (
                <label>
                  {t("scheduler.budget")}
                  <input
                    className="field"
                    type="number"
                    min={0.001}
                    max={100}
                    step="any"
                    value={draft.budgetUsd ?? ""}
                    onChange={(e) =>
                      update({ budgetUsd: e.target.value ? Number(e.target.value) : undefined })
                    }
                  />
                </label>
              )}
            </div>
            {draft.mode === "agent" && (
              <label className="scheduled-enabled">
                <input
                  type="checkbox"
                  checked={draft.computerUse ?? false}
                  onChange={(e) => update({ computerUse: e.target.checked })}
                />
                {t("scheduler.computerUse")}
              </label>
            )}
            <label className="scheduled-enabled">
              <input
                type="checkbox"
                checked={!!draft.goal}
                onChange={(e) =>
                  update({
                    goal: e.target.checked
                      ? { objective: "", completionCriteria: [""], allowedScope: "" }
                      : undefined,
                  })
                }
              />
              {t("scheduler.goal")}
            </label>
            {draft.goal && (
              <>
                <label>
                  {t("scheduler.objective")}
                  <textarea
                    className="field"
                    required
                    value={draft.goal.objective}
                    onChange={(e) =>
                      update({ goal: { ...draft.goal!, objective: e.target.value } })
                    }
                  />
                </label>
                <label>
                  {t("scheduler.criteria")}
                  <textarea
                    className="field"
                    required
                    value={draft.goal.completionCriteria.join("\n")}
                    onChange={(e) =>
                      update({
                        goal: { ...draft.goal!, completionCriteria: e.target.value.split("\n") },
                      })
                    }
                  />
                </label>
                <label>
                  {t("scheduler.scope")}
                  <textarea
                    className="field"
                    required
                    value={draft.goal.allowedScope}
                    onChange={(e) =>
                      update({ goal: { ...draft.goal!, allowedScope: e.target.value } })
                    }
                  />
                </label>
              </>
            )}
            <label className="scheduled-enabled">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => update({ enabled: e.target.checked })}
              />
              {t("scheduler.enabled")}
            </label>
            {draft.mode === "agent" && (
              <p className="scheduled-runtime">
                {t(
                  draft.editMode === "yolo" ? "scheduler.fullControlWarning" : "scheduler.approval",
                )}
              </p>
            )}
            <div className="scheduled-actions">
              <button className="btn primary" type="submit">
                <Save size={14} />
                {t("scheduler.save")}
              </button>
              <button className="btn" type="button" onClick={() => setEditing(null)}>
                {t("scheduler.cancel")}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {!tasks ? (
        <output>{t("scheduler.loading")}</output>
      ) : tasks.length === 0 ? (
        <p>{t("scheduler.empty")}</p>
      ) : (
        tasks.map((task) => {
          const running = task.runs.find((run) => run.status === "running");
          return (
            <article className="scheduled-row" key={task.id}>
              <div className="scheduled-row-head">
                <div>
                  <h3>{task.title}</h3>
                  <div className="scheduled-meta">
                    <Clock size={13} />
                    {t(`scheduler.${task.schedule.kind}` as "scheduler.once")}
                    {(task.schedule.kind === "daily" || task.schedule.kind === "weekly") &&
                      ` ${task.schedule.time} (${task.schedule.timezone})`}
                    {task.schedule.kind === "interval" && ` ${task.schedule.minutes} min`} ·{" "}
                    {task.mode === "ask" ? "Ask" : "Agent"} · {task.model}
                  </div>
                  <div className="scheduled-meta">
                    {t("scheduler.next")}: {stamp(task.nextRunAt)} ·{" "}
                    {t(
                      task.goalCompletedAt
                        ? "scheduler.goalCompleted"
                        : task.enabled
                          ? "scheduler.enabled"
                          : "scheduler.paused",
                    )}
                  </div>
                </div>
                <div className="scheduled-actions">
                  <button
                    className="icon-btn"
                    type="button"
                    title={t("scheduler.run")}
                    aria-label={`${t("scheduler.run")}: ${task.title}`}
                    disabled={
                      !writable ||
                      !!pending ||
                      !!running ||
                      !!task.manualRun ||
                      !!task.goalCompletedAt
                    }
                    onClick={() => action(task, "run")}
                  >
                    <I.play size={14} />
                  </button>
                  {running ? (
                    <>
                      <button
                        className="icon-btn"
                        type="button"
                        aria-label={`${t("scheduler.pause")}: ${task.title}`}
                        title={t("scheduler.pause")}
                        disabled={!writable || !!pending || running.cancelRequested}
                        onClick={() => action(task, "pause")}
                      >
                        <Pause size={14} />
                      </button>
                      <button
                        className="icon-btn"
                        type="button"
                        title={t("scheduler.stop")}
                        aria-label={`${t("scheduler.stop")}: ${task.title}`}
                        disabled={!writable || !!pending || running.cancelRequested}
                        onClick={() => action(task, "cancel")}
                      >
                        <I.stop size={14} />
                      </button>
                    </>
                  ) : (
                    <button
                      className="icon-btn"
                      type="button"
                      title={t(task.enabled ? "scheduler.pause" : "scheduler.resume")}
                      aria-label={`${t(task.enabled ? "scheduler.pause" : "scheduler.resume")}: ${task.title}`}
                      disabled={!writable || !!pending || !!task.goalCompletedAt}
                      onClick={() => action(task, task.enabled ? "pause" : "resume")}
                    >
                      <Pause size={14} />
                    </button>
                  )}
                  <button
                    className="icon-btn"
                    type="button"
                    title={t("scheduler.edit")}
                    aria-label={`${t("scheduler.edit")}: ${task.title}`}
                    disabled={!writable || !!pending}
                    onClick={() => {
                      const {
                        id,
                        revision,
                        title,
                        prompt,
                        mode,
                        editMode,
                        model,
                        enabled,
                        schedule,
                        timeoutMinutes,
                        budgetUsd,
                        reasoningEffort,
                        stagnationMinutes,
                        goal,
                        computerUse,
                        outputMode,
                      } = task;
                      setEditing({
                        id,
                        revision,
                        task: {
                          title,
                          prompt,
                          mode,
                          editMode,
                          model,
                          enabled,
                          schedule,
                          timeoutMinutes,
                          budgetUsd,
                          reasoningEffort,
                          stagnationMinutes,
                          goal,
                          computerUse,
                          outputMode,
                        },
                      });
                    }}
                  >
                    <I.pencil size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    type="button"
                    title={t("scheduler.delete")}
                    aria-label={`${t("scheduler.delete")}: ${task.title}`}
                    disabled={!writable || !!pending || !!running}
                    onClick={() => setDeleting(task.id)}
                  >
                    <I.trash size={14} />
                  </button>
                </div>
              </div>
              {running && (
                <div role="status" className="scheduled-run">
                  <strong>{running.progress?.currentStep ?? t("scheduler.running")}</strong>
                  <span>
                    {" "}
                    · {Math.max(0, Math.floor((Date.now() - running.startedAt) / 1000))}s
                  </span>
                  {running.progress?.recentActions.slice(-5).map((item, index) => (
                    <div key={`${item.at}:${index}`}>
                      {stamp(item.at)} · {item.text}
                    </div>
                  ))}
                </div>
              )}
              {running && <p className="scheduled-runtime">{t("scheduler.runningEditHint")}</p>}
              {deleting === task.id && (
                <div className="scheduled-actions">
                  <span>{t("scheduler.deleteConfirm")}</span>
                  <button
                    type="button"
                    className="btn danger"
                    disabled={!!pending}
                    onClick={() => action(task, "delete")}
                  >
                    {t("scheduler.delete")}
                  </button>
                  <button type="button" className="btn" onClick={() => setDeleting(undefined)}>
                    {t("scheduler.cancel")}
                  </button>
                </div>
              )}
              <details>
                <summary>
                  {t("scheduler.history")} ({task.runs.length})
                  {task.runs[0]
                    ? ` · ${t(`scheduler.${task.runs[0].status}` as "scheduler.running")}`
                    : ""}
                </summary>
                <p className="scheduled-prompt">{task.prompt}</p>
                {task.runs.map((run) => (
                  <div className="scheduled-run" key={run.id}>
                    <div className="scheduled-meta">
                      {stamp(run.startedAt)} · {t(`scheduler.${run.status}` as "scheduler.running")}
                      {run.session && (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => onOpenSession(run.session!)}
                        >
                          {t("scheduler.open")}
                        </button>
                      )}
                    </div>
                    <pre>{run.summary}</pre>
                    {task.goal && run.goalVerified === false && (
                      <p>{t("scheduler.goalRemaining")}</p>
                    )}
                    {run.progress?.pauseReason && <p role="alert">{run.progress.pauseReason}</p>}
                    {run.progress?.checkpoints.map((checkpoint, index) => (
                      <div key={`${checkpoint.at}:${index}`}>
                        <strong>{checkpoint.step}</strong>
                        <pre>{checkpoint.evidence.join("\n")}</pre>
                        <pre>{checkpoint.remaining.join("\n")}</pre>
                      </div>
                    ))}
                  </div>
                ))}
              </details>
            </article>
          );
        })
      )}
    </div>
  );
}
