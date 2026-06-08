import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "../App";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import type { ExternalSessionApp, ExternalSessionSource } from "../protocol";
import { displayWorkspaceBasename, displayWorkspacePath } from "../workspace-display";

const RENAME_MAX_CHARS = 200;
const WORKSPACE_PIN_STORAGE_KEY = "jupiter.sidebar.pinnedWorkspaces";
const COLLAPSED_WORKSPACES_STORAGE_KEY = "jupiter.sidebar.collapsedWorkspaces";
const WORKSPACE_ALIAS_STORAGE_KEY = "jupiter.sidebar.workspaceAliases";
const REMOVED_WORKSPACES_STORAGE_KEY = "jupiter.sidebar.removedWorkspaces";
const SIDEBAR_CLOCK_INTERVAL_MS = 15_000;
const UNASSIGNED_WORKSPACE_KEY = "__unassigned__";

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

type SessionActivity = Record<string, { busy?: boolean }>;
type SessionMetaPatch = {
  pinnedAt?: number | null;
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

type SessionMenuTarget = {
  session: SessionInfo;
  x: number;
  y: number;
};

type WorkspaceMenuTarget = {
  group: WorkspaceGroup;
  x: number;
  y: number;
};

type PendingWorkspaceRename = {
  key: string;
  label: string;
  x: number;
  y: number;
};

type SidebarMenuPosition = {
  left: number;
  top: number;
};

type ImportSource = ExternalSessionSource;

function loadPinnedWorkspaces(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem?.(WORKSPACE_PIN_STORAGE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function savePinnedWorkspaces(items: string[]): void {
  try {
    localStorage.setItem?.(WORKSPACE_PIN_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Sidebar preferences are best-effort; interaction state still updates.
  }
}

function loadCollapsedWorkspaces(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem?.(COLLAPSED_WORKSPACES_STORAGE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveCollapsedWorkspaces(items: string[]): void {
  try {
    localStorage.setItem?.(COLLAPSED_WORKSPACES_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Sidebar preferences are best-effort; interaction state still updates.
  }
}

function loadWorkspaceAliases(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem?.(WORKSPACE_ALIAS_STORAGE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function saveWorkspaceAliases(items: Record<string, string>): void {
  try {
    localStorage.setItem?.(WORKSPACE_ALIAS_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Sidebar preferences are best-effort.
  }
}

function loadRemovedWorkspaces(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem?.(REMOVED_WORKSPACES_STORAGE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveRemovedWorkspaces(items: string[]): void {
  try {
    localStorage.setItem?.(REMOVED_WORKSPACES_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Sidebar preferences are best-effort.
  }
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

export function Sidebar({
  sessions,
  sessionActivity = {},
  importSources,
  activeName,
  workspaceDir,
  recentWorkspaces,
  onNewChat,
  onLoadSession,
  onDeleteSession,
  onRenameSession,
  onPatchSessionMeta = () => {},
  onArchiveSession = () => {},
  onArchiveSessions = () => {},
  onRefreshImportSources,
  onImportDetectedSessions,
  onImportSession,
  onOpenSettings,
  onOpenSettingsPage = () => {},
  onOpenCommands,
  onRemoveWorkspace = () => {},
}: {
  sessions: SessionInfo[];
  sessionActivity?: SessionActivity;
  importSources: ExternalSessionApp[];
  activeName?: string;
  workspaceDir?: string;
  recentWorkspaces: string[];
  onNewChat: (workspaceDir?: string) => void;
  onLoadSession: (name: string) => void;
  onDeleteSession: (name: string) => void;
  onRenameSession: (name: string, title: string) => void;
  onPatchSessionMeta?: (name: string, patch: SessionMetaPatch) => void;
  onArchiveSession?: (name: string) => void;
  onArchiveSessions?: (names: string[]) => void;
  onRefreshImportSources: () => void;
  onImportDetectedSessions: (sources: ImportSource[]) => void;
  onImportSession: (payload: { source: ImportSource; path: string; name?: string }) => void;
  onOpenSettings: () => void;
  onOpenSettingsPage?: (page: "archives") => void;
  onOpenCommands: () => void;
  onRemoveWorkspace?: (workspace: string) => void;
}) {
  useLang();
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [sessionMenu, setSessionMenu] = useState<SessionMenuTarget | null>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState<WorkspaceMenuTarget | null>(null);
  const [pendingWorkspaceRename, setPendingWorkspaceRename] =
    useState<PendingWorkspaceRename | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [sidebarMenuOpen, setSidebarMenuOpen] = useState(false);
  const [sortModeMenuOpen, setSortModeMenuOpen] = useState(false);
  const [workspaceSortMenuOpen, setWorkspaceSortMenuOpen] = useState(false);
  const [sidebarMenuPos, setSidebarMenuPos] = useState<SidebarMenuPosition>({ left: 0, top: 0 });
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("workspace");
  const [workspaceGroupSort, setWorkspaceGroupSort] = useState<WorkspaceGroupSort>("title");
  const [pinnedWorkspaces, setPinnedWorkspaces] = useState<string[]>(() => loadPinnedWorkspaces());
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<string[]>(() =>
    loadCollapsedWorkspaces(),
  );
  const [workspaceAliases, setWorkspaceAliases] = useState<Record<string, string>>(() =>
    loadWorkspaceAliases(),
  );
  const [removedWorkspaces, setRemovedWorkspaces] = useState<string[]>(() =>
    loadRemovedWorkspaces(),
  );
  const [optimisticSessionPins, setOptimisticSessionPins] = useState<Record<string, number | null>>(
    {},
  );
  const [now, setNow] = useState(() => Date.now());
  const newMenuRef = useRef<HTMLDivElement>(null);
  const sidebarMenuRef = useRef<HTMLDivElement>(null);
  const removedWorkspaceSet = useMemo(() => new Set(removedWorkspaces), [removedWorkspaces]);
  const workspaceOptions = useMemo(() => {
    const values = [workspaceDir, ...recentWorkspaces].filter((p): p is string => Boolean(p));
    return Array.from(new Set(values)).filter((p) => p === workspaceDir || !removedWorkspaceSet.has(p));
  }, [recentWorkspaces, removedWorkspaceSet, workspaceDir]);
  const busySessionSet = useMemo(() => {
    const names = Object.entries(sessionActivity)
      .filter(([, activity]) => Boolean(activity.busy))
      .map(([name]) => name);
    return new Set(names);
  }, [sessionActivity]);
  const effectiveSessions = useMemo(
    () =>
      sessions.map((session) => {
        if (!(session.name in optimisticSessionPins)) return session;
        const pinnedAt = optimisticSessionPins[session.name];
        return pinnedAt === null ? { ...session, pinnedAt: undefined } : { ...session, pinnedAt };
      }),
    [optimisticSessionPins, sessions],
  );
  const visibleSessions = useMemo(
    () =>
      effectiveSessions.filter((s) => {
        if (s.archivedAt) return false;
        const path = sessionWorkspacePath(s);
        return !path || path === workspaceDir || !removedWorkspaceSet.has(path);
      }),
    [effectiveSessions, removedWorkspaceSet, workspaceDir],
  );
  const workspaceLabelForPath = (path: string | undefined, fallback: string): string => {
    if (!path) return fallback;
    const alias = workspaceAliases[path]?.trim();
    return alias || displayWorkspaceBasename(path, fallback);
  };
  const sessionLabel = (session: SessionInfo): string => {
    const path = sessionWorkspacePath(session);
    return workspaceLabelForPath(path, t("sidebarPanel.unassignedWorkspace"));
  };
  const matchingSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? visibleSessions.filter((s) => {
          const title = prettyName(s).toLowerCase();
          const ws = sessionLabel(s).toLowerCase();
          return title.includes(q) || s.name.toLowerCase().includes(q) || ws.includes(q);
        })
      : visibleSessions;
  }, [query, visibleSessions, workspaceAliases]);

  const collapsedWorkspaceSet = useMemo(() => new Set(collapsedWorkspaces), [collapsedWorkspaces]);
  const pinnedWorkspaceSet = useMemo(() => new Set(pinnedWorkspaces), [pinnedWorkspaces]);

  const filtered = useMemo(() => {
    const items = matchingSessions;
    return [...items].sort((a, b) => {
      if (sortMode === "title") return prettyName(a).localeCompare(prettyName(b));
      if (sortMode === "workspace") {
        const byWorkspace = sessionLabel(a).localeCompare(sessionLabel(b));
        if (byWorkspace !== 0) return byWorkspace;
      }
      return Date.parse(b.mtime) - Date.parse(a.mtime);
    });
  }, [sortMode, matchingSessions, workspaceAliases]);

  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, WorkspaceGroup>();
    for (const session of matchingSessions) {
      const path = sessionWorkspacePath(session);
      const key = path || UNASSIGNED_WORKSPACE_KEY;
      const mtime = Date.parse(session.mtime);
      const latest = Number.isFinite(mtime) ? mtime : 0;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          path,
          label: sessionLabel(session),
          detail: path
            ? displayWorkspacePath(path, path)
            : t("sidebarPanel.unassignedWorkspaceDetail"),
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
          const aPinned = a.pinnedAt ?? 0;
          const bPinned = b.pinnedAt ?? 0;
          if (aPinned > 0 || bPinned > 0) {
            if (aPinned > 0 && bPinned > 0) return bPinned - aPinned;
            return aPinned > 0 ? -1 : 1;
          }
          return Date.parse(b.mtime) - Date.parse(a.mtime);
        }),
      }))
      .sort((a, b) => {
        const aPinned = pinnedWorkspaces.indexOf(a.key);
        const bPinned = pinnedWorkspaces.indexOf(b.key);
        if (aPinned >= 0 || bPinned >= 0) {
          if (aPinned >= 0 && bPinned >= 0) return aPinned - bPinned;
          return aPinned >= 0 ? -1 : 1;
        }
        if (workspaceGroupSort === "recent") {
          return b.latest - a.latest || a.label.localeCompare(b.label);
        }
        return a.label.localeCompare(b.label) || b.latest - a.latest;
      });
  }, [matchingSessions, pinnedWorkspaces, workspaceAliases, workspaceDir, workspaceGroupSort]);

  const toggleSessionPin = (session: SessionInfo) => {
    const pinnedAt = session.pinnedAt ? null : Date.now();
    setOptimisticSessionPins((prev) => ({
      ...prev,
      [session.name]: pinnedAt,
    }));
    onPatchSessionMeta(session.name, {
      pinnedAt,
    });
  };

  const toggleWorkspacePin = (key: string) => {
    setPinnedWorkspaces((prev) => {
      const next = prev.includes(key) ? prev.filter((x) => x !== key) : [key, ...prev];
      savePinnedWorkspaces(next);
      return next;
    });
  };

  const toggleWorkspaceCollapsed = (key: string) => {
    setCollapsedWorkspaces((prev) => {
      const next = prev.includes(key) ? prev.filter((x) => x !== key) : [key, ...prev];
      saveCollapsedWorkspaces(next);
      return next;
    });
  };

  const archiveSession = (session: SessionInfo) => {
    onArchiveSession(session.name);
  };

  const archiveWorkspaceSessions = (group: WorkspaceGroup) => {
    onArchiveSessions(group.sessions.map((session) => session.name));
  };

  const renameWorkspace = (key: string, value: string) => {
    const nextValue = value.trim().slice(0, RENAME_MAX_CHARS);
    setWorkspaceAliases((prev) => {
      const next = { ...prev };
      if (nextValue) next[key] = nextValue;
      else delete next[key];
      saveWorkspaceAliases(next);
      return next;
    });
  };

  const removeWorkspace = (path: string) => {
    setRemovedWorkspaces((prev) => {
      const next = prev.includes(path) ? prev : [path, ...prev];
      saveRemovedWorkspaces(next);
      return next;
    });
    onRemoveWorkspace(path);
  };

  const copyText = (text?: string) => {
    const value = text?.trim();
    if (!value) return;
    void navigator.clipboard?.writeText(value).catch((err) => {
      console.error("copy session metadata failed", err);
    });
  };

  const revealSessionFile = (session: SessionInfo) => {
    if (!session.path) return;
    void Promise.resolve(revealItemInDir(session.path)).catch((err) => {
      console.error("reveal session failed", err);
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
    if (!pendingDelete && !pendingImport && !sessionMenu && !workspaceMenu && !pendingWorkspaceRename) {
      return;
    }
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest(".session-delete-popover")) setPendingDelete(null);
      if (!target?.closest(".session-import-popover")) setPendingImport(null);
      if (!target?.closest(".session-menu")) setSessionMenu(null);
      if (!target?.closest(".workspace-menu")) setWorkspaceMenu(null);
      if (!target?.closest(".workspace-rename-popover")) setPendingWorkspaceRename(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPendingDelete(null);
      if (e.key === "Escape") setPendingImport(null);
      if (e.key === "Escape") setSessionMenu(null);
      if (e.key === "Escape") setWorkspaceMenu(null);
      if (e.key === "Escape") setPendingWorkspaceRename(null);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pendingDelete, pendingImport, pendingWorkspaceRename, sessionMenu, workspaceMenu]);

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
        setSortModeMenuOpen(false);
        setWorkspaceSortMenuOpen(false);
      }
      return next;
    });
  };

  const chooseSortMode = (mode: SortMode) => {
    setSortMode(mode);
    setSidebarMenuOpen(false);
    setSortModeMenuOpen(false);
    setWorkspaceSortMenuOpen(false);
  };

  const chooseWorkspaceSort = (mode: WorkspaceGroupSort) => {
    setSortMode("workspace");
    setWorkspaceGroupSort(mode);
    setSidebarMenuOpen(false);
    setSortModeMenuOpen(false);
    setWorkspaceSortMenuOpen(false);
  };

  const openWorkspaceMenu = (group: WorkspaceGroup, x: number, y: number) => {
    setWorkspaceMenu({ group, x, y });
  };

  const renderSessionItem = (s: SessionInfo, grouped = false) => {
    const active = s.name === activeName;
    const pinnedSession = Boolean(s.pinnedAt);
    const busySession = busySessionSet.has(s.name);
    const mtime = Date.parse(s.mtime);
    const updated = Number.isFinite(mtime) ? relative(now - mtime) : s.mtime;
    const editing = editingName === s.name;
    const currentSummary = s.summary?.trim() ?? "";
    const workspaceName = sessionLabel(s);
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
        data-busy={busySession || undefined}
        data-editing={editing || undefined}
        data-has-state={busySession || undefined}
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
          if (e.key === "Enter" && s.name !== activeName) {
            onLoadSession(s.name);
          }
          if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            setSessionMenu({ session: s, x: rect.left + 16, y: rect.top + 16 });
          }
        }}
        onContextMenu={(e) => {
          if (editing) return;
          e.preventDefault();
          e.stopPropagation();
          setSessionMenu({ session: s, x: e.clientX, y: e.clientY });
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
        {editing || !busySession ? null : (
          <span className="session-state" aria-hidden="true">
            <span className="session-busy-spinner" />
          </span>
        )}
        {editing ? null : (
          <>
            <button
              type="button"
              className="pin-btn"
              data-pinned={pinnedSession || undefined}
              title={pinnedSession ? t("sidebarPanel.unpinSession") : t("sidebarPanel.pinSession")}
              aria-label={
                pinnedSession ? t("sidebarPanel.unpinSession") : t("sidebarPanel.pinSession")
              }
              onClick={(e) => {
                e.stopPropagation();
                toggleSessionPin(s);
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
    visibleSessions.length === 0
      ? t("sidebarPanel.noSessions")
      : matchingSessions.length === 0
        ? t("sidebarPanel.noMatches")
        : "";

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
    workspaceGroups.map((group) => {
      const collapsed = query.trim().length === 0 && collapsedWorkspaceSet.has(group.key);
      const workspacePinned = pinnedWorkspaceSet.has(group.key);
      return (
        <div className="workspace-group" key={group.key} data-collapsed={collapsed || undefined}>
          <div className="workspace-group-row">
            <button
              type="button"
              className="workspace-group-head"
              data-active={group.active || undefined}
              data-collapsed={collapsed || undefined}
              aria-expanded={!collapsed}
              title={group.detail}
              onClick={() => toggleWorkspaceCollapsed(group.key)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openWorkspaceMenu(group, e.clientX, e.clientY);
              }}
            >
              <span className="ico">
                <I.folder size={13} />
              </span>
              <span className="text">
                <span className="name">{group.label}</span>
              </span>
            </button>
            <button
              type="button"
              className="workspace-menu-btn"
              data-pinned={workspacePinned || undefined}
              title={t("sidebarPanel.workspaceActions")}
              aria-label={t("sidebarPanel.workspaceActions")}
              onClick={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                openWorkspaceMenu(group, rect.left, rect.bottom);
              }}
            >
              <I.more size={13} />
            </button>
          </div>
          {collapsed ? null : (
            <div className="workspace-group-list">
              {group.sessions.map((s) => renderSessionItem(s, true))}
            </div>
          )}
        </div>
      );
    });

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
              <div
                className="sidebar-menu-row-wrap"
                onMouseEnter={() => {
                  setSortModeMenuOpen(true);
                  setWorkspaceSortMenuOpen(false);
                }}
              >
                <button
                  type="button"
                  className="sidebar-menu-row"
                  data-active={sortModeMenuOpen || undefined}
                  onClick={() => {
                    setSortModeMenuOpen((v) => !v);
                    setWorkspaceSortMenuOpen(false);
                  }}
                >
                  <span className="menu-ico">
                    <I.list size={16} />
                  </span>
                  <span>{t("sidebarPanel.sortMode")}</span>
                  <span className="menu-grow" />
                  <I.chevR size={15} />
                </button>
                {sortModeMenuOpen ? (
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
                          {mode === "workspace" ? (
                            <I.folder size={16} />
                          ) : mode === "recent" ? (
                            <I.history size={16} />
                          ) : (
                            <I.list size={16} />
                          )}
                        </span>
                        <span>
                          {t(`sidebarPanel.sortBy${mode[0]!.toUpperCase()}${mode.slice(1)}` as any)}
                        </span>
                        <span className="menu-grow" />
                        {sortMode === mode ? <I.check size={16} /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div
                className="sidebar-menu-row-wrap"
                onMouseEnter={() => {
                  if (sortMode !== "workspace") return;
                  setWorkspaceSortMenuOpen(true);
                  setSortModeMenuOpen(false);
                }}
              >
                <button
                  type="button"
                  className="sidebar-menu-row"
                  data-active={workspaceSortMenuOpen || undefined}
                  disabled={sortMode !== "workspace"}
                  onClick={() => {
                    if (sortMode !== "workspace") return;
                    setWorkspaceSortMenuOpen((v) => !v);
                    setSortModeMenuOpen(false);
                  }}
                >
                  <span className="menu-ico">
                    <I.folder size={16} />
                  </span>
                  <span>{t("sidebarPanel.workspaceOrder")}</span>
                  <span className="menu-grow" />
                  <I.chevR size={15} />
                </button>
                {workspaceSortMenuOpen && sortMode === "workspace" ? (
                  <div className="sidebar-submenu" role="menu">
                    {(["title", "recent"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className="sidebar-submenu-row"
                        data-active={workspaceGroupSort === mode || undefined}
                        onClick={() => chooseWorkspaceSort(mode)}
                      >
                        <span className="menu-ico">
                          {mode === "recent" ? <I.history size={16} /> : <I.list size={16} />}
                        </span>
                        <span>
                          {t(
                            `sidebarPanel.workspaceOrder${mode[0]!.toUpperCase()}${mode.slice(1)}` as any,
                          )}
                        </span>
                        <span className="menu-grow" />
                        {workspaceGroupSort === mode ? <I.check size={16} /> : null}
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
            const picked = await openFileDialog({ directory: true, multiple: false }).catch(
              () => null,
            );
            if (typeof picked === "string") onNewChat(picked);
          }}
        >
          <I.plus size={15} />
        </button>
      </div>
      {emptyState
        ? renderEmptyState()
        : sortMode === "workspace"
          ? renderWorkspaceGroups()
          : filtered.map((s) => renderSessionItem(s))}
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
                  <span className="ico">
                    <I.folder size={12} />
                  </span>
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
                  const picked = await openFileDialog({ directory: true, multiple: false }).catch(
                    () => null,
                  );
                  if (typeof picked === "string") onNewChat(picked);
                  setNewMenuOpen(false);
                }}
              >
                <span className="ico">
                  <I.plus size={12} />
                </span>
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
        {sessions.length === 0 ? renderEmptyState() : projectSection}
      </div>

      <div className="side-foot">
        <button type="button" className="row" onClick={onOpenSettings}>
          <span className="ico">
            <I.cog size={13} />
          </span>
          <span>{t("sidebarPanel.settings")}</span>
        </button>
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
      {sessionMenu ? (
        <SessionContextMenu
          target={sessionMenu}
          pinned={Boolean(sessionMenu.session.pinnedAt)}
          onArchive={() => {
            archiveSession(sessionMenu.session);
            setSessionMenu(null);
          }}
          onCopySessionId={() => {
            copyText(sessionMenu.session.name);
            setSessionMenu(null);
          }}
          onCopyWorkspacePath={() => {
            copyText(sessionWorkspacePath(sessionMenu.session));
            setSessionMenu(null);
          }}
          onDelete={() => {
            setPendingDelete({
              name: sessionMenu.session.name,
              pretty: prettyName(sessionMenu.session),
              x: sessionMenu.x,
              y: sessionMenu.y,
            });
            setSessionMenu(null);
          }}
          onRename={() => {
            const summary = sessionMenu.session.summary?.trim() ?? "";
            setEditingName(sessionMenu.session.name);
            setEditValue(summary);
            setSessionMenu(null);
          }}
          onReveal={() => {
            revealSessionFile(sessionMenu.session);
            setSessionMenu(null);
          }}
          onTogglePin={() => {
            toggleSessionPin(sessionMenu.session);
            setSessionMenu(null);
          }}
        />
      ) : null}
      {workspaceMenu ? (
        <WorkspaceContextMenu
          target={workspaceMenu}
          pinned={pinnedWorkspaceSet.has(workspaceMenu.group.key)}
          onArchive={() => {
            archiveWorkspaceSessions(workspaceMenu.group);
            setWorkspaceMenu(null);
          }}
          onCopyWorkspacePath={() => {
            copyText(workspaceMenu.group.path);
            setWorkspaceMenu(null);
          }}
          onOpenArchived={() => {
            onOpenSettingsPage("archives");
            setWorkspaceMenu(null);
          }}
          onOpenInFolder={() => {
            if (workspaceMenu.group.path) {
              void Promise.resolve(revealItemInDir(workspaceMenu.group.path)).catch((err) => {
                console.error("reveal workspace failed", err);
              });
            }
            setWorkspaceMenu(null);
          }}
          onRemove={() => {
            if (workspaceMenu.group.path) removeWorkspace(workspaceMenu.group.path);
            setWorkspaceMenu(null);
          }}
          onRename={() => {
            setPendingWorkspaceRename({
              key: workspaceMenu.group.key,
              label: workspaceAliases[workspaceMenu.group.key] ?? workspaceMenu.group.label,
              x: workspaceMenu.x,
              y: workspaceMenu.y,
            });
            setWorkspaceMenu(null);
          }}
          onTogglePin={() => {
            toggleWorkspacePin(workspaceMenu.group.key);
            setWorkspaceMenu(null);
          }}
        />
      ) : null}
      {pendingWorkspaceRename ? (
        <WorkspaceRenamePopover
          target={pendingWorkspaceRename}
          onCancel={() => setPendingWorkspaceRename(null)}
          onConfirm={(value) => {
            renameWorkspace(pendingWorkspaceRename.key, value);
            setPendingWorkspaceRename(null);
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

function positionFloatingPanel(
  target: { x: number; y: number },
  size: { width: number; height: number },
) {
  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    left: target.x + size.width + pad > vw ? Math.max(pad, vw - size.width - pad) : target.x,
    top: target.y + size.height + pad > vh ? Math.max(pad, vh - size.height - pad) : target.y,
  };
}

function SessionContextMenu({
  target,
  pinned,
  onArchive,
  onCopySessionId,
  onCopyWorkspacePath,
  onDelete,
  onRename,
  onReveal,
  onTogglePin,
}: {
  target: SessionMenuTarget;
  pinned: boolean;
  onArchive: () => void;
  onCopySessionId: () => void;
  onCopyWorkspacePath: () => void;
  onDelete: () => void;
  onRename: () => void;
  onReveal: () => void;
  onTogglePin: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: target.x,
    top: target.y,
  });
  const workspacePath = sessionWorkspacePath(target.session);

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const next = positionFloatingPanel(target, {
      width: rect.width,
      height: rect.height,
    });
    if (next.left !== pos.left || next.top !== pos.top) setPos(next);
  }, [target, pos.left, pos.top]);

  const item = (
    icon: ReactNode,
    label: string,
    onClick: () => void,
    options: { disabled?: boolean; danger?: boolean } = {},
  ) => (
    <button
      type="button"
      role="menuitem"
      disabled={options.disabled}
      data-danger={options.danger || undefined}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div
      ref={ref}
      className="session-menu"
      role="menu"
      aria-label={t("sidebarPanel.sessionActions")}
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="session-menu-title">{prettyName(target.session)}</div>
      {item(
        <I.pin size={13} />,
        pinned ? t("sidebarPanel.unpinConversation") : t("sidebarPanel.pinConversation"),
        onTogglePin,
      )}
      {item(<I.pencil size={13} />, t("sidebarPanel.renameConversation"), onRename)}
      {item(
        <I.archive size={13} />,
        t("sidebarPanel.archiveConversation"),
        onArchive,
      )}
      <div className="session-menu-divider" />
      {item(<I.folder size={13} />, t("sidebarPanel.showInFolder"), onReveal, {
        disabled: !target.session.path,
      })}
      {item(<I.copy size={13} />, t("sidebarPanel.copyWorkspacePath"), onCopyWorkspacePath, {
        disabled: !workspacePath,
      })}
      {item(<I.copy size={13} />, t("sidebarPanel.copySessionId"), onCopySessionId)}
      <div className="session-menu-divider" />
      {item(<I.trash size={13} />, t("sidebarPanel.deleteConversation"), onDelete, {
        danger: true,
      })}
    </div>
  );
}

function WorkspaceContextMenu({
  target,
  pinned,
  onArchive,
  onCopyWorkspacePath,
  onOpenArchived,
  onOpenInFolder,
  onRemove,
  onRename,
  onTogglePin,
}: {
  target: WorkspaceMenuTarget;
  pinned: boolean;
  onArchive: () => void;
  onCopyWorkspacePath: () => void;
  onOpenArchived: () => void;
  onOpenInFolder: () => void;
  onRemove: () => void;
  onRename: () => void;
  onTogglePin: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: target.x,
    top: target.y,
  });
  const hasPath = Boolean(target.group.path);

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const next = positionFloatingPanel(target, {
      width: rect.width,
      height: rect.height,
    });
    if (next.left !== pos.left || next.top !== pos.top) setPos(next);
  }, [target, pos.left, pos.top]);

  const item = (
    icon: ReactNode,
    label: string,
    onClick: () => void,
    options: { disabled?: boolean; danger?: boolean } = {},
  ) => (
    <button
      type="button"
      role="menuitem"
      disabled={options.disabled}
      data-danger={options.danger || undefined}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div
      ref={ref}
      className="session-menu workspace-menu"
      role="menu"
      aria-label={t("sidebarPanel.workspaceActions")}
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="session-menu-title">{target.group.label}</div>
      {item(
        <I.pin size={13} />,
        pinned ? t("sidebarPanel.unpinWorkspace") : t("sidebarPanel.pinWorkspace"),
        onTogglePin,
      )}
      {item(<I.folder size={13} />, t("sidebarPanel.showInFolder"), onOpenInFolder, {
        disabled: !hasPath,
      })}
      {item(<I.pencil size={13} />, t("sidebarPanel.renameWorkspace"), onRename, {
        disabled: !hasPath,
      })}
      {item(<I.archive size={13} />, t("sidebarPanel.archiveWorkspaceChats"), onArchive, {
        disabled: target.group.sessions.length === 0,
      })}
      {item(<I.archive size={13} />, t("sidebarPanel.viewArchived"), onOpenArchived)}
      <div className="session-menu-divider" />
      {item(<I.copy size={13} />, t("sidebarPanel.copyWorkspacePath"), onCopyWorkspacePath, {
        disabled: !hasPath,
      })}
      {item(<I.trash size={13} />, t("sidebarPanel.removeWorkspace"), onRemove, {
        disabled: !hasPath,
        danger: true,
      })}
    </div>
  );
}

function WorkspaceRenamePopover({
  target,
  onCancel,
  onConfirm,
}: {
  target: PendingWorkspaceRename;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(target.label);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: target.x,
    top: target.y,
  });

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const next = positionFloatingPanel(target, {
      width: rect.width,
      height: rect.height,
    });
    if (next.left !== pos.left || next.top !== pos.top) setPos(next);
  }, [target, pos.left, pos.top]);

  const confirm = () => onConfirm(value);

  return (
    <div
      ref={ref}
      className="workspace-rename-popover"
      role="dialog"
      aria-label={t("sidebarPanel.renameWorkspace")}
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="session-delete-head">
        <span className="ico">
          <I.pencil size={15} />
        </span>
        <span>{t("sidebarPanel.renameWorkspace")}</span>
      </div>
      <input
        className="workspace-rename-input"
        autoFocus
        value={value}
        maxLength={RENAME_MAX_CHARS}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") confirm();
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="actions">
        <button type="button" className="cancel" onClick={onCancel}>
          {t("sidebarPanel.cancel")}
        </button>
        <button type="button" className="confirm" onClick={confirm}>
          {t("sidebarPanel.renameWorkspace")}
        </button>
      </div>
    </div>
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
      aria-label={t("sidebarPanel.deleteConversation")}
      aria-modal="true"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="session-delete-head">
        <span className="ico">
          <I.trash size={15} />
        </span>
        <span>{t("sidebarPanel.deleteConversation")}</span>
      </div>
      <div className="msg">
        {t("sidebarPanel.deleteConversationDesc")}
        <span className="name">{target.pretty}</span>
      </div>
      <div className="actions">
        <button ref={cancelRef} type="button" className="cancel" onClick={onCancel}>
          {t("sidebarPanel.cancel")}
        </button>
        <button type="button" className="confirm" onClick={onConfirm}>
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
        <button
          type="button"
          className="close"
          onClick={onCancel}
          aria-label={t("sidebarPanel.cancel")}
        >
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
              <button
                type="button"
                data-on={source === "claude"}
                onClick={() => setSource("claude")}
              >
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
