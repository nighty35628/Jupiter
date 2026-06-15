import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionFile, Settings, SideChatEntry, UsageStats } from "../App";
import { Markdown } from "../Markdown";
import {
  type FilePreview,
  type FilePreviewTarget,
  isHtmlFilePath,
  pathToFileUrl,
  readFileBytes,
} from "../file-preview";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import type {
  McpSpecInfo,
  MemoryDetail,
  MemoryEntryInfo,
  SourceSearchResult,
  SourceSearchResultsEvent,
  SubagentRunInfo,
} from "../protocol";
import { PanelErrorBoundary } from "./error-boundary";
import { FileActionMenu } from "./file-action-menu";
import { FilePreviewRenderer, previewRendererKind } from "./file-preview-renderers";
import { rankItems } from "./fuzzy";
import { NativeBrowserWebview } from "./native-browser-webview";
import { type TerminalFitAddon, createTerminalAddons } from "./xterm-addons";

export type ContextPanelMode =
  | "home"
  | "files"
  | "library"
  | "sidechat"
  | "browser"
  | "review"
  | "terminal"
  | "subagent"
  | "preview";
export type BrowserOpenRequest = { id: number; url: string };
export type ContextPanelTab = {
  id: string;
  mode: Exclude<ContextPanelMode, "home">;
  title?: string;
  browserRequest?: BrowserOpenRequest | null;
  filePreview?: FilePreview | null;
  filePreviewLoading?: boolean;
  filePreviewError?: string | null;
  filePreviewPath?: string | null;
  subagentRun?: SubagentRunInfo | null;
};
export type LibrarySource = {
  id: string;
  kind: "web" | "file";
  title: string;
  url?: string;
  path?: string;
  snippet?: string;
  contentText?: string;
  contentFetchedAt?: number;
  contentTruncated?: boolean;
  contentError?: string;
  ingestNonce?: number;
  ingestStatus?: "pending" | "done" | "error";
  addedAt: number;
};
export type LibrarySourceInput = Omit<LibrarySource, "id" | "addedAt">;

const CONTEXT_MAX_TOKENS = 1_000_000;
const SIDEBAR_TERMINAL_ID = "sidebar";
let browserLabelSequence = 0;

function nextBrowserLabel(): string {
  browserLabelSequence += 1;
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let n = browserLabelSequence;
  let suffix = "";
  do {
    suffix = alphabet[(n - 1) % alphabet.length] + suffix;
    n = Math.floor((n - 1) / alphabet.length);
  } while (n > 0);
  return `jupiter-sidebar-browser-${suffix}`;
}

export function normalizeBrowserUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:" &&
      url.protocol !== "asset:" &&
      url.protocol !== "file:"
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function fileUrlToPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return null;
    const path = decodeURIComponent(parsed.pathname);
    if (/^\/[a-zA-Z]:\//.test(path)) return path.slice(1);
    return path;
  } catch {
    return null;
  }
}

function ContextTokenPanel({ usage }: { usage: UsageStats }) {
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
    <div className="ctx-block ctx-body-tokens">
      <div className="h">
        <span>{t("contextPanel.contextTokens")}</span>
        <span className="right">
          {(reserved + used + cached).toLocaleString()} / {CONTEXT_MAX_TOKENS.toLocaleString()}
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
  );
}

export function ContextInfoPopover({
  open,
  settings,
  usage,
  mcpSpecs,
  mcpBridged,
  subagents,
  memory,
  memoryDetail,
  onOpenSubagent,
  onReadMemory,
}: {
  open: boolean;
  settings: Settings | null;
  usage: UsageStats;
  mcpSpecs: McpSpecInfo[];
  mcpBridged: boolean;
  subagents: SubagentRunInfo[];
  sessionFiles: SessionFile[];
  memory: MemoryEntryInfo[];
  memoryDetail: MemoryDetail | null;
  activePath?: string | null;
  onOpenSubagent: (sessionName: string) => void;
  onReadMemory: (path: string) => void;
  onPreviewFile?: (target: FilePreviewTarget) => void;
}) {
  useLang();
  return (
    <div
      className="context-info-popover"
      data-open={open}
      aria-hidden={!open}
      role="dialog"
      aria-label={t("contextPanel.infoTitle")}
    >
      <PanelErrorBoundary key="context-info-popover" label="context-info">
        <div className="context-info-card">
          <div className="context-info-head">
            <span>{t("contextPanel.infoTitle")}</span>
            <span className="context-info-gear" aria-hidden="true">
              <I.cog size={18} />
            </span>
          </div>
          <ContextTokenPanel usage={usage} />
          <div className="context-info-scroll">
            <CtxGitInfo settings={settings} />
            <CtxSubagents runs={subagents} onOpen={onOpenSubagent} />
            <CtxTools specs={mcpSpecs} bridged={mcpBridged} />
            <CtxMemory entries={memory} detail={memoryDetail} onRead={onReadMemory} />
          </div>
        </div>
      </PanelErrorBoundary>
    </div>
  );
}

function contextPanelModeTitle(mode: ContextPanelMode): string {
  switch (mode) {
    case "files":
      return t("contextPanel.home.filesTitle");
    case "library":
      return t("contextPanel.home.libraryTitle");
    case "sidechat":
      return t("contextPanel.home.sidechatTitle");
    case "browser":
      return t("contextPanel.home.browserTitle");
    case "review":
      return t("contextPanel.home.reviewTitle");
    case "terminal":
      return t("contextPanel.home.terminalTitle");
    case "subagent":
      return t("contextPanel.subagentsTitle");
    case "preview":
      return t("fileActions.previewTitle");
    case "home":
    default:
      return t("contextPanel.infoTitle");
  }
}

function contextPanelTabTitle(tab: ContextPanelTab): string {
  return tab.title || contextPanelModeTitle(tab.mode);
}

function contextPanelModeIcon(mode: ContextPanelMode, size = 14): ReactNode {
  switch (mode) {
    case "files":
      return <I.folder size={size} />;
    case "library":
      return <I.bookmark size={size} />;
    case "sidechat":
      return <I.search size={size} />;
    case "browser":
      return <I.globe size={size} />;
    case "review":
      return <I.diff size={size} />;
    case "terminal":
      return <I.terminal size={size} />;
    case "subagent":
      return <I.bot size={size} />;
    case "preview":
      return <I.file size={size} />;
    case "home":
    default:
      return <I.layers size={size} />;
  }
}

