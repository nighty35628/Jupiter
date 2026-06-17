import type { ApprovalPrompt } from "@jupiter/core-utils";
import {
  isCompactionSummary,
  stripCompactionMarker,
} from "@jupiter/core-utils/compaction";
import { derivePrefix } from "@jupiter/core-utils/derive-prefix";
import { Copy, Undo2 } from "lucide-react";
import { type ReactNode, memo, useEffect, useRef, useState } from "react";
import type {
  ActivePlan,
  AssistantSegment,
  PendingCheckpoint,
  PendingChoice,
  PendingConfirm,
  PendingPlan,
  PendingRevision,
  SkillOrigin,
} from "../App";
import { Markdown } from "../Markdown";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import {
  AssistantText,
  CompactionCard,
  DiffCard,
  PlanCardView,
  type PlanItem,
  ReasoningCard,
  ShellCard,
  SkillCard,
  ToolCard,
  deriveRunSkillUsage,
  parseEditResult,
} from "./cards";
import { ApprovalCard, TaskCard, type TaskStepView } from "./extra-cards";

export function TurnDivider({ label }: { label: string }) {
  return (
    <div className="turn-divider">
      <span>{label}</span>
      <span className="line" />
    </div>
  );
}

export const UserMsg = memo(function UserMsg({
  text,
  time,
  skill,
  onEdit,
  onRollback,
  rollbackAvailable = false,
}: {
  text: string;
  time?: string;
  skill?: SkillOrigin;
  onEdit?: (text: string) => void;
  onRollback?: () => void;
  rollbackAvailable?: boolean;
}) {
  useLang();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="msg user">
      <div className="avatar">YOU</div>
      <div className="body">
        <div className="who">
          <span className="name">{t("thread.you")}</span>
          {skill ? (
            <span className="skill-chip" title={`skill · ${skill.runAs}`}>
              <I.zap size={10} /> /{skill.name}
              {skill.runAs === "subagent" ? (
                <span className="sub">{t("thread.subagent")}</span>
              ) : null}
            </span>
          ) : null}
          {time ? <span className="time">{time}</span> : null}
        </div>
        <div className="msg-text">{text}</div>
        <div className="msg-actions">
          <RollbackButton
            available={rollbackAvailable}
            onRollback={onRollback}
          />
          {onEdit ? (
            <button
              type="button"
              className="edit-btn"
              onClick={() => onEdit(text)}
              title={t("thread.editMessage")}
            >
              <I.pencil size={11} />
            </button>
          ) : null}
          <button
            type="button"
            className={`copy-btn ${copied ? "done" : ""}`}
            onClick={onCopy}
            title={t("thread.copyMessage")}
          >
            <Copy size={11} />
            {copied ? t("markdown.copied") : null}
          </button>
        </div>
      </div>
    </div>
  );
});

function RollbackButton({
  available,
  onRollback,
}: {
  available: boolean;
  onRollback?: () => void;
}) {
  const title = available
    ? t("thread.rollbackToHere")
    : t("thread.rollbackUnavailable");
  return (
    <button
      type="button"
      className="rollback-btn"
      onClick={available ? onRollback : undefined}
      disabled={!available}
      title={title}
      aria-label={title}
    >
      <Undo2 size={12} />
    </button>
  );
}

function ToolGroupShell({
  segs,
  renderTool: rt,
  defaultOpen,
}: {
  segs: (AssistantSegment & { kind: "tool" })[];
  renderTool: (
    s: AssistantSegment & { kind: "tool" },
    idx: number,
    expanded?: boolean,
  ) => ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="tool-group">
      <button className="tool-group-header" onClick={() => setOpen((o) => !o)}>
        <span>
          {segs.length > 1
            ? t("thread.toolCalls", { count: segs.length })
            : t("thread.oneToolCall")}
        </span>
        <span className={`chevron ${open ? "open" : ""}`}>
          {I.chev({ size: 12 })}
        </span>
      </button>
      {open && (
        <div className="tool-group-body">
          {segs.map((ts) => rt(ts, segs.indexOf(ts), true))}
        </div>
      )}
    </div>
  );
}

type UsedLibrarySource = {
  sourceId: string;
  title: string;
  url?: string;
  path?: string;
};

