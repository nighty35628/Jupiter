import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { SessionInfo } from "../App";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import type { ExternalSessionApp, ExternalSessionSource } from "../protocol";
import { displayWorkspaceBasename, displayWorkspacePath } from "../workspace-display";

const RENAME_MAX_CHARS = 200;
const PIN_STORAGE_KEY = "jupiter.sidebar.pinnedSessions";
const SIDEBAR_CLOCK_INTERVAL_MS = 15_000;

type SortMode = "recent" | "workspace" | "title";
type WorkspaceGroupSort = "title" | "recent";

type WorkspaceGroup = {
  key: string;
  path?: string;
  label: string;
  detail: string;
  active: boolean;
  latest: number;
  sessions: SessionInfo[];
};

type PendingDelete = {
  name: string;
  pretty: string;
  x: number;
  y: number;
};

type PendingImport = {
  x: number;
  y: number;
};

type SidebarMenuPosition = {
  left: number;
  top: number;
};

type ImportSource = ExternalSessionSource;

function loadPinnedSessions(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PIN_STORAGE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function savePinnedSessions(items: string[]): void {
  localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(items));
}

function prettyName(s: SessionInfo): string {
  if (s.summary && s.summary.trim()) return s.summary.trim();
  const m = s.name.match(/^desktop-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(?:-(\d+))?$/);
  if (m) {
    const [, , month, day, hh, mm, tab] = m;
    return `${t("sidebarPanel.sessionTitle", {
      month,
      day,
      hour: hh,
      minute: mm,
    })}${tab && tab !== "1" ? ` · #${tab}` : ""}`;
  }
  return s.name.replace(/^desktop-/, "").replace(/[-_]+/g, " ");
}

function relative(ms: number): string {
  const min = ms / 60_000;
  if (min < 1) return t("sidebarPanel.justNow");
  if (min < 60) return t("sidebarPanel.minutesAgo", { n: Math.floor(min) });
  const hr = min / 60;
  if (hr < 24) return t("sidebarPanel.hoursAgo", { n: Math.floor(hr) });
  const d = hr / 24;
  if (d < 7) return t("sidebarPanel.daysAgo", { n: Math.floor(d) });
  return t("sidebarPanel.weeksAgo", { n: Math.floor(d / 7) });
}

function sessionWorkspacePath(session: SessionInfo): string | undefined {
  return session.workspace;
}

function sessionWorkspaceLabel(session: SessionInfo): string {
  const path = sessionWorkspacePath(session);
  return path ? displayWorkspaceBasename(path, t("sidebarPanel.unassignedWorkspace")) : t("sidebarPanel.unassignedWorkspace");
}