export function ContextPanel({
  settings,
  sessionFiles,
  selectedFilePreview,
  filePreviewLoading = false,
  filePreviewError = null,
  filePreviewPath = null,
  tabs = [],
  activeTabId = null,
  mode,
  onModeChange,
  onTabSelect,
  onTabClose,
  onNewTabMode,
  onCloseSidebar,
  onMentionQuery,
  onMentionPicked,
  mentionResults,
  sideChats = [],
  sideChatBusy = false,
  sideChatDisabled = false,
  onSideChatSend,
  browserRequest,
  browserReturnMode = null,
  onPreviewFile,
  visible = true,
  placement = "side",
  librarySources = [],
  librarySearchFocusNonce = 0,
  sourceSearch = null,
  onSourceSearch,
  onAddLibrarySource,
  onRemoveLibrarySource,
  onImportLibraryFiles,
  onOpenWebSource,
  onRevealFileSource,
  onOpenHtmlFile,
}: {
  settings: Settings | null;
  usage: UsageStats;
  mcpSpecs: McpSpecInfo[];
  mcpBridged: boolean;
  subagents: SubagentRunInfo[];
  sessionFiles: SessionFile[];
  memory: MemoryEntryInfo[];
  memoryDetail: MemoryDetail | null;
  librarySources?: LibrarySource[];
  librarySearchFocusNonce?: number;
  sourceSearch?: SourceSearchResultsEvent | null;
  selectedFilePreview?: FilePreview | null;
  filePreviewLoading?: boolean;
  filePreviewError?: string | null;
  filePreviewPath?: string | null;
  tabs?: ContextPanelTab[];
  activeTabId?: string | null;
  mode?: ContextPanelMode;
  onModeChange?: (mode: ContextPanelMode) => void;
  onTabSelect?: (id: string) => void;
  onTabClose?: (id: string) => void;
  onNewTabMode?: (mode: Exclude<ContextPanelMode, "home">) => void;
  onCloseSidebar?: () => void;
  onMentionQuery?: (q: string, nonce: number) => void;
  onMentionPicked?: (path: string) => void;
  mentionResults?: { nonce: number; query: string; results: string[] } | null;
  sideChats?: SideChatEntry[];
  sideChatBusy?: boolean;
  sideChatDisabled?: boolean;
  onSideChatSend?: (text: string) => void;
  browserRequest?: BrowserOpenRequest | null;
  browserReturnMode?: ContextPanelMode | null;
  visible?: boolean;
  placement?: "side" | "bottom";
  onOpenSubagent: (sessionName: string) => void;
  onReadMemory: (path: string) => void;
  onSourceSearch?: (query: string, nonce: number, topK?: number) => void;
  onAddLibrarySource?: (source: LibrarySourceInput) => void;
  onRemoveLibrarySource?: (id: string) => void;
  onImportLibraryFiles?: () => void;
  onOpenWebSource?: (url: string) => void;
  onRevealFileSource?: (path: string) => void;
  onPreviewFile?: (target: FilePreviewTarget) => void;
  onOpenHtmlFile?: (target: FilePreviewTarget) => void;
}) {
  useLang();
  const [localMode, setLocalMode] = useState<ContextPanelMode>("home");
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[tabs.length - 1] ?? null;
  const usingTabs = Boolean(activeTab);
  const legacyMode: ContextPanelMode = mode ?? localMode;
  const activeMode: ContextPanelMode = activeTab ? activeTab.mode : legacyMode;
  const setPanelMode = onModeChange ?? setLocalMode;
  const activeSelectedFilePreview = usingTabs
    ? (activeTab?.filePreview ?? null)
    : selectedFilePreview;
  const activeFilePreviewLoading = usingTabs
    ? Boolean(activeTab?.filePreviewLoading)
    : filePreviewLoading;
  const activeFilePreviewError = usingTabs
    ? (activeTab?.filePreviewError ?? null)
    : filePreviewError;
  const activeFilePreviewPath = usingTabs
    ? (activeTab?.filePreview?.path ?? activeTab?.filePreviewPath ?? null)
    : filePreviewPath;
  const activeBrowserRequest = usingTabs ? (activeTab?.browserRequest ?? null) : browserRequest;
  const activeSubagentRun = usingTabs ? (activeTab?.subagentRun ?? null) : null;
  const previewPath = activeSelectedFilePreview?.path ?? activeFilePreviewPath;
  const previewAvailable = Boolean(
    previewPath || activeFilePreviewLoading || activeFilePreviewError,
  );
  useEffect(() => {
    if (usingTabs) return;
    if (previewPath) setPanelMode("preview");
  }, [previewPath, setPanelMode, usingTabs]);
  const showPreview = previewAvailable && activeMode === "preview";
  const openPanelMode = (nextMode: ContextPanelMode) => {
    if (nextMode === "home") {
      setPanelMode("home");
      return;
    }
    if (onNewTabMode) {
      onNewTabMode(nextMode);
      return;
    }
    setPanelMode(nextMode);
  };
  const closeTab = () => {
    if (usingTabs && activeTab) {
      onTabClose?.(activeTab.id);
      return;
    }
    if (legacyMode === "home") {
      onCloseSidebar?.();
      return;
    }
    if (legacyMode === "browser" && browserReturnMode && browserReturnMode !== "browser") {
      setPanelMode(browserReturnMode);
      return;
    }
    setPanelMode("home");
  };
  const activeTitle = activeTab
    ? contextPanelTabTitle(activeTab)
    : contextPanelModeTitle(showPreview ? "preview" : activeMode);
  const activeIcon = contextPanelModeIcon(showPreview ? "preview" : activeMode);
  const tabBar = (
    <CtxTabBar
      icon={activeIcon}
      title={activeTitle}
      tabs={tabs}
      activeTabId={activeTab?.id ?? null}
      onSelectTab={onTabSelect}
      onCloseTab={onTabClose}
      onClose={closeTab}
      onSelectMode={openPanelMode}
    />
  );
  return (
    <aside
      className="ctx"
      data-mode={showPreview ? "preview" : activeMode}
      data-placement={placement}
    >
      {showPreview ? (
        <div className="ctx-mode-shell">
          {tabBar}
          <PanelErrorBoundary key={activeTab?.id ?? "preview"} label="preview">
            <FilePreviewPane
              preview={activeSelectedFilePreview ?? null}
              loading={Boolean(activeFilePreviewLoading)}
              error={activeFilePreviewError ?? null}
              fallbackPath={activeFilePreviewPath}
              workspaceDir={settings?.workspaceDir}
              editor={settings?.editor}
              onPreviewFile={onPreviewFile}
              onOpenHtmlFile={onOpenHtmlFile}
              full
            />
          </PanelErrorBoundary>
        </div>
      ) : (
        <PanelErrorBoundary key={activeTab?.id ?? activeMode} label={activeMode}>
          {activeMode === "home" ? (
            <div className="ctx-home-shell">
              <CtxHome onSelect={openPanelMode} />
            </div>
          ) : activeMode === "files" ? (
            <div className="ctx-mode-shell">
              {tabBar}
              <CtxFiles
                files={sessionFiles}
                settings={settings}
                activePath={previewPath}
                onPreviewFile={onPreviewFile}
                onOpenHtmlFile={onOpenHtmlFile}
                onMentionQuery={onMentionQuery}
                onMentionPicked={onMentionPicked}
                mentionResults={mentionResults}
                onAddLibrarySource={onAddLibrarySource}
              />
            </div>
          ) : activeMode === "library" ? (
            <div className="ctx-mode-shell">
              {tabBar}
              <CtxLibrary
                sources={librarySources}
                searchFocusNonce={librarySearchFocusNonce}
                sourceSearch={sourceSearch}
                onSourceSearch={onSourceSearch}
                onAddSource={onAddLibrarySource}
                onRemoveSource={onRemoveLibrarySource}
                onImportFiles={onImportLibraryFiles}
                onOpenWebSource={onOpenWebSource}
                onRevealFileSource={onRevealFileSource}
                onPreviewFile={onPreviewFile}
              />
            </div>
          ) : activeMode === "sidechat" ? (
            <div className="ctx-mode-shell">
              {tabBar}
              <CtxSideChat
                entries={sideChats}
                busy={sideChatBusy}
                disabled={sideChatDisabled}
                onSend={onSideChatSend}
              />
            </div>
          ) : activeMode === "browser" ? (
            <div className="ctx-mode-shell">
              {tabBar}
              <CtxBrowser request={activeBrowserRequest} visible={visible} placement={placement} />
            </div>
          ) : activeMode === "review" ? (
            <div className="ctx-mode-shell">
              {tabBar}
              <CtxReview settings={settings} onPreviewFile={onPreviewFile} />
            </div>
          ) : activeMode === "terminal" ? (
            <div className="ctx-mode-shell">
              {tabBar}
              <CtxTerminal settings={settings} />
            </div>
          ) : activeMode === "subagent" ? (
            <div className="ctx-mode-shell">
              {tabBar}
              <CtxSubagentDetail run={activeSubagentRun} />
            </div>
          ) : (
            <CtxPlaceholder mode={activeMode} onClose={closeTab} onSelectMode={openPanelMode} />
          )}
        </PanelErrorBoundary>
      )}
    </aside>
  );
}

