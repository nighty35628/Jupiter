import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState } from "react";
import type { SessionFile, Settings, UsageStats } from "../App";
import { Markdown } from "../Markdown";
import type { FilePreview, FilePreviewTarget } from "../file-preview";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import type { McpSpecInfo, MemoryDetail, MemoryEntryInfo, SubagentRunInfo } from "../protocol";
import { PanelErrorBoundary } from "./error-boundary";
import { FileActionMenu } from "./file-action-menu";

export type ContextPanelMode = "info" | "preview";

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
  selectedFilePreview,
  filePreviewLoading = false,
  filePreviewError = null,
  filePreviewPath = null,
  mode,
  onModeChange,
  onOpenSubagent,
  onReadMemory,
  onPreviewFile,
}: {
  settings: Settings | null;
  usage: UsageStats;
  mcpSpecs: McpSpecInfo[];
  mcpBridged: boolean;
  subagents: SubagentRunInfo[];
  sessionFiles: SessionFile[];
  memory: MemoryEntryInfo[];
  memoryDetail: MemoryDetail | null;
  selectedFilePreview?: FilePreview | null;
  filePreviewLoading?: boolean;
  filePreviewError?: string | null;
  filePreviewPath?: string | null;
  mode?: ContextPanelMode;
  onModeChange?: (mode: ContextPanelMode) => void;
  onOpenSubagent: (sessionName: string) => void;
  onReadMemory: (path: string) => void;
  onPreviewFile?: (target: FilePreviewTarget) => void;
}) {
  useLang();
  const [localMode, setLocalMode] = useState<ContextPanelMode>("info");
  const activeMode = mode ?? localMode;
  const setPanelMode = onModeChange ?? setLocalMode;
  const previewPath = selectedFilePreview?.path ?? filePreviewPath;
  const previewAvailable = Boolean(previewPath || filePreviewLoading || filePreviewError);
  useEffect(() => {
    if (previewPath) setPanelMode("preview");
  }, [previewPath, setPanelMode]);
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
  const showPreview = previewAvailable && activeMode === "preview";
  return (
    <aside className="ctx" data-mode={showPreview ? "preview" : "info"}>
      {showPreview ? (
        <div className="ctx-preview-shell">
          <PanelErrorBoundary key="preview" label="preview">
            <FilePreviewPane
              preview={selectedFilePreview ?? null}
              loading={Boolean(filePreviewLoading)}
              error={filePreviewError ?? null}
              fallbackPath={filePreviewPath}
              workspaceDir={settings?.workspaceDir}
              editor={settings?.editor}
              onPreviewFile={onPreviewFile}
              full
            />
          </PanelErrorBoundary>
        </div>
      ) : (
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
                {t("contextPanel.reservedKey")}{" "}
                <span className="v">{reserved.toLocaleString()}</span>
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
            <PanelErrorBoundary key="info" label="info">
              <CtxFiles
                files={sessionFiles}
                settings={settings}
                activePath={previewPath}
                onPreviewFile={onPreviewFile}
              />
              <CtxSubagents runs={subagents} onOpen={onOpenSubagent} />
              <CtxTools specs={mcpSpecs} bridged={mcpBridged} />
              <CtxMemory entries={memory} detail={memoryDetail} onRead={onReadMemory} />
            </PanelErrorBoundary>
          </div>
        </div>
      )}
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

function CtxFiles({
  files,
  settings,
  activePath,
  onPreviewFile,
}: {
  files: SessionFile[];
  settings: Settings | null;
  activePath?: string | null;
  onPreviewFile?: (target: FilePreviewTarget) => void;
}) {
  const tree = useMemo(() => buildSessionTree(files), [files]);
  const [menu, setMenu] = useState<{ path: string; left: number; top: number } | null>(null);
  const workspaceDir = settings?.workspaceDir;
  const editor = settings?.editor;
  const openMenuAt = (path: string, left: number, top: number) => {
    setMenu({ path, left, top });
  };
  const openMenu = (path: string, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    openMenuAt(path, rect.right - 4, rect.bottom + 4);
  };
  return (
    <>
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
                  data-active={activePath === n.path}
                  title={n.path}
                  style={{ paddingLeft: 4 + n.depth * 14 }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openMenuAt(n.path, event.clientX, event.clientY);
                  }}
                >
                  <button
                    type="button"
                    className="node-main"
                    onClick={() => onPreviewFile?.({ path: n.path })}
                  >
                    <span className="ico">
                      <I.file size={12} />
                    </span>
                    <span className="node-text">
                      <span className="nm">{n.name}</span>
                      <span className="full-path">{n.path}</span>
                    </span>
                  </button>
                  <span
                    className="dot"
                    data-s={n.status}
                    title={
                      n.status === "m"
                        ? t("contextPanel.fileModified")
                        : t("contextPanel.fileInContext")
                    }
                  />
                  <button
                    type="button"
                    className="tree-action"
                    aria-label={t("contextPanel.openFile", { path: n.path })}
                    title={t("contextPanel.openFile", { path: n.path })}
                    onClick={(event) => {
                      event.stopPropagation();
                      void openContextFile(n.path, settings);
                    }}
                  >
                    <I.file size={12} />
                  </button>
                  <button
                    type="button"
                    className="tree-action"
                    aria-label={t("fileActions.menu", { path: n.path })}
                    title={t("fileActions.menu", { path: n.path })}
                    onClick={(event) => {
                      event.stopPropagation();
                      openMenu(n.path, event.currentTarget);
                    }}
                  >
                    <I.more size={12} />
                  </button>
                </div>
              ),
            )
          )}
        </div>
      </div>
      {menu ? (
        <FileActionMenu
          anchor={{ left: menu.left, top: menu.top }}
          path={menu.path}
          workspaceDir={workspaceDir}
          editor={editor}
          onPreviewFile={onPreviewFile}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return t("fileActions.bytes", { count: bytes });
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i]!;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function FilePreviewPane({
  preview,
  loading,
  error,
  fallbackPath,
  workspaceDir,
  editor,
  onPreviewFile,
  full = false,
}: {
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
  fallbackPath?: string | null;
  workspaceDir?: string;
  editor?: string;
  onPreviewFile?: (target: FilePreviewTarget) => void;
  full?: boolean;
}) {
  const [menuAnchor, setMenuAnchor] = useState<{ left: number; top: number } | null>(null);
  const path = preview?.path ?? fallbackPath;
  if (!path && !loading && !error) return null;
  const meta = preview
    ? [
        formatBytes(preview.bytes),
        preview.truncated ? t("fileActions.truncated") : null,
        preview.ext ? `.${preview.ext}` : null,
      ].filter(Boolean)
    : [];
  return (
    <div className={`ctx-file-preview ${full ? "ctx-file-preview--full" : ""}`}>
      <div className="file-preview-head">
        <div className="file-preview-title">
          <span className="k">{t("fileActions.previewTitle")}</span>
          <span className="n">{preview?.name ?? path}</span>
        </div>
        {path ? (
          <button
            type="button"
            className="tree-action"
            aria-label={t("fileActions.menu", { path })}
            title={t("fileActions.menu", { path })}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenuAnchor({ left: rect.right - 4, top: rect.bottom + 4 });
            }}
          >
            <I.more size={12} />
          </button>
        ) : null}
      </div>
      {path ? <div className="file-preview-path">{path}</div> : null}
      {meta.length > 0 ? <div className="file-preview-meta">{meta.join(" · ")}</div> : null}
      <div className="file-preview-body">
        {loading ? (
          <div className="ctx-empty">{t("fileActions.previewLoading")}</div>
        ) : error ? (
          <div className="ctx-empty">{t("fileActions.previewError", { message: error })}</div>
        ) : preview?.text !== undefined && preview.text !== null ? (
          <pre className="file-preview-text">{preview.text}</pre>
        ) : (
          <div className="ctx-empty">
            <div>{t("fileActions.previewUnsupported")}</div>
            <div>{t("fileActions.previewOpenHint")}</div>
          </div>
        )}
      </div>
      {menuAnchor && path ? (
        <FileActionMenu
          anchor={menuAnchor}
          path={path}
          workspaceDir={workspaceDir}
          editor={editor}
          onPreviewFile={onPreviewFile}
          onClose={() => setMenuAnchor(null)}
        />
      ) : null}
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
    <div
      className="ctx-block"
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      <div className="h">
        <span>{t("contextPanel.memoryTitle")}</span>
        <span className="right">
          {entries.length === 0 ? "—" : t("contextPanel.itemCount", { count: entries.length })}
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="ctx-empty">{t("contextPanel.noMemoriesMsg")}</div>
      ) : (
        <div
          className="mem"
          style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
        >
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
                  {m.scope === "project"
                    ? t("contextPanel.scopeProject")
                    : t("contextPanel.scopeGlobal")}
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