export function Sidebar({
  sessions,
  importSources,
  activeName,
  workspaceDir,
  recentWorkspaces,
  onNewChat,
  onLoadSession,
  onDeleteSession,
  onRenameSession,
  onRefreshImportSources,
  onImportDetectedSessions,
  onImportSession,
  onOpenSettings,
  onOpenRules,
  onOpenCommands,
  onOpenAbout,
}: {
  sessions: SessionInfo[];
  importSources: ExternalSessionApp[];
  activeName?: string;
  workspaceDir?: string;
  recentWorkspaces: string[];
  onNewChat: (workspaceDir?: string) => void;
  onLoadSession: (name: string) => void;
  onDeleteSession: (name: string) => void;
  onRenameSession: (name: string, title: string) => void;
  onRefreshImportSources: () => void;
  onImportDetectedSessions: (sources: ImportSource[]) => void;
  onImportSession: (payload: { source: ImportSource; path: string; name?: string }) => void;
  onOpenSettings: () => void;
  onOpenRules: () => void;
  onOpenCommands: () => void;
  onOpenAbout: () => void;
}) {
  useLang();
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [sidebarMenuOpen, setSidebarMenuOpen] = useState(false);
  const [organizeMenuOpen, setOrganizeMenuOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [sidebarMenuPos, setSidebarMenuPos] = useState<SidebarMenuPosition>({ left: 0, top: 0 });
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("workspace");
  const [workspaceGroupSort, setWorkspaceGroupSort] = useState<WorkspaceGroupSort>("title");
  const [pinned, setPinned] = useState<string[]>(() => loadPinnedSessions());
  const [now, setNow] = useState(() => Date.now());
  const newMenuRef = useRef<HTMLDivElement>(null);
  const sidebarMenuRef = useRef<HTMLDivElement>(null);
  const workspaceOptions = useMemo(() => {
    const values = [workspaceDir, ...recentWorkspaces].filter((p): p is string => Boolean(p));
    return Array.from(new Set(values));
  }, [recentWorkspaces, workspaceDir]);
  const matchingSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? sessions.filter((s) => {
          const title = prettyName(s).toLowerCase();
          const ws = sessionWorkspaceLabel(s).toLowerCase();
          return title.includes(q) || s.name.toLowerCase().includes(q) || ws.includes(q);
        })
      : sessions;
  }, [query, sessions, workspaceDir]);

  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const pinnedSessions = useMemo(() => {
    return matchingSessions
      .filter((s) => pinnedSet.has(s.name))
      .sort((a, b) => pinned.indexOf(a.name) - pinned.indexOf(b.name));
  }, [matchingSessions, pinned, pinnedSet]);
  const unpinnedSessions = useMemo(
    () => matchingSessions.filter((s) => !pinnedSet.has(s.name)),
    [matchingSessions, pinnedSet],
  );

  const filtered = useMemo(() => {
    const items = unpinnedSessions;
    return [...items].sort((a, b) => {
      if (sortMode === "title") return prettyName(a).localeCompare(prettyName(b));
      if (sortMode === "workspace") {
        const byWorkspace = sessionWorkspaceLabel(a)
          .localeCompare(sessionWorkspaceLabel(b));
        if (byWorkspace !== 0) return byWorkspace;
      }
      return Date.parse(b.mtime) - Date.parse(a.mtime);
    });
  }, [sortMode, unpinnedSessions, workspaceDir]);

  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, WorkspaceGroup>();
    for (const session of unpinnedSessions) {
      const path = sessionWorkspacePath(session);
      const key = path || "__unassigned__";
      const mtime = Date.parse(session.mtime);
      const latest = Number.isFinite(mtime) ? mtime : 0;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          path,
          label: sessionWorkspaceLabel(session),
          detail: path ? displayWorkspacePath(path, path) : t("sidebarPanel.unassignedWorkspaceDetail"),
          active: Boolean(path && workspaceDir && path === workspaceDir),
          latest,
          sessions: [],
        };
        groups.set(key, group);
      }
      group.latest = Math.max(group.latest, latest);
      group.sessions.push(session);
    }
    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        sessions: [...group.sessions].sort((a, b) => {
          return Date.parse(b.mtime) - Date.parse(a.mtime);
        }),
      }))
      .sort((a, b) => {
        if (workspaceGroupSort === "recent") {
          return b.latest - a.latest || a.label.localeCompare(b.label);
        }
        return a.label.localeCompare(b.label) || b.latest - a.latest;
      });
  }, [unpinnedSessions, workspaceDir, workspaceGroupSort]);

  const togglePin = (name: string) => {
    setPinned((prev) => {
      const next = prev.includes(name) ? prev.filter((x) => x !== name) : [name, ...prev];
      savePinnedSessions(next);
      return next;
    });
  };

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = window.setInterval(tick, SIDEBAR_CLOCK_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (!document.hidden) tick();
    };
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!pendingDelete && !pendingImport) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest(".session-delete-popover")) setPendingDelete(null);
      if (!target?.closest(".session-import-popover")) setPendingImport(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPendingDelete(null);
      if (e.key === "Escape") setPendingImport(null);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pendingDelete, pendingImport]);

  useEffect(() => {
    if (!newMenuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!newMenuRef.current?.contains(e.target as Node)) setNewMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNewMenuOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [newMenuOpen]);

  useEffect(() => {
    if (!sidebarMenuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!sidebarMenuRef.current?.contains(e.target as Node)) setSidebarMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarMenuOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [sidebarMenuOpen]);

  const openSidebarMenu = (anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const menuWidth = 172;
    const submenuWidth = 172;
    const left = Math.max(
      8,
      Math.min(rect.left - 104, window.innerWidth - menuWidth - submenuWidth - 14),
    );
    setSidebarMenuPos({
      left,
      top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 214)),
    });
    setSidebarMenuOpen((open) => {
      const next = !open;
      if (next) {
        setOrganizeMenuOpen(true);
        setSortMenuOpen(false);
      }
      return next;
    });
  };

  const chooseSortMode = (mode: SortMode) => {
    setSortMode(mode);
    setSidebarMenuOpen(false);
    setOrganizeMenuOpen(false);
    setSortMenuOpen(false);
  };

  const chooseWorkspaceSort = (mode: WorkspaceGroupSort) => {
    setSortMode("workspace");
    setWorkspaceGroupSort(mode);
    setSidebarMenuOpen(false);
    setOrganizeMenuOpen(false);
    setSortMenuOpen(false);
  };

  const renderSessionItem = (s: SessionInfo, grouped = false) => {
    const active = s.name === activeName;
    const pinnedSession = pinned.includes(s.name);
    const mtime = Date.parse(s.mtime);
    const updated = Number.isFinite(mtime) ? relative(now - mtime) : s.mtime;
    const editing = editingName === s.name;
    const currentSummary = s.summary?.trim() ?? "";
    const workspaceName = sessionWorkspaceLabel(s);
    const workspacePath = sessionWorkspacePath(s);
    const commitRename = () => {
      const next = editValue.trim().slice(0, RENAME_MAX_CHARS);
      if (next !== currentSummary) onRenameSession(s.name, next);
      setEditingName(null);
      setEditValue("");
    };
    return (
      <div
        key={s.name}
        className={grouped ? "session-item grouped" : "session-item"}
        data-active={active}
        data-editing={editing || undefined}
        onClick={
          editing
            ? undefined
            : () => {
                // Skip the round-trip when clicking the already-loaded
                // session — a reload would clear live in-turn state (#1653).
                if (s.name === activeName) return;
                onLoadSession(s.name);
              }
        }
        role={editing ? undefined : "button"}
        tabIndex={editing ? -1 : 0}
        title={`${prettyName(s)} · ${
          workspacePath ? displayWorkspacePath(workspacePath, workspaceName) : workspaceName
        }`}
        onKeyDown={(e) => {
          if (editing) return;
          if (e.key === "Enter" && s.name !== activeName) onLoadSession(s.name);
        }}
      >
        <div className="body">
          {editing ? (
            <input
              className="title-edit"
              autoFocus
              value={editValue}
              maxLength={RENAME_MAX_CHARS}
              placeholder={t("sidebarPanel.renamePlaceholder")}
              aria-label={t("sidebarPanel.renameSession")}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditingName(null);
                  setEditValue("");
                }
              }}
            />
          ) : (
            <span className="title">{prettyName(s)}</span>
          )}
          <span className="meta">
            <span className="time">{updated}</span>
          </span>
        </div>
        {editing ? null : (
          <>
            <button
              type="button"
              className="pin-btn"
              data-pinned={pinnedSession || undefined}
              title={pinnedSession ? t("sidebarPanel.unpinSession") : t("sidebarPanel.pinSession")}
              aria-label={pinnedSession ? t("sidebarPanel.unpinSession") : t("sidebarPanel.pinSession")}
              onClick={(e) => {
                e.stopPropagation();
                togglePin(s.name);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") e.stopPropagation();
              }}
            >
              <I.pin size={12} />
            </button>
            <button
              type="button"
              className="rename-btn"
              title={t("sidebarPanel.renameSession")}
              aria-label={t("sidebarPanel.renameSession")}
              onClick={(e) => {
                e.stopPropagation();
                setEditingName(s.name);
                setEditValue(currentSummary);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") e.stopPropagation();
              }}
            >
              <I.pencil size={12} />
            </button>
            <button
              type="button"
              className="delete-btn"
              title={t("sidebarPanel.deleteSession")}
              aria-label={t("sidebarPanel.deleteSession")}
              onClick={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                setPendingDelete({
                  name: s.name,
                  pretty: prettyName(s),
                  x: rect.right,
                  y: rect.bottom,
                });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") e.stopPropagation();
              }}
            >
              <I.x size={12} />
            </button>
          </>
        )}
      </div>
    );
  };

  const emptyState =
    sessions.length === 0 ? t("sidebarPanel.noSessions") : matchingSessions.length === 0 ? t("sidebarPanel.noMatches") : "";

  const renderEmptyState = () => (
    <div
      style={{
        padding: "12px 10px",
        fontSize: 11,
        color: "var(--muted-2)",
        fontFamily: "Geist Mono, monospace",
      }}
    >
      {emptyState}
    </div>
  );

  const renderWorkspaceGroups = () =>
    workspaceGroups.map((group) => (
      <div className="workspace-group" key={group.key}>
        <div className="workspace-group-head" data-active={group.active || undefined}>
          <span className="ico">
            <I.folder size={13} />
          </span>
          <span className="text">
            <span className="name">{group.label}</span>
          </span>
        </div>
        <div className="workspace-group-list">
          {group.sessions.map((s) => renderSessionItem(s, true))}
        </div>
      </div>
    ));

  const projectSection = (
    <section className="side-section codex-section codex-project-section" key="projects">
      <div className="codex-section-head">
        <span className="codex-section-title">{t("sidebarPanel.projects")}</span>
        <div className="sidebar-menu-anchor" ref={sidebarMenuRef}>
          <button
            type="button"
            className="sidebar-section-action"
            aria-label={t("sidebarPanel.sidebarOptions")}
            title={t("sidebarPanel.sidebarOptions")}
            data-open={sidebarMenuOpen || undefined}
            onClick={(e) => openSidebarMenu(e.currentTarget)}
          >
            <I.more size={15} />
          </button>
          {sidebarMenuOpen ? (
            <div className="sidebar-options-menu" role="menu" style={sidebarMenuPos}>
              <button type="button" className="sidebar-menu-row" disabled>
                <span className="menu-ico"><I.archive size={16} /></span>
                <span>{t("sidebarPanel.archiveAllChats")}</span>
              </button>
              <div className="sidebar-menu-divider" />
              <div
                className="sidebar-menu-row-wrap"
                onMouseEnter={() => {
                  setOrganizeMenuOpen(true);
                  setSortMenuOpen(false);
                }}
              >
                <button
                  type="button"
                  className="sidebar-menu-row"
                  data-active={organizeMenuOpen || undefined}
                  onClick={() => {
                    setOrganizeMenuOpen((v) => !v);
                    setSortMenuOpen(false);
                  }}
                >
                  <span className="menu-ico"><I.folder size={16} /></span>
                  <span>{t("sidebarPanel.organizeSidebar")}</span>
                  <span className="menu-grow" />
                  <I.chevR size={15} />
                </button>
                {organizeMenuOpen ? (
                  <div className="sidebar-submenu" role="menu">
                    <button
                      type="button"
                      className="sidebar-submenu-row"
                      data-active={(sortMode === "workspace" && workspaceGroupSort === "title") || undefined}
                      onClick={() => chooseWorkspaceSort("title")}
                    >
                      <span className="menu-ico"><I.folder size={16} /></span>
                      <span>{t("sidebarPanel.byProject")}</span>
                      <span className="menu-grow" />
                      {sortMode === "workspace" && workspaceGroupSort === "title" ? <I.check size={16} /> : null}
                    </button>
                    <button
                      type="button"
                      className="sidebar-submenu-row"
                      data-active={(sortMode === "workspace" && workspaceGroupSort === "recent") || undefined}
                      onClick={() => chooseWorkspaceSort("recent")}
                    >
                      <span className="menu-ico"><I.folder size={16} /></span>
                      <span>{t("sidebarPanel.recentProjects")}</span>
                      <span className="menu-grow" />
                      {sortMode === "workspace" && workspaceGroupSort === "recent" ? <I.check size={16} /> : null}
                    </button>
                    <button
                      type="button"
                      className="sidebar-submenu-row"
                      data-active={sortMode === "recent" || undefined}
                      onClick={() => chooseSortMode("recent")}
                    >
                      <span className="menu-ico"><I.history size={16} /></span>
                      <span>{t("sidebarPanel.chronological")}</span>
                      <span className="menu-grow" />
                      {sortMode === "recent" ? <I.check size={16} /> : null}
                    </button>
                  </div>
                ) : null}
              </div>
              <div
                className="sidebar-menu-row-wrap"
                onMouseEnter={() => {
                  setSortMenuOpen(true);
                  setOrganizeMenuOpen(false);
                }}
              >
                <button
                  type="button"
                  className="sidebar-menu-row"
                  data-active={sortMenuOpen || undefined}
                  onClick={() => {
                    setSortMenuOpen((v) => !v);
                    setOrganizeMenuOpen(false);
                  }}
                >
                  <span className="menu-ico"><I.history size={16} /></span>
                  <span>{t("sidebarPanel.sortCondition")}</span>
                  <span className="menu-grow" />
                  <I.chevR size={15} />
                </button>
                {sortMenuOpen ? (
                  <div className="sidebar-submenu" role="menu">
                    {(["workspace", "recent", "title"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className="sidebar-submenu-row"
                        data-active={sortMode === mode || undefined}
                        onClick={() => chooseSortMode(mode)}
                      >
                        <span className="menu-ico">
                          {mode === "workspace" ? <I.folder size={16} /> : mode === "recent" ? <I.history size={16} /> : <I.list size={16} />}
                        </span>
                        <span>{t(`sidebarPanel.sort${mode[0]!.toUpperCase()}${mode.slice(1)}` as any)}</span>
                        <span className="menu-grow" />
                        {sortMode === mode ? <I.check size={16} /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="sidebar-section-action"
          aria-label={t("sidebarPanel.browseWorkspace")}
          title={t("sidebarPanel.browseWorkspace")}
          onClick={async () => {
            const picked = await openFileDialog({ directory: true, multiple: false }).catch(() => null);
            if (typeof picked === "string") onNewChat(picked);
          }}
        >
          <I.plus size={15} />
        </button>
      </div>
      {sortMode === "workspace" ? renderWorkspaceGroups() : filtered.map((s) => renderSessionItem(s))}
    </section>
  );

  return (
    <aside className="sidebar">
      <div className="side-head">
        <div className="new-chat-wrap" ref={newMenuRef}>
          <button type="button" className="new-btn" onClick={() => setNewMenuOpen((v) => !v)}>
            <I.plus size={14} />
            <span>{t("sidebarPanel.newChat")}</span>
            <I.chev size={12} />
          </button>
          {newMenuOpen ? (
            <div className="new-chat-menu">
              {workspaceOptions.map((path) => (
                <button
                  type="button"
                  className="new-chat-option"
                  key={path}
                  onClick={() => {
                    onNewChat(path);
                    setNewMenuOpen(false);
                  }}
                  title={displayWorkspacePath(path, path)}
                >
                  <span className="ico"><I.folder size={12} /></span>
                  <span>
                    <span className="main">{displayWorkspaceBasename(path, path)}</span>
                    <span className="sub">{displayWorkspacePath(path, path)}</span>
                  </span>
                </button>
              ))}
              <button
                type="button"
                className="new-chat-option"
                onClick={async () => {
                  const picked = await openFileDialog({ directory: true, multiple: false }).catch(() => null);
                  if (typeof picked === "string") onNewChat(picked);
                  setNewMenuOpen(false);
                }}
              >
                <span className="ico"><I.plus size={12} /></span>
                <span>{t("sidebarPanel.browseWorkspace")}</span>
              </button>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="icon-btn"
          title={t("sidebarPanel.importSessions")}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onRefreshImportSources();
            setPendingImport({ x: rect.right, y: rect.bottom });
          }}
        >
          <I.upload size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={t("sidebarPanel.commandPalette")}
          onClick={onOpenCommands}
        >
          <I.history size={14} />
        </button>
      </div>

      <div className="search-row">
        <div className="input">
          <I.search size={13} />
          <input
            placeholder={t("sidebarPanel.searchSessions")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="session-list codex-sidebar-list">
        {emptyState ? (
          renderEmptyState()
        ) : (
          <>
            <section className="side-section codex-section">
              <div className="codex-section-head">
                <span className="codex-section-title">{t("sidebarPanel.pinned")}</span>
              </div>
              {pinnedSessions.map((s) => renderSessionItem(s))}
            </section>
            {projectSection}
          </>
        )}
      </div>

      <div className="side-foot">
        <div className="row" onClick={onOpenRules}>
          <span className="ico">
            <I.shield size={13} />
          </span>
          <span>{t("sidebarPanel.approvalRules")}</span>
        </div>
        <div className="row" onClick={onOpenAbout}>
          <span className="ico">
            <I.help size={13} />
          </span>
          <span>{t("about.sidebarLabel")}</span>
        </div>
        <div className="row" onClick={onOpenSettings}>
          <span className="ico">
            <I.cog size={13} />
          </span>
          <span>{t("sidebarPanel.settings")}</span>
        </div>
      </div>

      {pendingDelete ? (
        <SessionDeletePopover
          target={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            onDeleteSession(pendingDelete.name);
            setPendingDelete(null);
          }}
        />
      ) : null}
      {pendingImport ? (
        <SessionImportPopover
          target={pendingImport}
          importSources={importSources}
          onRefresh={onRefreshImportSources}
          onCancel={() => setPendingImport(null)}
          onImportDetected={(sources) => {
            onImportDetectedSessions(sources);
            setPendingImport(null);
          }}
          onImport={(payload) => {
            onImportSession(payload);
            setPendingImport(null);
          }}
        />
      ) : null}
    </aside>
  );
}

function SessionDeletePopover({
  target,
  onCancel,
  onConfirm,
}: {
  target: PendingDelete;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: target.x,
    top: target.y,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = target.x;
    let top = target.y;
    if (left + rect.width + pad > vw) left = Math.max(pad, vw - rect.width - pad);
    if (top + rect.height + pad > vh) top = Math.max(pad, vh - rect.height - pad);
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
    cancelRef.current?.focus();
  }, [target.x, target.y, pos.left, pos.top]);

  return (
    <div
      ref={ref}
      className="session-delete-popover"
      role="dialog"
      aria-modal="true"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="msg">
        {t("sidebarPanel.deleteSession")}
        <span className="name">{target.pretty}</span>
      </div>
      <div className="actions">
        <button ref={cancelRef} type="button" className="cancel" onClick={onCancel}>
          {t("sidebarPanel.cancel")}
        </button>
        <button type="button" className="confirm" onClick={onConfirm}>
          <I.x size={11} />
          {t("sidebarPanel.delete")}
        </button>
      </div>
    </div>
  );
}

function SessionImportPopover({
  target,
  importSources,
  onRefresh,
  onCancel,
  onImportDetected,
  onImport,
}: {
  target: PendingImport;
  importSources: ExternalSessionApp[];
  onRefresh: () => void;
  onCancel: () => void;
  onImportDetected: (sources: ImportSource[]) => void;
  onImport: (payload: { source: ImportSource; path: string; name?: string }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: target.x,
    top: target.y,
  });
  const [mode, setMode] = useState<"detected" | "custom">("detected");
  const [selected, setSelected] = useState<ImportSource[]>([]);
  const [source, setSource] = useState<ImportSource>("claude");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    const available = importSources.filter((app) => app.available).map((app) => app.source);
    setSelected((prev) => {
      const kept = prev.filter((source) => available.includes(source));
      return kept.length > 0 ? kept : available;
    });
  }, [importSources]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = target.x;
    let top = target.y;
    if (left + rect.width + pad > vw) left = Math.max(pad, vw - rect.width - pad);
    if (top + rect.height + pad > vh) top = Math.max(pad, vh - rect.height - pad);
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
    if (mode === "custom") firstInputRef.current?.focus();
  }, [target.x, target.y, pos.left, pos.top, mode]);

  const browse = async () => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "JSONL", extensions: ["jsonl", "json"] }],
      });
      if (typeof picked === "string" && picked) setPath(picked);
    } catch (err) {
      console.error("session import browse failed", err);
    }
  };

  const submit = () => {
    const trimmedPath = path.trim();
    const trimmedName = name.trim();
    if (!trimmedPath) return;
    onImport({
      source,
      path: trimmedPath,
      name: trimmedName || undefined,
    });
  };

  const submitDetected = () => {
    if (selected.length === 0) return;
    onImportDetected(selected);
  };

  const toggleSource = (source: ImportSource) => {
    setSelected((prev) =>
      prev.includes(source) ? prev.filter((item) => item !== source) : [...prev, source],
    );
  };

  return (
    <div
      ref={ref}
      className="session-import-popover"
      role="dialog"
      aria-modal="true"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="head">
        <span>{t("sidebarPanel.importSessions")}</span>
        <button type="button" className="close" onClick={onCancel} aria-label={t("sidebarPanel.cancel")}>
          <I.x size={12} />
        </button>
      </div>
      <div className="import-tabs">
        <button type="button" data-on={mode === "detected"} onClick={() => setMode("detected")}>
          {t("sidebarPanel.importDetected")}
        </button>
        <button type="button" data-on={mode === "custom"} onClick={() => setMode("custom")}>
          {t("sidebarPanel.importCustom")}
        </button>
      </div>
      {mode === "detected" ? (
        <>
          <div className="import-detected-head">
            <span>{t("sidebarPanel.importFoundApps")}</span>
            <button type="button" onClick={onRefresh} title={t("sidebarPanel.refresh")}>
              <I.refresh size={12} />
            </button>
          </div>
          <div className="import-app-list">
            {importSources.length === 0 ? (
              <div className="import-empty">{t("sidebarPanel.importScanning")}</div>
            ) : null}
            {importSources.map((app) => {
              const checked = selected.includes(app.source);
              return (
                <button
                  key={app.source}
                  type="button"
                  className="import-app-row"
                  data-disabled={!app.available || undefined}
                  onClick={() => {
                    if (app.available) toggleSource(app.source);
                  }}
                >
                  <span className="app-icon">
                    {app.source === "claude" ? <I.terminal size={15} /> : <I.bot size={15} />}
                  </span>
                  <span className="app-body">
                    <span className="app-name">{app.label}</span>
                    <span className="app-meta">
                      {app.available
                        ? t("sidebarPanel.importSessionCount", {
                            count: app.sessionCount,
                          })
                        : t("sidebarPanel.importNotFound")}
                    </span>
                  </span>
                  <span className="switch" data-on={checked && app.available ? true : undefined} />
                </button>
              );
            })}
          </div>
          <div className="hint">{t("sidebarPanel.importPrivacyHint")}</div>
          <div className="actions">
            <button type="button" className="cancel" onClick={onCancel}>
              {t("sidebarPanel.cancel")}
            </button>
            <button
              type="button"
              className="confirm"
              disabled={selected.length === 0}
              onClick={submitDetected}
            >
              {t("sidebarPanel.continue")}
            </button>
          </div>
        </>
      ) : (
        <>
      <div className="field">
        <span className="label">{t("sidebarPanel.importSource")}</span>
        <div className="seg">
          <button type="button" data-on={source === "claude"} onClick={() => setSource("claude")}>
            {t("sidebarPanel.importFromClaude")}
          </button>
          <button type="button" data-on={source === "codex"} onClick={() => setSource("codex")}>
            {t("sidebarPanel.importFromCodex")}
          </button>
        </div>
      </div>
      <div className="field">
        <span className="label">{t("sidebarPanel.importPath")}</span>
        <div className="path-row">
          <input
            ref={firstInputRef}
            value={path}
            placeholder={t("sidebarPanel.importPath")}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && path.trim()) submit();
            }}
          />
          <button type="button" onClick={() => void browse()}>
            {t("sidebarPanel.browse")}
          </button>
        </div>
      </div>
      <div className="field">
        <span className="label">{t("sidebarPanel.importName")}</span>
        <input
          value={name}
          placeholder={t("sidebarPanel.importNamePlaceholder")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && path.trim()) submit();
          }}
        />
      </div>
      <div className="actions">
        <button type="button" className="cancel" onClick={onCancel}>
          {t("sidebarPanel.cancel")}
        </button>
        <button type="button" className="confirm" disabled={!path.trim()} onClick={submit}>
          <I.upload size={11} />
          {t("sidebarPanel.importConfirm")}
        </button>
      </div>
        </>
      )}
    </div>
  );
}