function parseUsedLibrarySources(segments: AssistantSegment[]): UsedLibrarySource[] {
  const seen = new Set<string>();
  const sources: UsedLibrarySource[] = [];
  for (const segment of segments) {
    if (segment.kind !== "tool" || segment.name !== "library_read" || segment.ok === false) {
      continue;
    }
    if (!segment.result) continue;
    try {
      const parsed = JSON.parse(segment.result) as Partial<UsedLibrarySource>;
      const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
      const sourceId = typeof parsed.sourceId === "string" ? parsed.sourceId : title;
      if (!title || !sourceId || seen.has(sourceId)) continue;
      seen.add(sourceId);
      sources.push({
        sourceId,
        title,
        url: typeof parsed.url === "string" ? parsed.url : undefined,
        path: typeof parsed.path === "string" ? parsed.path : undefined,
      });
    } catch {
      /* ignore malformed tool output */
    }
  }
  return sources;
}

function UsedSourcesStrip({ sources }: { sources: UsedLibrarySource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="used-sources-strip">
      <span className="used-sources-label">{t("thread.usedSources")}</span>
      <div className="used-sources-list">
        {sources.map((source) => (
          <span
            key={source.sourceId}
            className="used-source-chip"
            title={source.url ?? source.path ?? source.title}
          >
            <I.bookmark size={10} />
            <span>{source.title}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export const AssistantMsg = memo(function AssistantMsg({
  segments,
  pending,
  model,
  time,
  onRollback,
  rollbackAvailable = false,
  onApproveConfirm,
  onRejectConfirm,
  onAlwaysAllowConfirm,
  pendingConfirms,
  processCardsDefaultOpen = false,
}: {
  segments: AssistantSegment[];
  pending: boolean;
  model?: string;
  time?: string;
  onRollback?: () => void;
  rollbackAvailable?: boolean;
  onApproveConfirm: (id: number) => void;
  onRejectConfirm: (id: number) => void;
  onAlwaysAllowConfirm: (id: number, prefix: string) => void;
  pendingConfirms: PendingConfirm[];
  processCardsDefaultOpen?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const content = segments
    .filter((s): s is AssistantSegment & { kind: "text" } => s.kind === "text")
    .map((s) => s.text)
    .join("\n\n");
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };
  const usedSources = parseUsedLibrarySources(segments);
  // Render tool segments — consecutive tools get grouped into a collapsible section
  const rendered: ReactNode[] = [];

  let firstReasoningShown = false;
  let toolGroup: {
    segments: (AssistantSegment & { kind: "tool" })[];
    indices: number[];
  } | null = null;

  function flushToolGroup(): void {
    if (!toolGroup) return;
    const { segments: tSegs } = toolGroup;
    const groupKey = toolGroup.indices[0]!;
    if (tSegs.length === 1) {
      rendered.push(renderTool(tSegs[0]!, groupKey));
    } else {
      rendered.push(
        <ToolGroupShell
          key={`tool-group-${groupKey}`}
          segs={tSegs}
          renderTool={renderTool}
          defaultOpen={processCardsDefaultOpen}
        />,
      );
    }
    toolGroup = null;
  }

  function renderTool(
    s: AssistantSegment & { kind: "tool" },
    idx: number,
    expanded?: boolean,
  ): ReactNode {
    const skillUsage = deriveRunSkillUsage(s.name, s.args);
    if (skillUsage) {
      const status: "running" | "done" | "failed" =
        s.result === undefined ? "running" : s.ok === false ? "failed" : "done";
      return (
        <SkillCard
          key={idx}
          skillName={skillUsage.skillName}
          argumentsSummary={skillUsage.argumentsSummary}
          isSubagentWrapper={skillUsage.isSubagentWrapper}
          status={status}
          result={s.result}
          ok={s.ok}
          durationMs={s.durationMs}
          defaultOpen={expanded ?? (status !== "done" || processCardsDefaultOpen)}
        />
      );
    }
    const pendingConfirm =
      (s.name === "run_command" || s.name === "run_background") &&
      s.result === undefined
        ? pendingConfirms.find((c) => c.command === extractCommand(s.args))
        : undefined;
    if (s.name === "run_command" || s.name === "run_background") {
      const cmd = extractCommand(s.args) ?? s.args;
      const state: "await" | "running" | "done" | "failed" =
        s.result === undefined
          ? pendingConfirm
            ? "await"
            : "running"
          : s.ok === false
            ? "failed"
            : "done";
      return (
        <ShellCard
          key={idx}
          command={cmd}
          output={s.result}
          state={state}
          durationMs={s.durationMs}
          defaultOpen={
            expanded ?? (state !== "done" || processCardsDefaultOpen)
          }
          onApprove={
            pendingConfirm
              ? () => onApproveConfirm(pendingConfirm.id)
              : undefined
          }
          onReject={
            pendingConfirm
              ? () => onRejectConfirm(pendingConfirm.id)
              : undefined
          }
          onAlwaysAllow={
            pendingConfirm
              ? () => {
                  onAlwaysAllowConfirm(pendingConfirm.id, derivePrefix(cmd));
                }
              : undefined
          }
        />
      );
    }
    if (
      s.result &&
      (s.name === "edit_file" ||
        s.name === "multi_edit" ||
        s.name === "write_file")
    ) {
      const files = parseEditResult(s.result);
      return files.length > 0 ? (
        <>
          {files.map((f, fi) => (
            <DiffCard
              key={`${idx}-${fi}`}
              filename={f.filename}
              lines={f.lines}
              applied={s.ok !== false}
            />
          ))}
        </>
      ) : (
        <ToolCard
          key={idx}
          name={s.name}
          args={s.args}
          result={s.result}
          ok={s.ok}
          durationMs={s.durationMs}
          defaultOpen={
            expanded ??
            (s.result === undefined ||
              s.ok === false ||
              processCardsDefaultOpen)
          }
        />
      );
    }
    return (
      <ToolCard
        key={idx}
        name={s.name}
        args={s.args}
        result={s.result}
        ok={s.ok}
        durationMs={s.durationMs}
        defaultOpen={
          expanded ??
          (s.result === undefined || s.ok === false || processCardsDefaultOpen)
        }
      />
    );
  }

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s.kind === "text") {
      flushToolGroup();
      if (!s.text.trim()) continue;
      if (isCompactionSummary(s.text)) {
        rendered.push(
          <CompactionCard
            key={`t-${i}`}
            summary={stripCompactionMarker(s.text)}
          />,
        );
      } else {
        rendered.push(<AssistantText key={`t-${i}`} text={s.text} />);
      }
      continue;
    }
    if (s.kind === "reasoning") {
      flushToolGroup();
      if (!firstReasoningShown) {
        firstReasoningShown = true;
        rendered.push(
          <ReasoningCard
            key={`r-${i}`}
            text={s.text}
            streaming={pending}
            defaultOpen={processCardsDefaultOpen}
          />,
        );
      }
      // Subsequent reasoning segments are intermediate tool-calling thought — hidden
      continue;
    }
    // Tool segment — accumulate into group
    if (!toolGroup) {
      toolGroup = { segments: [], indices: [] };
    }
    toolGroup.segments.push(s);
    toolGroup.indices.push(i);
  }

  flushToolGroup();

  return (
    <div className="msg assistant">
      <div className="avatar">J</div>
      <div className="body">
        <div className="who">
          <span className="name">Jupiter</span>
          {model ? <span className="model">{model}</span> : null}
          {time ? <span className="time">{time}</span> : null}
        </div>
        {rendered}
        <UsedSourcesStrip sources={usedSources} />
        {content ? (
          <div className="msg-actions">
            <RollbackButton
              available={rollbackAvailable}
              onRollback={onRollback}
            />
            <button
              type="button"
              className={`copy-btn ${copied ? "done" : ""}`}
              onClick={onCopy}
              title={t("thread.copyResponse")}
            >
              <Copy size={11} />
              {copied ? t("markdown.copied") : null}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
});

function extractCommand(args: string): string | undefined {
  if (!args) return undefined;
  try {
    const v = JSON.parse(args);
    if (v && typeof v === "object" && typeof v.command === "string")
      return v.command;
  } catch {
    // ignore
  }
  return undefined;
}

export function PlanBanner({
  plan,
  onDismiss,
}: {
  plan: ActivePlan;
  onDismiss?: () => void;
}) {
  useLang();
  const total = plan.steps.length || 1;
  const done = plan.completedStepIds.length;
  const pct = (done / total) * 100;
  const current = plan.steps.find((s) => !plan.completedStepIds.includes(s.id));
  return (
    <div className="plan-banner">
      <span className="ico">
        <I.list size={14} />
      </span>
      <div className="body">
        <div className="t">
          {t("thread.planRunning", { step: Math.min(done + 1, total), total })}
          {current ? ` — ${current.title}` : ""}
        </div>
        <Markdown source={plan.plan} />
      </div>
      <div className="prog">
        <div className="meter-mini">
          <span style={{ width: `${pct}%` }} />
        </div>
        {onDismiss ? (
          <button type="button" onClick={onDismiss}>
            {t("thread.collapse")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ActivePlanCard({ plan }: { plan: ActivePlan }) {
  useLang();
  const done = new Set(plan.completedStepIds);
  const items: PlanItem[] = plan.steps.map((s) => {
    let status: PlanItem["status"];
    if (done.has(s.id)) status = "done";
    else if (s === plan.steps.find((x) => !done.has(x.id))) status = "active";
    else status = "todo";
    return {
      id: s.id,
      status,
      text: s.title,
      tool: s.action,
      note: s.risk ? `${t("thread.risk")}: ${s.risk}` : undefined,
    };
  });
  return <PlanCardView items={items} title={t("thread.activePlan")} />;
}

// ---- Approval bindings ----

export function PlanApprovalCard({
  p,
  onApprove,
  onRefine,
  onCancel,
}: {
  p: PendingPlan;
  onApprove: () => void;
  onRefine: (feedback?: string) => void;
  onCancel: (feedback?: string) => void;
}) {
  useLang();
  const [feedbackMode, setFeedbackMode] = useState<"cancel" | "refine" | null>(
    null,
  );
  const [feedbackText, setFeedbackText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (feedbackMode && inputRef.current) {
      inputRef.current.focus();
    }
  }, [feedbackMode]);

  const handleSendFeedback = () => {
    const fb = feedbackText.trim() || undefined;
    if (feedbackMode === "cancel") onCancel(fb);
    else if (feedbackMode === "refine") onRefine(fb);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendFeedback();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (feedbackMode === "cancel") onCancel();
      else if (feedbackMode === "refine") onRefine();
    }
  };

  const stepCount = p.steps?.length ?? 0;
  const sub =
    stepCount > 0 ? t("thread.planStepCount", { count: stepCount }) : undefined;

  if (feedbackMode) {
    const isCancel = feedbackMode === "cancel";
    return (
      <div className="approval" data-tone="info">
        <div className="ap-head">
          <span className="ap-ico">
            <I.shield size={13} />
          </span>
          <div>
            <div className="ap-kind">{t("thread.planConfirmationKind")}</div>
            <div className="ap-title">
              {isCancel
                ? t("thread.cancelFeedbackLabel")
                : t("thread.refineFeedbackLabel")}
            </div>
          </div>
        </div>
        <div className="ap-body">
          <textarea
            ref={inputRef}
            className="approval-textarea"
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("modal.planFeedbackPlaceholder")}
          />
        </div>
        <div className="ap-foot">
          <button
            type="button"
            className="btn primary"
            onClick={handleSendFeedback}
          >
            {t("thread.sendFeedback")}
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => (isCancel ? onCancel() : onRefine())}
          >
            {t("thread.skipFeedback")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <ApprovalCard
      kind={t("thread.planConfirmationKind")}
      tone="info"
      title={t("thread.startPlan")}
      sub={sub}
      body={
        <>
          {p.summary ? (
            <div style={{ marginBottom: 6 }}>
              <Markdown source={p.summary} />
            </div>
          ) : null}
          <Markdown source={p.plan} />
        </>
      }
      meta={`plan/#${p.id}`}
      primaryLabel={t("thread.approve")}
      secondaryLabel={t("thread.cancel")}
      tertiaryLabel={t("thread.refine")}
      onPrimary={onApprove}
      onSecondary={() => setFeedbackMode("cancel")}
      onTertiary={() => setFeedbackMode("refine")}
    />
  );
}

export function CheckpointApprovalCard({
  c,
  onContinue,
  onRevise,
  onStop,
}: {
  c: PendingCheckpoint;
  onContinue: () => void;
  onRevise: () => void;
  onStop: () => void;
}) {
  useLang();
  return (
    <ApprovalCard
      kind={t("thread.checkpointKind")}
      tone="brand"
      title={
        c.title ??
        t("thread.checkpointTitle", { completed: c.completed, total: c.total })
      }
      sub={t("thread.checkpointSub", {
        completed: c.completed,
        total: c.total,
      })}
      body={
        <>
          <div style={{ whiteSpace: "pre-wrap" }}>{c.result}</div>
          {c.notes ? (
            <div
              style={{ marginTop: 8, fontSize: 11.5, color: "var(--muted)" }}
            >
              {c.notes}
            </div>
          ) : null}
        </>
      }
      meta={`checkpoint · ${c.stepId}`}
      primaryLabel={t("thread.continue")}
      secondaryLabel={t("thread.stop")}
      tertiaryLabel={t("thread.revise")}
      onPrimary={onContinue}
      onSecondary={onStop}
      onTertiary={onRevise}
    />
  );
}

export function RevisionApprovalCard({
  r,
  onAccept,
  onReject,
}: {
  r: PendingRevision;
  onAccept: () => void;
  onReject: () => void;
}) {
  useLang();
  return (
    <ApprovalCard
      kind={t("thread.planRevisionKind")}
      tone="warn"
      title={t("thread.rewritePlan")}
      sub={t("thread.keepSteps", { n: r.remainingSteps.length })}
      body={
        <>
          <div style={{ marginBottom: 8 }}>{r.reason}</div>
          {r.summary ? (
            <div
              style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 8 }}
            >
              {r.summary}
            </div>
          ) : null}
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {r.remainingSteps.map((s) => (
              <li key={s.id} style={{ fontSize: 12, marginBottom: 2 }}>
                {s.title}
                {s.risk ? (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      color:
                        s.risk === "high"
                          ? "var(--tone-err)"
                          : s.risk === "med"
                            ? "var(--tone-warn)"
                            : "var(--muted)",
                    }}
                  >
                    [{s.risk}]
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      }
      meta={t("thread.revisionMeta")}
      primaryLabel={t("thread.approveRewrite")}
      secondaryLabel={t("thread.keepOriginal")}
      onPrimary={onAccept}
      onSecondary={onReject}
    />
  );
}

function mapTone(
  tone: ApprovalPrompt["tone"],
): import("./extra-cards").ApprovalTone {
  switch (tone) {
    case "error":
      return "danger";
    case "accent":
      return "brand";
    default:
      return tone;
  }
}

export function ConfirmApprovalCard({
  prompt,
  onAllow,
  onAlwaysAllow,
  onDeny,
}: {
  prompt: ApprovalPrompt;
  onAllow: () => void;
  onAlwaysAllow: (prefix: string) => void;
  onDeny: () => void;
}) {
  useLang();
  const prefix = String(prompt.data?.prefix ?? "");
  const allowAction = prompt.actions.find((a) => a.kind === "allow_once");
  const alwaysAllowAction = prompt.actions.find(
    (a) => a.kind === "allow_always",
  );
  const rejectAction = prompt.actions.find((a) => a.kind === "reject");
  return (
    <ApprovalCard
      kind={t("thread.shellConfirmationKind")}
      tone={mapTone(prompt.tone)}
      title={prompt.title}
      sub={prompt.subtitle}
      preview={
        <>
          <span style={{ color: "var(--accent)" }}>$</span>{" "}
          {prompt.preview ?? prompt.subtitle}
        </>
      }
      previewClassName="ap-preview--long"
      meta={t("thread.riskMedium", {
        kind: prompt.kind === "shell" ? "run_command" : "run_background",
      })}
      primaryLabel={allowAction?.label ?? t("thread.execute")}
      secondaryLabel={rejectAction?.label ?? t("thread.reject")}
      tertiaryLabel={
        alwaysAllowAction?.label ?? t("thread.alwaysAllow", { prefix })
      }
      onPrimary={onAllow}
      onSecondary={onDeny}
      onTertiary={() => onAlwaysAllow(prefix)}
    />
  );
}

export function PathAccessApprovalCard({
  prompt,
  onAllow,
  onAlwaysAllow,
  onDeny,
}: {
  prompt: ApprovalPrompt;
  onAllow: () => void;
  onAlwaysAllow: (prefix: string) => void;
  onDeny: () => void;
}) {
  useLang();
  const prefix = String(prompt.data?.prefix ?? "");
  const intent = String(prompt.data?.intent ?? "read");
  const isWrite = intent === "write";
  const allowAction = prompt.actions.find((a) => a.kind === "allow_once");
  const alwaysAllowAction = prompt.actions.find(
    (a) => a.kind === "allow_always",
  );
  const rejectAction = prompt.actions.find((a) => a.kind === "reject");
  return (
    <ApprovalCard
      kind={t("thread.pathAccessKind")}
      tone={mapTone(prompt.tone)}
      title={prompt.title}
      sub={prompt.subtitle}
      preview={
        <>
          <div>{prompt.preview ?? prompt.subtitle}</div>
          {prompt.meta?.sandboxRoot ? (
            <div style={{ color: "var(--muted)", marginTop: 4 }}>
              workspace: {prompt.meta.sandboxRoot}
            </div>
          ) : null}
        </>
      }
      previewClassName="ap-preview--long"
      meta={t("thread.riskMedium", { kind: intent })}
      primaryLabel={
        allowAction?.label ??
        (isWrite ? t("thread.allowWrite") : t("thread.allowRead"))
      }
      secondaryLabel={rejectAction?.label ?? t("thread.reject")}
      tertiaryLabel={
        alwaysAllowAction?.label ?? t("thread.alwaysAllowPrefix", { prefix })
      }
      onPrimary={onAllow}
      onSecondary={onDeny}
      onTertiary={() => onAlwaysAllow(prefix)}
    />
  );
}

export function ChoiceApprovalCard({
  c,
  onPick,
  onCancel,
}: {
  c: PendingChoice;
  onPick: (optionId: string) => void;
  onCancel: () => void;
}) {
  useLang();
  return (
    <div className="approval choice-approval" data-tone="info">
      <div className="choice-approval-head">
        <span className="choice-approval-ico">
          <I.list size={15} />
        </span>
        <div className="choice-approval-copy">
          <div className="choice-approval-kind">
            {t("thread.userChoiceKind")}
          </div>
          <div className="choice-approval-title">{c.question}</div>
        </div>
        <span className="choice-approval-count">
          {t("thread.optionCount", { count: c.options.length })}
        </span>
      </div>

      <div className="choice-approval-options">
        {c.options.map((o, index) => (
          <button
            key={o.id}
            type="button"
            className="choice-approval-option"
            onClick={() => onPick(o.id)}
          >
            <span className="choice-approval-option-index">{index + 1}</span>
            <span className="choice-approval-option-copy">
              <span className="choice-approval-option-title">{o.title}</span>
              {o.summary ? (
                <span className="choice-approval-option-summary">
                  {o.summary}
                </span>
              ) : null}
            </span>
            <I.chevR className="choice-approval-option-arrow" size={14} />
          </button>
        ))}
      </div>

      <div className="choice-approval-foot">
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t("thread.cancel")}
        </button>
      </div>
    </div>
  );
}

export function activePlanToTaskSteps(plan: ActivePlan): TaskStepView[] {
  const done = new Set(plan.completedStepIds);
  return plan.steps.map((s, i) => ({
    n: String(i + 1),
    state: done.has(s.id)
      ? "done"
      : i === plan.completedStepIds.length
        ? "running"
        : "queued",
    label: s.title,
    hint: s.action,
    durationLabel: undefined,
  }));
}

export function ActivePlanTaskCard({ plan }: { plan: ActivePlan }) {
  useLang();
  return (
    <TaskCard
      title={t("thread.activePlan")}
      subtitle={plan.summary}
      steps={activePlanToTaskSteps(plan)}
    />
  );
}

export function HeaderHint({ children }: { children: ReactNode }) {
  return <div className="msg-text">{children}</div>;
}
