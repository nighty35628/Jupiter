import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { useMemo, useState } from "react";
import type { SessionFile, Settings, UsageStats } from "../App";
import { Markdown } from "../Markdown";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import type { McpSpecInfo, MemoryDetail, MemoryEntryInfo, SubagentRunInfo } from "../protocol";
import { PanelErrorBoundary } from "./error-boundary";

type Tab = "files" | "tools" | "memory" | "rules";

const CONTEXT_MAX_TOKENS = 1_000_000;

export function ContextPanel({
  settings,
  usage,
  mcpSpecs,
  mcpBridged,
  subagents,
  sessionFiles,
  memory,
  memoryDetail,
  onOpenSubagent,
  onReadMemory,
}: {
  settings: Settings | null;
  usage: UsageStats;
  mcpSpecs: McpSpecInfo[];
  mcpBridged: boolean;
  subagents: SubagentRunInfo[];
  sessionFiles: SessionFile[];
  memory: MemoryEntryInfo[];
  memoryDetail: MemoryDetail | null;
  onOpenSubagent: (sessionName: string) => void;
  onReadMemory: (path: string) => void;
}) {
  useLang();
  const [tab, setTab] = useState<Tab>("files");
  const reserved = usage.reservedTokens;
  const lastHit = usage.lastCallCacheHit ?? 0;
  const lastMiss = usage.lastCallCacheMiss ?? 0;
  const observedLog = Math.max(0, lastHit + lastMiss - reserved);
  const logTokens = Math.max(usage.liveLogTokens, observedLog);
  const cached = Math.min(logTokens, Math.max(0, lastHit - reserved));
  const used = Math.max(0, logTokens - cached);
  const reservedPct = Math.min(100, (reserved / CONTEXT_MAX_TOKENS) * 100);
  const usedPct = Math.min(100, (used / CONTEXT_MAX_TOKENS) * 100);
  const cachedPct = Math.min(100, (cached / CONTEXT_MAX_TOKENS) * 100);
  const free = Math.max(0, CONTEXT_MAX_TOKENS - reserved - used - cached);
  return (
    <aside className="ctx">
      <div className="ctx-tabs">
        <div className="ctx-tab" data-active={tab === "files"} onClick={() => setTab("files")}>
          {t("contextPanel.filesTab")}
        </div>
        <div className="ctx-tab" data-active={tab === "tools"} onClick={() => setTab("tools")}>
          {t("contextPanel.toolsTab")}
        </div>
        <div className="ctx-tab" data-active={tab === "memory"} onClick={() => setTab("memory")}>
          {t("contextPanel.memoryTab")}
        </div>
        <div className="ctx-tab" data-active={tab === "rules"} onClick={() => setTab("rules")}>
          {t("contextPanel.rulesTab")}
        </div>
      </div>

      <div className="ctx-body">
        <div className="ctx-block ctx-body-tokens">
          <div className="h">
            <span>{t("contextPanel.contextTokens")}</span>
            <span className="right">
              {(reserved + used + cached).toLocaleString()} /{" "}
              {CONTEXT_MAX_TOKENS.toLocaleString()}
            </span>
          </div>
          <div className="meter">
            <span className="rsvd" style={{ width: `${reservedPct}%` }} />
            <span className="cached" style={{ width: `${cachedPct}%` }} />
            <span className="used" style={{ width: `${usedPct}%` }} />
          </div>
          <div className="legend">
            <span className="l">
              <span className="sw r" />
              {t("contextPanel.reservedKey")} <span className="v">{reserved.toLocaleString()}</span>
            </span>
            <span className="l">
              <span className="sw c" />
              {t("contextPanel.cacheKey")} <span className="v">{cached.toLocaleString()}</span>
            </span>
            <span className="l">
              <span className="sw u" />
              {t("contextPanel.usedKey")} <span className="v">{used.toLocaleString()}</span>
            </span>
            <span className="l">
              {t("contextPanel.freeKey")} <span className="v">{free.toLocaleString()}</span>
            </span>
          </div>
        </div>

        <div className="ctx-body-tab">
          <PanelErrorBoundary key={tab} label={tab}>
            {tab === "files" && <CtxFiles files={sessionFiles} settings={settings} />}
            {tab === "tools" && (
              <>
                <CtxSubagents runs={subagents} onOpen={onOpenSubagent} />
                <CtxTools specs={mcpSpecs} bridged={mcpBridged} />
              </>
            )}
            {tab === "memory" && (
              <CtxMemory entries={memory} detail={memoryDetail} onRead={onReadMemory} />
            )}
            {tab === "rules" && <CtxRules settings={settings} />}
          </PanelErrorBoundary>
        </div>
      </div>
    </aside>
  );
}