function CtxBrowser({
  request,
  visible = true,
  placement,
}: {
  request?: BrowserOpenRequest | null;
  visible?: boolean;
  placement: "side" | "bottom";
}) {
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const nativeRef = useRef<NativeBrowserWebview | null>(null);
  if (!nativeRef.current) {
    nativeRef.current = new NativeBrowserWebview(nextBrowserLabel());
  }
  const currentUrl = historyIndex >= 0 ? history[historyIndex] : null;
  const lastRequestIdRef = useRef<number | null>(null);
  const open = useCallback(
    (value: string) => {
      const url = normalizeBrowserUrl(value);
      if (!url) {
        setError(t("contextPanel.browser.invalidUrl"));
        return;
      }
      const nextHistory = [...history.slice(0, historyIndex + 1), url];
      setHistory(nextHistory);
      setHistoryIndex(nextHistory.length - 1);
      setReloadKey((key) => key + 1);
      setError(null);
      setNativeError(null);
      setDraft(url);
    },
    [history, historyIndex],
  );
  useEffect(() => {
    if (currentUrl) setDraft(currentUrl);
  }, [currentUrl]);
  useEffect(() => {
    if (!request || lastRequestIdRef.current === request.id) return;
    lastRequestIdRef.current = request.id;
    open(request.url);
  }, [open, request]);
  useEffect(
    () => () => {
      void nativeRef.current?.close();
    },
    [],
  );
  const browserBounds = useCallback(() => {
    if (!visible) return null;
    const host = hostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return null;
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }, [visible]);
  const syncNativeBrowser = useCallback(
    (forceReload = false) => {
      const native = nativeRef.current;
      if (!native) return;
      if (!visible) {
        void native.hide();
        return;
      }
      if (!currentUrl) {
        void native.close();
        return;
      }
      const bounds = browserBounds();
      if (!bounds) {
        void native.hide();
        return;
      }
      void native.open(currentUrl, bounds, { forceReload }).then(
        () => setNativeError(null),
        (reason) => {
          const message = reason instanceof Error ? reason.message : String(reason);
          setNativeError(`${t("contextPanel.browser.nativeError")}: ${message}`);
        },
      );
    },
    [browserBounds, currentUrl, visible],
  );
  useLayoutEffect(() => {
    syncNativeBrowser(Boolean(currentUrl));
  }, [currentUrl, reloadKey, syncNativeBrowser, visible]);
  useEffect(() => {
    if (visible) return;
    void nativeRef.current?.hide();
  }, [visible]);
  useEffect(() => {
    if (!currentUrl || !visible) return;
    const sync = () => syncNativeBrowser(false);
    let followupFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      sync();
      followupFrame = window.requestAnimationFrame(sync);
    });
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => sync());
    if (hostRef.current && resizeObserver) resizeObserver.observe(hostRef.current);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      window.cancelAnimationFrame(frame);
      if (followupFrame) window.cancelAnimationFrame(followupFrame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [currentUrl, placement, syncNativeBrowser, visible]);
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex >= 0 && historyIndex < history.length - 1;
  const openCurrentExternal = () => {
    if (!currentUrl) return;
    const filePath = fileUrlToPath(currentUrl);
    if (filePath) {
      openPath(filePath).catch(() => undefined);
      return;
    }
    openUrl(currentUrl).catch(() => undefined);
  };
  return (
    <div className="ctx-browser">
      <form
        className="ctx-browser-bar"
        onSubmit={(event) => {
          event.preventDefault();
          open(draft);
        }}
      >
        <div className="ctx-browser-nav">
          <button
            type="button"
            className="ctx-browser-iconbtn"
            aria-label={t("contextPanel.browser.back")}
            title={t("contextPanel.browser.back")}
            disabled={!canGoBack}
            onClick={() => {
              setHistoryIndex((idx) => Math.max(0, idx - 1));
              setError(null);
            }}
          >
            <I.chevR size={15} style={{ transform: "rotate(180deg)" }} />
          </button>
          <button
            type="button"
            className="ctx-browser-iconbtn"
            aria-label={t("contextPanel.browser.forward")}
            title={t("contextPanel.browser.forward")}
            disabled={!canGoForward}
            onClick={() => {
              setHistoryIndex((idx) => Math.min(history.length - 1, idx + 1));
              setError(null);
            }}
          >
            <I.chevR size={15} />
          </button>
          <button
            type="button"
            className="ctx-browser-iconbtn"
            aria-label={t("contextPanel.browser.reload")}
            title={t("contextPanel.browser.reload")}
            disabled={!currentUrl}
            onClick={() => setReloadKey((key) => key + 1)}
          >
            <I.refresh size={14} />
          </button>
        </div>
        <input
          className="ctx-browser-input"
          value={draft}
          aria-label={t("contextPanel.browser.urlLabel")}
          placeholder={t("contextPanel.browser.placeholder")}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="submit"
          className="ctx-browser-go"
          aria-label={t("contextPanel.browser.open")}
          title={t("contextPanel.browser.open")}
        >
          <I.send size={14} />
        </button>
      </form>
      {error ? <div className="ctx-browser-error">{error}</div> : null}
      {nativeError ? <div className="ctx-browser-error">{nativeError}</div> : null}
      <div className="ctx-browser-frame-wrap">
        {currentUrl ? (
          <>
            <div className="ctx-browser-status">
              <span>{currentUrl}</span>
              <button
                type="button"
                className="ctx-browser-external"
                aria-label={t("contextPanel.browser.openExternal")}
                title={t("contextPanel.browser.openExternal")}
                onClick={openCurrentExternal}
              >
                <I.link size={13} />
                <span>{t("contextPanel.browser.external")}</span>
              </button>
            </div>
            <div
              ref={hostRef}
              className="ctx-browser-native-host"
              title={t("contextPanel.browser.previewTitle")}
              aria-label={t("contextPanel.browser.previewTitle")}
            />
          </>
        ) : (
          <div className="ctx-browser-empty">
            <I.globe size={30} />
            <div className="ctx-browser-empty-title">{t("contextPanel.browser.emptyTitle")}</div>
            <div className="ctx-browser-empty-body">{t("contextPanel.browser.emptyBody")}</div>
          </div>
        )}
      </div>
      <div className="ctx-browser-hint">{t("contextPanel.browser.nativeHint")}</div>
    </div>
  );
}

type GitStatusEntry = {
  path: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | string;
};

type GitInfo = {
  isRepo: boolean;
  branch?: string | null;
  upstream?: string | null;
  remote?: string | null;
  ahead: number;
  behind: number;
  lastCommit?: string | null;
  branches: string[];
};

type TerminalCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type GitInfoState =
  | { status: "loading"; info: GitInfo | null; entries: GitStatusEntry[]; error: null }
  | { status: "ready"; info: GitInfo | null; entries: GitStatusEntry[]; error: null }
  | { status: "error"; info: GitInfo | null; entries: GitStatusEntry[]; error: string };

type TerminalOutputEvent = { id: string; data: string };
type TerminalExitEvent = { id: string; code: number | null };

function cssColor(host: HTMLElement, name: string, fallback: string): string {
  const value = window.getComputedStyle(host).getPropertyValue(name).trim();
  return value || fallback;
}

function terminalColor(
  host: HTMLElement,
  name: string,
  fallbackName: string,
  fallback: string,
): string {
  return cssColor(host, name, cssColor(host, fallbackName, fallback));
}

function terminalTheme(host: HTMLElement) {
  const foreground = terminalColor(host, "--terminal-fg", "--fg", "#1f2328");
  const surface = terminalColor(host, "--terminal-surface", "--panel", "#f6f8fa");
  return {
    background: surface,
    foreground,
    cursor: foreground,
    cursorAccent: surface,
    selectionBackground: cssColor(
      host,
      "--accent-soft",
      "rgba(80, 120, 255, 0.22)",
    ),
    black: foreground,
    red: terminalColor(host, "--terminal-red", "--danger", "#cf222e"),
    green: terminalColor(host, "--terminal-green", "--success", "#1a7f37"),
    yellow: terminalColor(host, "--terminal-yellow", "--warning", "#9a6700"),
    blue: terminalColor(host, "--terminal-blue", "--accent", "#0969da"),
    magenta: terminalColor(host, "--terminal-magenta", "--violet", "#8250df"),
    cyan: terminalColor(host, "--terminal-cyan", "--accent", "#1b7c83"),
    white: foreground,
    brightBlack: terminalColor(host, "--terminal-bright-black", "--muted", "#57606a"),
    brightRed: terminalColor(host, "--terminal-bright-red", "--danger", "#a40e26"),
    brightGreen: terminalColor(host, "--terminal-bright-green", "--success", "#116329"),
    brightYellow: terminalColor(host, "--terminal-bright-yellow", "--warning", "#7d4e00"),
    brightBlue: terminalColor(host, "--terminal-bright-blue", "--accent-strong", "#0550ae"),
    brightMagenta: terminalColor(host, "--terminal-bright-magenta", "--violet", "#6639ba"),
    brightCyan: terminalColor(host, "--terminal-bright-cyan", "--accent-strong", "#0a6b73"),
    brightWhite: foreground,
  };
}

function applyTerminalTheme(terminal: Terminal, host: HTMLElement): void {
  const typed = terminal as Terminal & {
    options?: { theme?: ReturnType<typeof terminalTheme> };
  };
  if (!typed.options) typed.options = {};
  typed.options.theme = terminalTheme(host);
}

type ReviewState =
  | { status: "loading"; entries: GitStatusEntry[]; diff: string; error: null }
  | { status: "ready"; entries: GitStatusEntry[]; diff: string; error: null }
  | { status: "error"; entries: GitStatusEntry[]; diff: string; error: string };

type ReviewDiffLine = {
  text: string;
  kind: "add" | "del" | "hunk" | "ctx" | "meta";
};

type ReviewFile = {
  path: string;
  kind: GitStatusEntry["kind"];
  additions: number;
  deletions: number;
  lines: ReviewDiffLine[];
};

function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function diffLineKind(line: string): ReviewDiffLine["kind"] {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("+++") ||
    line.startsWith("---")
  ) {
    return "meta";
  }
  return "ctx";
}

function diffFilePathFromLine(line: string): string | null {
  const diffMatch = /^diff --git (?:"?a\/(.+?)"?|"?(.+?)"?) (?:"?b\/(.+?)"?|"?(.+?)"?)$/.exec(line);
  if (diffMatch) {
    return diffMatch[3] ?? diffMatch[4] ?? diffMatch[1] ?? diffMatch[2] ?? null;
  }
  if (line.startsWith("+++ ")) {
    const value = line.slice(4).trim();
    if (value === "/dev/null") return null;
    return value.replace(/^"?b\//, "").replace(/"$/, "");
  }
  return null;
}

function buildReviewFiles(entries: GitStatusEntry[], diff: string): ReviewFile[] {
  const order: string[] = [];
  const byPath = new Map<string, ReviewFile>();
  const ensureFile = (path: string, kind = "modified") => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const file: ReviewFile = {
      path,
      kind,
      additions: 0,
      deletions: 0,
      lines: [],
    };
    byPath.set(path, file);
    order.push(path);
    return file;
  };

  for (const entry of entries) {
    ensureFile(entry.path, entry.kind);
  }

  let current: ReviewFile | null = null;
  for (const line of diff.split("\n")) {
    const path = diffFilePathFromLine(line);
    if (path) {
      current = ensureFile(path, byPath.get(path)?.kind ?? "modified");
    }
    if (!current) continue;
    const kind = diffLineKind(line);
    if (kind === "add") current.additions += 1;
    if (kind === "del") current.deletions += 1;
    if (kind !== "meta") {
      current.lines.push({ text: line || " ", kind });
    }
  }

  return order.map((path) => byPath.get(path)).filter(Boolean) as ReviewFile[];
}