type TreeNode =
  | { kind: "dir"; depth: number; name: string; key: string }
  | { kind: "file"; depth: number; name: string; path: string; key: string; status: "c" | "m" };

async function openContextFile(path: string, settings: Settings | null): Promise<void> {
  const workspaceDir = settings?.workspaceDir;
  const isWindows = workspaceDir?.includes("\\") ?? false;
  const sep = isWindows ? "\\" : "/";
  const abs =
    workspaceDir && !/^[a-zA-Z]:[\\/]/.test(path) && !path.startsWith("/")
      ? `${workspaceDir.replace(/[\\/]$/, "")}${sep}${path.replace(/^[\\/]+/, "").replace(/\//g, sep)}`
      : isWindows
        ? path.replace(/\//g, "\\")
        : path;
  const editor = settings?.editor?.trim();
  if (editor) {
    await invoke("open_in_editor", { command: editor, path: abs, line: null });
    return;
  }
  await openPath(abs);
}

function buildSessionTree(files: SessionFile[]): TreeNode[] {
  const sorted = [...files].sort((a, b) =>
    a.path.replace(/\\/g, "/").localeCompare(b.path.replace(/\\/g, "/")),
  );
  const out: TreeNode[] = [];
  const seenDirs = new Set<string>();
  for (const f of sorted) {
    const displayPath = f.path.replace(/\\/g, "/");
    const parts = displayPath.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i] ?? "";
      prefix = prefix ? `${prefix}/${seg}` : seg;
      if (!seenDirs.has(prefix)) {
        seenDirs.add(prefix);
        out.push({ kind: "dir", depth: i, name: seg, key: `d:${prefix}` });
      }
    }
    const leaf = parts[parts.length - 1] ?? "";
    out.push({
      kind: "file",
      depth: parts.length - 1,
      name: leaf,
      path: displayPath,
      key: `f:${f.path}`,
      status: f.status,
    });
  }
  return out;
}

function CtxFiles({ files, settings }: { files: SessionFile[]; settings: Settings | null }) {
  const tree = useMemo(() => buildSessionTree(files), [files]);
  return (
    <div className="ctx-block">
      <div className="h">
        <span>{t("contextPanel.filesTitle")}</span>
        <span className="right">
          {files.length === 0 ? "—" : t("contextPanel.filesCount", { count: files.length })}
        </span>
      </div>
      <div className="tree">
        {files.length === 0 ? (
          <div className="ctx-empty">{t("contextPanel.noFilesMsg")}</div>
        ) : (
          tree.map((n) =>
            n.kind === "dir" ? (
              <div
                className="node"
                key={n.key}
                data-d={n.depth}
                data-kind="dir"
                style={{ paddingLeft: 4 + n.depth * 14 }}
              >
                <span className="ico">
                  <I.folder size={12} />
                </span>
                <span className="nm">{n.name}/</span>
              </div>
            ) : (
              <div
                className="node"
                key={n.key}
                data-d={n.depth}
                data-kind="file"
                title={n.path}
                style={{ paddingLeft: 4 + n.depth * 14 }}
              >
                <span className="ico">
                  <I.file size={12} />
                </span>
                <span className="node-text">
                  <span className="nm">{n.name}</span>
                  <span className="full-path">{n.path}</span>
                </span>
                <span
                  className="dot"
                  data-s={n.status}
                  title={n.status === "m" ? t("contextPanel.fileModified") : t("contextPanel.fileInContext")}
                />
                <button
                  type="button"
                  className="tree-action"
                  aria-label={t("contextPanel.openFile", { path: n.path })}
                  title={t("contextPanel.openFile", { path: n.path })}
                  onClick={() => void openContextFile(n.path, settings)}
                >
                  <I.file size={12} />
                </button>
                <button
                  type="button"
                  className="tree-action"
                  aria-label={t("contextPanel.copyPath", { path: n.path })}
                  title={t("contextPanel.copyPath", { path: n.path })}
                  onClick={() => void navigator.clipboard?.writeText(n.path)}
                >
                  <I.copy size={12} />
                </button>
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}

const SUBAGENT_NAMES = ["Nash", "Sagan", "Zeno", "Euclid", "Plato", "Ramanujan"];
const SUBAGENT_COLORS = [
  "var(--danger)",
  "var(--accent)",
  "var(--warning)",
  "var(--success)",
  "oklch(71% 0.17 306)",
  "oklch(70% 0.18 24)",
];

function stableIndex(value: string, size: number): number {
  let acc = 0;
  for (let i = 0; i < value.length; i++) acc = (acc * 31 + value.charCodeAt(i)) >>> 0;
  return size === 0 ? 0 : acc % size;
}

function formatElapsed(ms?: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function subagentMeta(run: SubagentRunInfo): string {
  const bits = [
    run.status === "failed"
      ? t("contextPanel.subagentFailed")
      : run.status === "done"
        ? t("contextPanel.subagentDone")
        : run.phase === "summarising"
          ? t("contextPanel.subagentSummarising")
          : t("contextPanel.subagentRunning"),
  ];
  if (typeof run.iter === "number" && run.iter > 0) {
    bits.push(t("contextPanel.subagentToolCalls", { count: run.iter }));
  }
  if (typeof run.turns === "number" && run.turns > 0) {
    bits.push(t("contextPanel.subagentTurns", { count: run.turns }));
  }
  const elapsed = formatElapsed(run.elapsedMs);
  if (elapsed) bits.push(elapsed);
  return bits.join(" · ");
}

function CtxSubagents({
  runs,
  onOpen,
}: {
  runs: SubagentRunInfo[];
  onOpen: (sessionName: string) => void;
}) {
  const visible = runs.slice().reverse();
  return (
    <div className="ctx-block">
      <div className="h">
        <span>{t("contextPanel.subagentsTitle")}</span>
        <span className="right">
          {visible.length === 0 ? "—" : t("contextPanel.subagentsCount", { count: visible.length })}
        </span>
      </div>
      {visible.length === 0 ? (
        <div className="ctx-empty">{t("contextPanel.subagentsEmpty")}</div>
      ) : (
        <div className="subagent-list">
          {visible.map((run) => {
            const name = SUBAGENT_NAMES[stableIndex(run.runId, SUBAGENT_NAMES.length)] ?? "Nash";
            const accent =
              SUBAGENT_COLORS[stableIndex(`${run.runId}:color`, SUBAGENT_COLORS.length)] ??
              "var(--accent)";
            const role = run.skillName?.trim() || t("contextPanel.subagentRoleFallback");
            const disabled = !run.sessionName;
            return (
              <button
                type="button"
                className="subagent-row"
                key={run.runId}
                data-status={run.status}
                disabled={disabled}
                aria-label={t("contextPanel.subagentOpen", { task: run.task })}
                title={disabled ? undefined : t("contextPanel.subagentOpen", { task: run.task })}
                style={{ ["--subagent-accent" as string]: accent }}
                onClick={() => {
                  if (run.sessionName) onOpen(run.sessionName);
                }}
              >
                <span className="subagent-ico" aria-hidden="true">
                  <I.bot size={15} />
                </span>
                <span className="subagent-body">
                  <span className="subagent-head">
                    <span className="subagent-name">{name}</span>
                    <span className="subagent-role">({role})</span>
                  </span>
                  <span className="subagent-task">{run.task}</span>
                  <span className="subagent-meta">{subagentMeta(run)}</span>
                </span>
                <span className="subagent-status" data-s={run.status} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CtxTools({ specs, bridged }: { specs: McpSpecInfo[]; bridged: boolean }) {
  const readyCount = specs.filter((s) => s.status === "connected").length;
  return (
    <div className="ctx-block">
      <div className="h">
        <span>{t("contextPanel.mcpTitle")}</span>
        <span className="right">
          {specs.length === 0
            ? "—"
            : bridged
              ? t("contextPanel.mcpReadyAll", { count: specs.length })
              : t("contextPanel.mcpReadySome", { ready: readyCount, count: specs.length })}
        </span>
      </div>
      {specs.length === 0 ? (
        <div className="ctx-empty">{t("contextPanel.mcpEmpty")}</div>
      ) : (
        specs.map((s) => {
          const dot =
            s.status === "connected"
              ? "ok"
              : s.status === "failed" || s.parseError
                ? "off"
                : "pending";
          const suffix = s.statusReason
            ? ` · ${s.statusReason}`
            : s.status === "connected"
              ? typeof s.toolCount === "number"
                ? ` · ${t("contextPanel.mcpTools", { count: s.toolCount })}`
                : ` · ${t("contextPanel.mcpReady")}`
              : s.status === "handshake"
                ? ` · ${t("contextPanel.mcpConnecting")}`
                : s.status === "disabled"
                  ? ` · ${t("contextPanel.mcpDisabled")}`
                  : s.status === "failed"
                    ? ` · ${t("contextPanel.mcpFailed")}`
                    : ` · ${t("contextPanel.mcpConfigured")}`;
          return (
            <div className="mcp-row" key={s.raw}>
              <span className="ico">
                <I.wrench size={12} />
              </span>
              <div className="body">
                <div className="n">{s.name ?? s.summary}</div>
                <div className="m">
                  {s.transport}
                  {suffix}
                </div>
              </div>
              <span className="status" data-s={dot} />
            </div>
          );
        })
      )}
    </div>
  );
}

function CtxMemory({
  entries,
  detail,
  onRead,
}: {
  entries: MemoryEntryInfo[];
  detail: MemoryDetail | null;
  onRead: (path: string) => void;
}) {
  return (
    <div className="ctx-block" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="h">
        <span>{t("contextPanel.memoryTitle")}</span>
        <span className="right">
          {entries.length === 0 ? "—" : t("contextPanel.itemCount", { count: entries.length })}
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="ctx-empty">{t("contextPanel.noMemoriesMsg")}</div>
      ) : (
        <div className="mem" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div style={{ flexShrink: 0 }}>
            {entries.map((m) => (
              <button
                type="button"
                className="mem-row"
                data-active={detail?.path === m.path}
                key={m.path}
                onClick={() => onRead(m.path)}
              >
                <span className="scope" data-s={m.scope}>
                  {m.scope === "project" ? t("contextPanel.scopeProject") : t("contextPanel.scopeGlobal")}
                </span>
                <span className="txt">{m.description || m.name}</span>
              </button>
            ))}
          </div>
          {detail ? (
            <div className="mem-detail">
              <Markdown source={detail.body} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function CtxRules({ settings }: { settings: Settings | null }) {
  const editMode = settings?.editMode ?? "review";
  const items: { p: string; allow: boolean; desc: string }[] =
    editMode === "yolo"
      ? [{ p: "*", allow: true, desc: t("contextPanel.ruleYolo") }]
      : editMode === "auto"
        ? [
            { p: "read_file, list_directory, search_files, *", allow: true, desc: t("contextPanel.ruleReadOnly") },
            { p: "run_command (allowlist)", allow: true, desc: t("contextPanel.ruleShellAllowlist") },
            { p: "edit_file, write_file, run_command (other)", allow: false, desc: t("contextPanel.ruleWritesAsk") },
          ]
        : [
            { p: "*", allow: false, desc: t("contextPanel.ruleReview") },
          ];
  return (
    <div className="ctx-block">
      <div className="h">
        <span>{t("contextPanel.autoApproveTitle")}</span>
        <span className="right">{editMode}</span>
      </div>
      {items.map((r) => (
        <div className="rule" key={r.p}>
          <div className="top">
            <span className={`pat ${r.allow ? "" : "deny"}`}>{r.p}</span>
            <span className={`sw ${r.allow ? "" : "deny"}`}>
              {r.allow ? t("contextPanel.allow") : t("contextPanel.ask")}
            </span>
          </div>
          <div className="desc">{r.desc}</div>
        </div>
      ))}
    </div>
  );
}