function statusLabel(kind: string): string {
  if (kind === "added") return t("contextPanel.review.status.added");
  if (kind === "deleted") return t("contextPanel.review.status.deleted");
  if (kind === "renamed") return t("contextPanel.review.status.renamed");
  if (kind === "untracked") return t("contextPanel.review.status.untracked");
  return t("contextPanel.review.status.modified");
}

function gitSyncLabel(info: GitInfo): string {
  const parts: string[] = [];
  if (info.ahead > 0) {
    parts.push(t("contextPanel.git.ahead", { count: info.ahead }));
  }
  if (info.behind > 0) {
    parts.push(t("contextPanel.git.behind", { count: info.behind }));
  }
  return parts.length > 0 ? parts.join(" · ") : t("contextPanel.git.upToDate");
}

function gitCommandMessage(result: TerminalCommandResult): string {
  const text = (result.stderr || result.stdout).trim();
  if (text) return text;
  return result.code === 0
    ? t("contextPanel.git.actionComplete")
    : t("contextPanel.git.actionFailed", { code: result.code });
}

function CtxGitInfo({ settings }: { settings: Settings | null }) {
  const workspaceDir = settings?.workspaceDir;
  const [commitMessage, setCommitMessage] = useState("");
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [state, setState] = useState<GitInfoState>({
    status: "loading",
    info: null,
    entries: [],
    error: null,
  });
  const load = useCallback(() => {
    if (!workspaceDir) {
      setState({
        status: "error",
        info: null,
        entries: [],
        error: t("contextPanel.git.noWorkspace"),
      });
      return;
    }
    setState((current) => ({
      status: "loading",
      info: current.info,
      entries: current.entries,
      error: null,
    }));
    void Promise.all([
      invoke<GitInfo>("git_info", { root: workspaceDir }),
      invoke<GitStatusEntry[]>("git_status", { root: workspaceDir }),
    ]).then(
      ([info, entries]) => {
        setState({
          status: "ready",
          info: info ?? null,
          entries: Array.isArray(entries) ? entries : [],
          error: null,
        });
      },
      (reason) => {
        setState({
          status: "error",
          info: null,
          entries: [],
          error: reason instanceof Error ? reason.message : String(reason),
        });
      },
    );
  }, [workspaceDir]);
  useEffect(() => {
    load();
  }, [load]);

  const runGitAction = async (label: string, action: () => Promise<TerminalCommandResult>) => {
    setBusyAction(label);
    setActionStatus(null);
    try {
      const result = await action();
      setActionStatus(gitCommandMessage(result));
      load();
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const info = state.info;
  const changedCount = state.entries.length;
  const canCommit = Boolean(workspaceDir);
  return (
    <div className="ctx-block ctx-git-info">
      <div className="h">
        <span>{t("contextPanel.git.title")}</span>
        <span className="right">
          {state.status === "loading" ? t("contextPanel.git.loading") : ""}
        </span>
      </div>
      {state.error ? <div className="ctx-browser-error">{state.error}</div> : null}
      {info && !info.isRepo ? (
        <div className="ctx-empty">{t("contextPanel.git.notRepo")}</div>
      ) : info ? (
        <>
          <div className="ctx-git-grid">
            <span>{t("contextPanel.git.branch")}</span>
            <strong>{info.branch ?? t("contextPanel.git.detached")}</strong>
            <span>{t("contextPanel.git.upstream")}</span>
            <strong>{info.upstream ?? "—"}</strong>
            <span>{t("contextPanel.git.remote")}</span>
            <strong>{info.remote ?? "—"}</strong>
            <span>{t("contextPanel.git.sync")}</span>
            <strong>{gitSyncLabel(info)}</strong>
            <span>{t("contextPanel.git.changes")}</span>
            <strong>{t("contextPanel.review.filesChanged", { count: changedCount })}</strong>
            <span>{t("contextPanel.git.lastCommit")}</span>
            <strong title={info.lastCommit ?? undefined}>{info.lastCommit ?? "—"}</strong>
          </div>
          <label className="ctx-git-branch">
            <span>{t("contextPanel.git.branch")}</span>
            <select
              aria-label={t("contextPanel.git.branch")}
              value={info.branch ?? ""}
              disabled={busyAction !== null || info.branches.length === 0}
              onChange={(event) => {
                const branch = event.target.value;
                if (!workspaceDir || !branch || branch === info.branch) return;
                void runGitAction(t("contextPanel.git.checkout"), () =>
                  invoke<TerminalCommandResult>("git_checkout_branch", {
                    root: workspaceDir,
                    branch,
                  }),
                );
              }}
            >
              {info.branches.length === 0 ? (
                <option value="">{info.branch ?? t("contextPanel.git.detached")}</option>
              ) : (
                info.branches.map((branch) => (
                  <option value={branch} key={branch}>
                    {branch}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="ctx-git-commit">
            <span>{t("contextPanel.git.commitMessage")}</span>
            <input
              aria-label={t("contextPanel.git.commitMessage")}
              value={commitMessage}
              placeholder={t("contextPanel.git.commitPlaceholder")}
              onChange={(event) => setCommitMessage(event.target.value)}
            />
          </label>
          <div className="ctx-git-actions">
            <button
              type="button"
              disabled={!canCommit || busyAction !== null}
              onClick={() => {
                if (!workspaceDir) return;
                const message = commitMessage.trim();
                void runGitAction(t("contextPanel.git.commitAll"), () =>
                  invoke<TerminalCommandResult>("git_commit_all", {
                    root: workspaceDir,
                    message,
                  }),
                );
              }}
            >
              {t("contextPanel.git.commitAll")}
            </button>
            <button
              type="button"
              disabled={!workspaceDir || busyAction !== null}
              onClick={() => {
                if (!workspaceDir) return;
                void runGitAction(t("contextPanel.git.push"), () =>
                  invoke<TerminalCommandResult>("git_push", { root: workspaceDir }),
                );
              }}
            >
              {t("contextPanel.git.push")}
            </button>
            <button
              type="button"
              disabled={!workspaceDir || busyAction !== null}
              onClick={() => {
                if (!workspaceDir) return;
                void runGitAction(t("contextPanel.git.createPr"), () =>
                  invoke<TerminalCommandResult>("git_create_pull_request", {
                    root: workspaceDir,
                  }),
                );
              }}
            >
              {t("contextPanel.git.createPr")}
            </button>
          </div>
          {actionStatus ? <div className="ctx-git-action-status">{actionStatus}</div> : null}
        </>
      ) : (
        <div className="ctx-empty">{t("contextPanel.git.loading")}</div>
      )}
    </div>
  );
}

function CtxReview({
  settings,
  onPreviewFile,
}: {
  settings: Settings | null;
  onPreviewFile?: (target: FilePreviewTarget) => void;
}) {
  const workspaceDir = settings?.workspaceDir;
  const loadSeqRef = useRef(0);
  const userPickedReviewFileRef = useRef(false);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [state, setState] = useState<ReviewState>({
    status: "loading",
    entries: [],
    diff: "",
    error: null,
  });
  const load = useCallback(() => {
    if (!workspaceDir) {
      setState({
        status: "error",
        entries: [],
        diff: "",
        error: t("contextPanel.review.noWorkspace"),
      });
      return;
    }
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    setState((current) => ({
      status: "loading",
      entries: current.entries,
      diff: current.diff,
      error: null,
    }));
    void Promise.all([
      invoke<GitStatusEntry[]>("git_status", { root: workspaceDir }),
      invoke<string>("git_diff", { root: workspaceDir }),
    ]).then(
      ([entries, diff]) => {
        if (loadSeqRef.current !== seq) return;
        setState({ status: "ready", entries, diff, error: null });
      },
      (reason) => {
        if (loadSeqRef.current !== seq) return;
        setState({
          status: "error",
          entries: [],
          diff: "",
          error: reason instanceof Error ? reason.message : String(reason),
        });
      },
    );
  }, [workspaceDir]);
  useEffect(() => {
    load();
    const id = window.setInterval(load, 1800);
    return () => window.clearInterval(id);
  }, [load]);
  const stats = useMemo(() => diffStats(state.diff), [state.diff]);
  const reviewFiles = useMemo(
    () => buildReviewFiles(state.entries, state.diff),
    [state.diff, state.entries],
  );
  const reviewFileKey = reviewFiles.map((file) => `${file.kind}:${file.path}`).join("\n");
  useEffect(() => {
    setExpandedPath((current) => {
      if (current && reviewFiles.some((file) => file.path === current)) {
        return current;
      }
      if (current === null && userPickedReviewFileRef.current) {
        return null;
      }
      return (
        reviewFiles.find((file) => file.lines.length > 0)?.path ?? reviewFiles[0]?.path ?? null
      );
    });
  }, [reviewFileKey, reviewFiles]);
  return (
    <div className="ctx-review">
      <div className="ctx-review-toolbar">
        <div className="ctx-review-summary">
          <span className="ctx-review-count">
            {t("contextPanel.review.filesChanged", {
              count: reviewFiles.length,
            })}
          </span>
          <span className="ctx-review-stat add">+{stats.additions}</span>
          <span className="ctx-review-stat del">-{stats.deletions}</span>
        </div>
      </div>
      {state.error ? <div className="ctx-browser-error">{state.error}</div> : null}
      <div className="ctx-review-changes">
        <div className="h">
          <span>{t("contextPanel.review.changedFiles")}</span>
          <span className="right">
            {state.status === "loading" ? t("contextPanel.review.loading") : ""}
          </span>
        </div>
        <div className="ctx-review-file-list">
          {reviewFiles.length === 0 ? (
            <div className="ctx-empty">
              {state.status === "loading"
                ? t("contextPanel.review.loading")
                : t("contextPanel.review.noChanges")}
            </div>
          ) : (
            reviewFiles.map((file) => {
              const expanded = expandedPath === file.path;
              return (
                <section
                  key={`${file.kind}:${file.path}`}
                  className="ctx-review-file-card"
                  data-expanded={expanded}
                >
                  <button
                    type="button"
                    className="ctx-review-file-head"
                    aria-expanded={expanded}
                    aria-label={`${file.path} ${statusLabel(file.kind)} +${file.additions} -${file.deletions}`}
                    onClick={() => {
                      userPickedReviewFileRef.current = true;
                      setExpandedPath((current) => (current === file.path ? null : file.path));
                    }}
                    onDoubleClick={() => onPreviewFile?.({ path: file.path })}
                  >
                    <span className="ctx-review-file-kind" data-kind={file.kind}>
                      {statusLabel(file.kind)}
                    </span>
                    <span className="ctx-review-file-path" title={file.path}>
                      {file.path}
                    </span>
                    <span className="ctx-review-file-stats">
                      <span className="add">+{file.additions}</span>
                      <span className="del">-{file.deletions}</span>
                    </span>
                    <I.chev size={13} className="ctx-review-file-chev" aria-hidden="true" />
                  </button>
                  {expanded ? (
                    <div className="ctx-review-file-diff">
                      {file.lines.length > 0 ? (
                        <pre className="ctx-review-diff-body">
                          {file.lines.map((line, index) => (
                            <span key={`${index}:${line.text}`} data-kind={line.kind}>
                              {line.text}
                            </span>
                          ))}
                        </pre>
                      ) : (
                        <div className="ctx-empty">{t("contextPanel.review.noDiff")}</div>
                      )}
                    </div>
                  ) : null}
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function CtxSideChat({
  entries,
  busy,
  disabled,
  onSend,
}: {
  entries: SideChatEntry[];
  busy: boolean;
  disabled: boolean;
  onSend?: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const canSend = Boolean(trimmed) && !disabled && Boolean(onSend);
  const submit = () => {
    if (!canSend) return;
    onSend?.(trimmed);
    setText("");
  };
  return (
    <div className="ctx-sidechat">
      <div className="ctx-sidechat-intro">
        <span className="ctx-sidechat-icon">
          <I.search size={18} />
        </span>
        <div>
          <div className="ctx-sidechat-title">{t("contextPanel.sideChat.title")}</div>
          <div className="ctx-sidechat-desc">{t("contextPanel.sideChat.desc")}</div>
        </div>
      </div>
      <div className="ctx-sidechat-thread" aria-live="polite">
        {entries.length === 0 ? (
          <div className="ctx-sidechat-empty">{t("contextPanel.sideChat.empty")}</div>
        ) : (
          entries.map((entry) => (
            <div className="ctx-sidechat-turn" key={entry.id} data-status={entry.status}>
              <div className="ctx-sidechat-question">{entry.question}</div>
              <div className="ctx-sidechat-answer">
                {entry.status === "pending" ? t("contextPanel.sideChat.pending") : entry.answer}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="ctx-sidechat-compose">
        <textarea
          value={text}
          aria-label={t("contextPanel.sideChat.inputLabel")}
          placeholder={t("contextPanel.sideChat.placeholder")}
          disabled={disabled}
          rows={6}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            submit();
          }}
        />
        <div className="ctx-sidechat-foot">
          <span>
            {busy ? t("contextPanel.sideChat.busyHint") : t("contextPanel.sideChat.readyHint")}
          </span>
          <button
            type="button"
            className="ctx-sidechat-send"
            disabled={!canSend}
            aria-label={t("contextPanel.sideChat.sendLabel")}
            title={t("contextPanel.sideChat.sendLabel")}
            onClick={submit}
          >
            <I.send size={14} />
            <span>{t("contextPanel.sideChat.sendButton")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function CtxTerminal({ settings }: { settings: Settings | null }) {
  const workspaceDir = settings?.workspaceDir ?? "";
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<TerminalFitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fitAndResize = useCallback(() => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit) return;
    try {
      fit.fit();
      void invoke("terminal_resize", {
        id: SIDEBAR_TERMINAL_ID,
        cols: terminal.cols || 80,
        rows: terminal.rows || 24,
      }).catch(() => {});
    } catch {
      /* xterm can throw while hidden or before layout settles */
    }
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!workspaceDir) {
      setError(t("contextPanel.terminal.noWorkspace"));
      return;
    }
    setError(null);

    let stopped = false;
    let terminal: Terminal | null = null;
    let dataDisposable: { dispose: () => void } | null = null;
    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let observer: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;

    void (async () => {
      terminal = new Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 12,
        lineHeight: 1.25,
        scrollback: 5000,
        theme: terminalTheme(host),
      });
      const currentTerminal = terminal;
      const { addons, fitAddon } = await createTerminalAddons();
      if (stopped) {
        currentTerminal.dispose();
        return;
      }
      for (const addon of addons) currentTerminal.loadAddon(addon);
      currentTerminal.open(host);
      terminalRef.current = currentTerminal;
      fitRef.current = fitAddon;
      fitAddon?.fit();
      currentTerminal.focus();

      dataDisposable = currentTerminal.onData((data) => {
        void invoke("terminal_write", { id: SIDEBAR_TERMINAL_ID, data });
      });

      const resize = () => fitAndResize();
      observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => resize());
      observer?.observe(host);
      themeObserver =
        typeof MutationObserver === "undefined"
          ? null
          : new MutationObserver(() => applyTerminalTheme(currentTerminal, host));
      themeObserver?.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-theme-style", "class", "style"],
      });
      window.setTimeout(resize, 0);

      const output = await listen<TerminalOutputEvent>("terminal:output", (event) => {
        if (event.payload.id !== SIDEBAR_TERMINAL_ID) return;
        currentTerminal.write(event.payload.data);
      });
      const exit = await listen<TerminalExitEvent>("terminal:exit", (event) => {
        if (event.payload.id !== SIDEBAR_TERMINAL_ID) return;
        const code = event.payload.code;
        currentTerminal.write(
          `\r\n[${t("contextPanel.terminal.exitCode", { code: code ?? "?" })}]\r\n`,
        );
      });
      if (stopped) {
        output();
        exit();
        return;
      }
      unlistenOutput = output;
      unlistenExit = exit;
      try {
        await invoke("terminal_spawn", {
          id: SIDEBAR_TERMINAL_ID,
          root: workspaceDir,
          cols: currentTerminal.cols || 80,
          rows: currentTerminal.rows || 24,
        });
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        currentTerminal.write(`\r\n${message}\r\n`);
      }
    })();

    return () => {
      stopped = true;
      observer?.disconnect();
      themeObserver?.disconnect();
      dataDisposable?.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      void invoke("terminal_kill", { id: SIDEBAR_TERMINAL_ID });
      terminal?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [fitAndResize, workspaceDir]);

  return (
    <div className="ctx-terminal">
      <div className="ctx-terminal-cwd" title={workspaceDir || undefined}>
        <span>$</span>
        <span>{workspaceDir || t("contextPanel.terminal.noWorkspace")}</span>
      </div>
      {error ? <div className="ctx-browser-error">{error}</div> : null}
      <div
        className="ctx-terminal-screen"
        ref={hostRef}
        role="application"
        aria-label={t("contextPanel.terminal.inputLabel")}
        onMouseDown={() => terminalRef.current?.focus()}
      />
    </div>
  );
}

function CtxHome({ onSelect }: { onSelect: (mode: ContextPanelMode) => void }) {
  const cards: Array<{
    mode: ContextPanelMode;
    icon: ReactNode;
    title: string;
    desc: string;
  }> = [
    {
      mode: "files",
      icon: <I.folder size={34} />,
      title: t("contextPanel.home.filesTitle"),
      desc: t("contextPanel.home.filesDesc"),
    },
    {
      mode: "library",
      icon: <I.bookmark size={34} />,
      title: t("contextPanel.home.libraryTitle"),
      desc: t("contextPanel.home.libraryDesc"),
    },
    {
      mode: "sidechat",
      icon: <I.search size={34} />,
      title: t("contextPanel.home.sidechatTitle"),
      desc: t("contextPanel.home.sidechatDesc"),
    },
    {
      mode: "browser",
      icon: <I.globe size={34} />,
      title: t("contextPanel.home.browserTitle"),
      desc: t("contextPanel.home.browserDesc"),
    },
    {
      mode: "review",
      icon: <I.diff size={34} />,
      title: t("contextPanel.home.reviewTitle"),
      desc: t("contextPanel.home.reviewDesc"),
    },
    {
      mode: "terminal",
      icon: <I.terminal size={34} />,
      title: t("contextPanel.home.terminalTitle"),
      desc: t("contextPanel.home.terminalDesc"),
    },
  ];
  return (
    <div className="ctx-home">
      {cards.map((card) => (
        <button
          type="button"
          key={card.mode}
          className="ctx-home-card"
          onClick={() => onSelect(card.mode)}
        >
          <span className="ctx-home-icon">{card.icon}</span>
          <span className="ctx-home-title">{card.title}</span>
          <span className="ctx-home-desc">{card.desc}</span>
        </button>
      ))}
    </div>
  );
}

function CtxLibrary({
  sources,
  searchFocusNonce,
  sourceSearch,
  onSourceSearch,
  onAddSource,
  onRemoveSource,
  onImportFiles,
  onOpenWebSource,
  onRevealFileSource,
  onPreviewFile,
}: {
  sources: LibrarySource[];
  searchFocusNonce: number;
  sourceSearch: SourceSearchResultsEvent | null;
  onSourceSearch?: (query: string, nonce: number, topK?: number) => void;
  onAddSource?: (source: LibrarySourceInput) => void;
  onRemoveSource?: (id: string) => void;
  onImportFiles?: () => void;
  onOpenWebSource?: (url: string) => void;
  onRevealFileSource?: (path: string) => void;
  onPreviewFile?: (target: FilePreviewTarget) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState<{
    query: string;
    nonce: number;
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchNonceRef = useRef(0);
  const savedSourceCount = sources.length;
  const activeQuery = activeSearch?.query.trim().toLowerCase() ?? "";
  const matchingSavedSources = useMemo(() => {
    return rankItems(
      sources.map((source) => ({
        ...source,
        searchableText: [
          source.title,
          source.url ?? "",
          source.path ?? "",
          source.snippet ?? "",
          source.contentText ?? "",
          source.contentError ?? "",
        ].join("\n"),
      })),
      activeQuery,
      ["title", "url", "path", "snippet", "contentText", "contentError", "searchableText"],
    );
  }, [activeQuery, sources]);
  const activeSearchResults =
    activeSearch && sourceSearch?.nonce === activeSearch.nonce ? sourceSearch : null;
  const webResults = activeSearchResults?.results ?? [];
  const webPending = Boolean(
    activeSearch && onSourceSearch && sourceSearch?.nonce !== activeSearch.nonce,
  );
  const addedSourceKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const source of sources) {
      if (source.kind === "web" && source.url) keys.add(`web:${source.url}`);
      if (source.kind === "file" && source.path) keys.add(`file:${source.path}`);
    }
    return keys;
  }, [sources]);

  useEffect(() => {
    if (searchFocusNonce <= 0) return;
    searchInputRef.current?.focus();
  }, [searchFocusNonce]);

  const runSearch = () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const nonce = ++searchNonceRef.current;
    setActiveSearch({ query: trimmed, nonce });
    onSourceSearch?.(trimmed, nonce);
  };
  const addWebResult = (result: SourceSearchResult) => {
    onAddSource?.({
      kind: "web",
      title: result.title || result.url,
      url: result.url,
      snippet: result.snippet,
    });
  };
  const openSource = (source: LibrarySource) => {
    if (source.kind === "web" && source.url) {
      onOpenWebSource?.(source.url);
      return;
    }
    if (source.kind === "file" && source.path) {
      onPreviewFile?.({ path: source.path });
    }
  };

  return (
    <div className="ctx-library">
      <div className="ctx-library-head">
        <div>
          <div className="ctx-library-title">{t("contextPanel.library.title")}</div>
          <div className="ctx-library-desc">{t("contextPanel.library.desc")}</div>
        </div>
        <button
          type="button"
          className="ctx-library-import"
          onClick={onImportFiles}
          disabled={!onImportFiles}
        >
          <I.upload size={13} />
          <span>{t("contextPanel.library.importFiles")}</span>
        </button>
      </div>

      <div className="ctx-library-stats">
        <div className="ctx-library-stat">
          <span className="ctx-library-stat-icon">
            <I.database size={16} />
          </span>
          <span className="ctx-library-stat-copy">
            <span>{t("contextPanel.library.savedSources")}</span>
            <strong>{t("contextPanel.itemCount", { count: savedSourceCount })}</strong>
          </span>
        </div>
      </div>

      <form
        className="ctx-library-search"
        onSubmit={(event) => {
          event.preventDefault();
          runSearch();
        }}
      >
        <label className="ctx-library-search-box">
          <I.search size={14} />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("contextPanel.library.searchPlaceholder")}
          />
        </label>
        <button type="submit" disabled={!query.trim()}>
          {t("contextPanel.library.searchButton")}
        </button>
      </form>

      {activeSearch ? (
        <div className="ctx-library-results">
          <LibraryResultSection
            title={t("contextPanel.library.webResults")}
            pending={webPending}
            error={activeSearchResults?.error}
            empty={!webPending && !activeSearchResults?.error && webResults.length === 0}
          >
            {webResults.map((result) => {
              const title = result.title || result.url;
              const added = addedSourceKeys.has(`web:${result.url}`);
              return (
                <div className="ctx-library-result" key={result.url}>
                  <span className="ctx-library-result-icon">
                    <I.globe size={14} />
                  </span>
                  <button
                    type="button"
                    className="ctx-library-result-copy ctx-library-result-open"
                    aria-label={t("contextPanel.library.openSource", {
                      title,
                    })}
                    onClick={() => onOpenWebSource?.(result.url)}
                  >
                    <strong>{title}</strong>
                    <span>{result.url}</span>
                    {result.snippet ? <p>{result.snippet}</p> : null}
                  </button>
                  <div className="ctx-library-result-actions">
                    <button
                      type="button"
                      disabled={added || !onAddSource}
                      onClick={() => addWebResult(result)}
                    >
                      {added
                        ? t("contextPanel.library.added")
                        : t("contextPanel.library.addSource")}
                    </button>
                  </div>
                </div>
              );
            })}
          </LibraryResultSection>
        </div>
      ) : sources.length === 0 ? (
        <div className="ctx-library-empty">
          <I.search size={24} />
          <div>{t("contextPanel.library.addTitle")}</div>
          <p>{t("contextPanel.library.addDesc")}</p>
        </div>
      ) : null}

      {matchingSavedSources.length > 0 ? (
        <div className="ctx-library-saved">
          <div className="ctx-library-section-title">{t("contextPanel.library.savedSources")}</div>
          <div className="ctx-library-saved-list">
            {matchingSavedSources.map((source) => (
              <div className="ctx-library-source" key={source.id}>
                <span className="ctx-library-source-icon">
                  {source.kind === "web" ? <I.globe size={14} /> : <I.file size={14} />}
                </span>
                <button
                  type="button"
                  className="ctx-library-source-copy ctx-library-source-main"
                  aria-label={t("contextPanel.library.openSource", {
                    title: source.title,
                  })}
                  onClick={() => openSource(source)}
                >
                  <strong>{source.title}</strong>
                  <span>{source.kind === "web" ? source.url : source.path}</span>
                  {source.snippet ? <p>{source.snippet}</p> : null}
                </button>
                <div className="ctx-library-source-actions">
                  {source.kind === "file" && source.path ? (
                    <button
                      type="button"
                      aria-label={t("contextPanel.library.showInFolder", {
                        title: source.title,
                      })}
                      title={t("contextPanel.library.showInFolder", {
                        title: source.title,
                      })}
                      onClick={() => onRevealFileSource?.(source.path!)}
                    >
                      <I.folder size={13} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label={t("contextPanel.library.removeSource", {
                      title: source.title,
                    })}
                    onClick={() => onRemoveSource?.(source.id)}
                  >
                    <I.x size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LibraryResultSection({
  title,
  pending,
  error,
  empty,
  children,
}: {
  title: string;
  pending: boolean;
  error?: string;
  empty?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="ctx-library-result-section">
      <div className="ctx-library-section-title">{title}</div>
      {pending ? (
        <div className="ctx-library-status">{t("contextPanel.searching")}</div>
      ) : error ? (
        <div className="ctx-library-status" data-tone="error">
          {t("contextPanel.library.searchError", { error })}
        </div>
      ) : empty ? (
        <div className="ctx-library-status">{t("contextPanel.library.noSearchResults")}</div>
      ) : (
        <div className="ctx-library-result-list">{children}</div>
      )}
    </section>
  );
}

function CtxTabBar({
  icon,
  title,
  tabs = [],
  activeTabId = null,
  onSelectTab,
  onCloseTab,
  onClose,
  onSelectMode,
}: {
  icon: ReactNode;
  title: string;
  tabs?: ContextPanelTab[];
  activeTabId?: string | null;
  onSelectTab?: (id: string) => void;
  onCloseTab?: (id: string) => void;
  onClose: () => void;
  onSelectMode?: (mode: ContextPanelMode) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const addItems: Array<{
    mode: ContextPanelMode;
    icon: ReactNode;
    title: string;
  }> = [
    {
      mode: "files",
      icon: <I.folder size={13} />,
      title: t("contextPanel.home.filesTitle"),
    },
    {
      mode: "library",
      icon: <I.bookmark size={13} />,
      title: t("contextPanel.home.libraryTitle"),
    },
    {
      mode: "sidechat",
      icon: <I.search size={13} />,
      title: t("contextPanel.home.sidechatTitle"),
    },
    {
      mode: "browser",
      icon: <I.globe size={13} />,
      title: t("contextPanel.home.browserTitle"),
    },
    {
      mode: "review",
      icon: <I.diff size={13} />,
      title: t("contextPanel.home.reviewTitle"),
    },
    {
      mode: "terminal",
      icon: <I.terminal size={13} />,
      title: t("contextPanel.home.terminalTitle"),
    },
  ];
  const renderTab = (tab: ContextPanelTab) => {
    const tabTitle = contextPanelTabTitle(tab);
    const active = tab.id === activeTabId;
    return (
      <div
        key={tab.id}
        className="ctx-tab"
        data-active={active ? "true" : "false"}
        data-clickable="true"
        role="tab"
        tabIndex={0}
        aria-selected={active}
        onClick={() => onSelectTab?.(tab.id)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onSelectTab?.(tab.id);
        }}
      >
        <span className="ctx-tab-icon">{contextPanelModeIcon(tab.mode)}</span>
        <span className="ctx-tab-title">{tabTitle}</span>
        <button
          type="button"
          className="ctx-tab-close"
          aria-label={
            active ? t("contextPanel.closeTab") : `${t("contextPanel.closeTab")} ${tabTitle}`
          }
          title={t("contextPanel.closeTab")}
          onClick={(event) => {
            event.stopPropagation();
            onCloseTab?.(tab.id);
          }}
        >
          <I.x size={12} />
        </button>
      </div>
    );
  };
  return (
    <div className="ctx-tabs">
      {tabs.length > 0 ? (
        tabs.map(renderTab)
      ) : (
        <div className="ctx-tab" data-active="true">
          <span className="ctx-tab-icon">{icon}</span>
          <span className="ctx-tab-title">{title}</span>
          <button
            type="button"
            className="ctx-tab-close"
            aria-label={t("contextPanel.closeTab")}
            title={t("contextPanel.closeTab")}
            onClick={onClose}
          >
            <I.x size={12} />
          </button>
        </div>
      )}
      {onSelectMode ? (
        <div className="ctx-tab-add-wrap">
          <button
            type="button"
            className="ctx-tab-add"
            aria-label={t("contextPanel.addTab")}
            title={t("contextPanel.addTab")}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <I.plus size={14} />
          </button>
          {menuOpen ? (
            <div className="ctx-tab-menu" role="menu">
              {addItems.map((item) => (
                <button
                  key={item.mode}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSelectMode(item.mode);
                    setMenuOpen(false);
                  }}
                >
                  <span>{item.icon}</span>
                  {item.title}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CtxPlaceholder({
  mode,
  onClose,
  onSelectMode,
}: {
  mode: ContextPanelMode;
  onClose: () => void;
  onSelectMode: (mode: ContextPanelMode) => void;
}) {
  const meta =
    mode === "sidechat"
      ? {
          icon: <I.search size={18} />,
          title: t("contextPanel.home.sidechatTitle"),
          body: t("contextPanel.placeholder.sidechat"),
        }
      : mode === "library"
        ? {
            icon: <I.bookmark size={18} />,
            title: t("contextPanel.home.libraryTitle"),
            body: t("contextPanel.placeholder.library"),
          }
        : mode === "browser"
          ? {
              icon: <I.globe size={18} />,
              title: t("contextPanel.home.browserTitle"),
              body: t("contextPanel.placeholder.browser"),
            }
          : mode === "review"
            ? {
                icon: <I.diff size={18} />,
                title: t("contextPanel.home.reviewTitle"),
                body: t("contextPanel.placeholder.review"),
              }
            : {
                icon: <I.terminal size={18} />,
                title: t("contextPanel.home.terminalTitle"),
                body: t("contextPanel.placeholder.terminal"),
              };
  return (
    <div className="ctx-mode-shell">
      <CtxTabBar
        icon={meta.icon}
        title={meta.title}
        onClose={onClose}
        onSelectMode={onSelectMode}
      />
      <div className="ctx-placeholder">
        <div className="ctx-placeholder-icon">{meta.icon}</div>
        <div className="ctx-placeholder-title">{meta.title}</div>
        <div className="ctx-placeholder-body">{meta.body}</div>
      </div>
    </div>
  );
}

type TreeNode =
  | { kind: "dir"; depth: number; name: string; key: string }
  | {
      kind: "file";
      depth: number;
      name: string;
      path: string;
      key: string;
      status: "c" | "m";
    };

type FileSearchItem = {
  raw: string;
  path: string;
  line?: string;
  name: string;
  desc?: string;
  kind: "dir" | "file";
};

async function openContextFile(
  path: string,
  settings: Settings | null,
  onOpenHtmlFile?: (target: FilePreviewTarget) => void,
): Promise<void> {
  if (isHtmlFilePath(path) && onOpenHtmlFile) {
    onOpenHtmlFile({ path });
    return;
  }
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

function parseFileSearchResult(raw: string): FileSearchItem {
  const normalized = raw.replace(/\\/g, "/");
  const kind = normalized.endsWith("/") ? "dir" : "file";
  const withoutSlash = normalized.replace(/\/+$/, "");
  const symbol = kind === "file" ? /^(.*):(\d+)$/.exec(withoutSlash) : null;
  const path = symbol?.[1] ?? normalized;
  const line = symbol?.[2];
  const displayPath = path.replace(/\/+$/, "");
  const slash = displayPath.lastIndexOf("/");
  const base = slash >= 0 ? displayPath.slice(slash + 1) : displayPath;
  const parent = slash >= 0 ? `${displayPath.slice(0, slash)}/` : "";
  return {
    raw,
    path,
    line,
    name: kind === "dir" ? `${base}/` : line ? `${base}:${line}` : base,
    desc: parent || undefined,
    kind,
  };
}

function libraryFileSourceFromPath(path: string): LibrarySourceInput {
  const normalized = path.replace(/\\/g, "/");
  const title = normalized.split("/").filter(Boolean).pop() || normalized;
  return {
    kind: "file",
    title,
    path: normalized,
    snippet: normalized,
  };
}

function CtxFiles({
  files,
  settings,
  activePath,
  onPreviewFile,
  onOpenHtmlFile,
  onMentionQuery,
  onMentionPicked,
  mentionResults,
  onAddLibrarySource,
  compact = false,
}: {
  files: SessionFile[];
  settings: Settings | null;
  activePath?: string | null;
  onPreviewFile?: (target: FilePreviewTarget) => void;
  onOpenHtmlFile?: (target: FilePreviewTarget) => void;
  onMentionQuery?: (q: string, nonce: number) => void;
  onMentionPicked?: (path: string) => void;
  mentionResults?: { nonce: number; query: string; results: string[] } | null;
  onAddLibrarySource?: (source: LibrarySourceInput) => void;
  compact?: boolean;
}) {
  const tree = useMemo(() => buildSessionTree(files), [files]);
  const [query, setQuery] = useState("");
  const [nonce, setNonce] = useState(0);
  const nonceRef = useRef(0);
  const [menu, setMenu] = useState<{
    path: string;
    left: number;
    top: number;
  } | null>(null);
  const workspaceDir = settings?.workspaceDir;
  const editor = settings?.editor;
  const canSearchProject = Boolean(onMentionQuery);
  useEffect(() => {
    if (!canSearchProject) return;
    const nextNonce = ++nonceRef.current;
    setNonce(nextNonce);
    const timer = window.setTimeout(() => onMentionQuery?.(query, nextNonce), 90);
    return () => window.clearTimeout(timer);
  }, [canSearchProject, onMentionQuery, query]);
  const results = useMemo<FileSearchItem[]>(() => {
    if (!mentionResults || mentionResults.nonce !== nonce) return [];
    return mentionResults.results.map(parseFileSearchResult);
  }, [mentionResults, nonce]);
  const openMenuAt = (path: string, left: number, top: number) => {
    setMenu({ path, left, top });
  };
  const openMenu = (path: string, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    openMenuAt(path, rect.right - 4, rect.bottom + 4);
  };
  const pickSearchItem = (item: FileSearchItem) => {
    if (item.kind === "dir") {
      setQuery(item.path);
      return;
    }
    onMentionPicked?.(item.path);
    onPreviewFile?.({ path: item.path, line: item.line });
  };
  const addFileToLibrary = (path: string) => {
    onAddLibrarySource?.(libraryFileSourceFromPath(path));
  };
  const renderFileNode = (n: Extract<TreeNode, { kind: "file" }>) => (
    <div
      className="node"
      key={n.key}
      data-d={n.depth}
      data-kind="file"
      data-active={activePath === n.path}
      data-jupiter-file-path={n.path}
      title={n.path}
      style={{ paddingLeft: 4 + n.depth * 14 }}
      onContextMenu={(event) => {
        event.preventDefault();
        openMenuAt(n.path, event.clientX, event.clientY);
      }}
    >
      <button type="button" className="node-main" onClick={() => onPreviewFile?.({ path: n.path })}>
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
        title={n.status === "m" ? t("contextPanel.fileModified") : t("contextPanel.fileInContext")}
      />
      <button
        type="button"
        className="tree-action"
        aria-label={t("contextPanel.library.addFileSource", { path: n.path })}
        title={t("contextPanel.library.addFileSource", { path: n.path })}
        disabled={!onAddLibrarySource}
        onClick={(event) => {
          event.stopPropagation();
          addFileToLibrary(n.path);
        }}
      >
        <I.plus size={12} />
      </button>
      <button
        type="button"
        className="tree-action"
        aria-label={t("contextPanel.openFile", { path: n.path })}
        title={t("contextPanel.openFile", { path: n.path })}
        onClick={(event) => {
          event.stopPropagation();
          void openContextFile(n.path, settings, onOpenHtmlFile);
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
  );
  return (
    <>
      <div className={compact ? "ctx-block" : "ctx-files-panel"}>
        {canSearchProject ? (
          <>
            <div className="ctx-file-search">
              <I.search size={14} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("contextPanel.fileSearchPlaceholder")}
                aria-label={t("contextPanel.fileSearchPlaceholder")}
              />
              {query ? (
                <button
                  type="button"
                  className="ctx-file-search-clear"
                  aria-label={t("contextPanel.clearSearch")}
                  title={t("contextPanel.clearSearch")}
                  onClick={() => setQuery("")}
                >
                  <I.x size={12} />
                </button>
              ) : null}
            </div>
            <div className="ctx-file-results">
              <div className="h">
                <span>{t("contextPanel.projectFilesTitle")}</span>
                <span className="right">
                  {mentionResults?.nonce === nonce
                    ? t("contextPanel.filesCount", { count: results.length })
                    : t("contextPanel.searching")}
                </span>
              </div>
              <div className="tree">
                {results.length === 0 && mentionResults?.nonce === nonce ? (
                  <div className="ctx-empty">{t("contextPanel.noProjectFilesMsg")}</div>
                ) : (
                  results.map((item) => (
                    <div
                      className="node"
                      data-kind={item.kind}
                      data-active={activePath === item.path}
                      data-jupiter-file-path={item.path}
                      title={item.raw}
                      key={`${item.raw}:${item.line ?? ""}`}
                      onContextMenu={(event) => {
                        if (item.kind === "dir") return;
                        event.preventDefault();
                        openMenuAt(item.path, event.clientX, event.clientY);
                      }}
                    >
                      <button
                        type="button"
                        className="node-main"
                        onClick={() => pickSearchItem(item)}
                      >
                        <span className="ico">
                          {item.kind === "dir" ? <I.folder size={12} /> : <I.file size={12} />}
                        </span>
                        <span className="node-text">
                          <span className="nm">{item.name}</span>
                          <span className="full-path">{item.desc ?? item.path}</span>
                        </span>
                      </button>
                      {item.kind === "file" ? (
                        <>
                          <button
                            type="button"
                            className="tree-action"
                            aria-label={t("contextPanel.library.addFileSource", {
                              path: item.path,
                            })}
                            title={t("contextPanel.library.addFileSource", {
                              path: item.path,
                            })}
                            disabled={!onAddLibrarySource}
                            onClick={(event) => {
                              event.stopPropagation();
                              addFileToLibrary(item.path);
                            }}
                          >
                            <I.plus size={12} />
                          </button>
                          <button
                            type="button"
                            className="tree-action"
                            aria-label={t("contextPanel.openFile", {
                              path: item.path,
                            })}
                            title={t("contextPanel.openFile", {
                              path: item.path,
                            })}
                            onClick={(event) => {
                              event.stopPropagation();
                              void openContextFile(item.path, settings, onOpenHtmlFile);
                            }}
                          >
                            <I.file size={12} />
                          </button>
                          <button
                            type="button"
                            className="tree-action"
                            aria-label={t("fileActions.menu", {
                              path: item.path,
                            })}
                            title={t("fileActions.menu", { path: item.path })}
                            onClick={(event) => {
                              event.stopPropagation();
                              openMenu(item.path, event.currentTarget);
                            }}
                          >
                            <I.more size={12} />
                          </button>
                        </>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        ) : null}
        <div className={canSearchProject ? "ctx-session-files" : undefined}>
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
                  renderFileNode(n)
                ),
              )
            )}
          </div>
        </div>
      </div>
      {menu ? (
        <FileActionMenu
          anchor={{ left: menu.left, top: menu.top }}
          path={menu.path}
          workspaceDir={workspaceDir}
          editor={editor}
          onPreviewFile={onPreviewFile}
          onOpenHtmlFile={onOpenHtmlFile}
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
  onOpenHtmlFile,
  full = false,
}: {
  preview: FilePreview | null;
  loading: boolean;
  error: string | null;
  fallbackPath?: string | null;
  workspaceDir?: string;
  editor?: string;
  onPreviewFile?: (target: FilePreviewTarget) => void;
  onOpenHtmlFile?: (target: FilePreviewTarget) => void;
  full?: boolean;
}) {
  const [menuAnchor, setMenuAnchor] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const path = preview?.path ?? fallbackPath;
  if (!path && !loading && !error) return null;
  const previewUrl = preview ? convertFileSrc(preview.absPath) : null;
  const richKind = preview
    ? previewRendererKind(preview.path, null)
    : path
      ? previewRendererKind(path, null)
      : "text";
  const shouldUseRichRenderer =
    preview &&
    (richKind === "pdf" ||
      richKind === "docx" ||
      richKind === "markdown" ||
      richKind === "image" ||
      richKind === "unsupported");
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
      {path ? (
        <div className="file-preview-path" data-jupiter-file-path={path}>
          {path}
        </div>
      ) : null}
      {meta.length > 0 ? <div className="file-preview-meta">{meta.join(" · ")}</div> : null}
      <div className="file-preview-body">
        {loading ? (
          <div className="ctx-empty">{t("fileActions.previewLoading")}</div>
        ) : error ? (
          <div className="ctx-empty">{t("fileActions.previewError", { message: error })}</div>
        ) : shouldUseRichRenderer ? (
          <FilePreviewRenderer
            path={preview.path}
            url={previewUrl ?? pathToFileUrl(preview.absPath)}
            text={preview.text}
            loadBytes={() => readFileBytes(preview.absPath, undefined)}
          />
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
          onOpenHtmlFile={onOpenHtmlFile}
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

function CtxSubagentDetail({ run }: { run?: SubagentRunInfo | null }) {
  if (!run) {
    return <div className="ctx-empty">{t("contextPanel.subagentsEmpty")}</div>;
  }
  const role = run.skillName?.trim() || t("contextPanel.subagentRoleFallback");
  const elapsed = formatElapsed(run.elapsedMs);
  const metrics = [
    subagentMeta(run),
    run.model ? `${t("settings.model")} ${run.model}` : null,
    typeof run.costUsd === "number" ? `$${run.costUsd.toFixed(4)}` : null,
    typeof run.outputChars === "number" ? `${run.outputChars.toLocaleString()} out` : null,
    typeof run.reasoningChars === "number"
      ? `${run.reasoningChars.toLocaleString()} reasoning`
      : null,
    typeof run.toolReadChars === "number" ? `${run.toolReadChars.toLocaleString()} read` : null,
    elapsed,
  ].filter(Boolean);
  return (
    <div className="ctx-subagent-detail">
      <div className="ctx-subagent-title-row">
        <span className="subagent-ico" aria-hidden="true">
          <I.bot size={15} />
        </span>
        <div>
          <div className="ctx-subagent-title">{run.task}</div>
          <div className="ctx-subagent-role">{role}</div>
        </div>
      </div>
      {metrics.length > 0 ? <div className="ctx-subagent-metrics">{metrics.join(" · ")}</div> : null}
      {run.summary ? (
        <div className="ctx-block">
          <div className="h">
            <span>{t("contextPanel.subagentSummary")}</span>
          </div>
          <div className="ctx-subagent-text">{run.summary}</div>
        </div>
      ) : null}
      {run.error ? (
        <div className="ctx-browser-error ctx-subagent-error">{run.error}</div>
      ) : null}
      <div className="ctx-subagent-note">{t("contextPanel.subagentSidebarHint")}</div>
    </div>
  );
}

function CtxTools({
  specs,
  bridged,
}: {
  specs: McpSpecInfo[];
  bridged: boolean;
}) {
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
              : t("contextPanel.mcpReadySome", {
                  ready: readyCount,
                  count: specs.length,
                })}
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
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
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
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
          }}
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
