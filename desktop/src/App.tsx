import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted as isNotificationPermissionGranted,
  requestPermission as requestNotificationPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { CommandPalette, Toast, buildCommands, useCommandPalette } from "./CommandPalette";
import { WorkspaceProvider } from "./Markdown";
import { type AbortDraftSource, nextAbortDraftCandidate, restoreAbortedDraft } from "./abort-draft";
import { DESKTOP_CLI_SLASH_COMMANDS, isKnownDesktopCliSlash, parseDesktopSlash } from "./cli-slash";
import type { DingTalkDesktopSettingsState } from "./dingtalk-settings";
import {
  type FilePreview,
  type FilePreviewTarget,
  pathToFileUrl,
  readFilePreview,
  resolveWorkspacePath,
  revealFileInFolder,
} from "./file-preview";
export { pathToFileUrl } from "./file-preview";
import type { FeishuDesktopSettingsState } from "./feishu-settings";
import { getLang, getLangLabel, getSupportedLangs, setLang, t, useLang } from "./i18n";
import { I } from "./icons";
import {
  type ApprovalSnapshot,
  deriveDesktopNotifications,
  dispatchDesktopNotifications,
  shouldShowCompletionToast,
} from "./notifications";
import { parseOneShotPlanCommand } from "./one-shot-plan";
import type {
  BrowserAutomationStatus,
  CheckpointVerdict,
  ChoiceVerdict,
  ConfirmationChoice,
  ExternalSessionApp,
  ExternalSessionCandidate,
  ExternalSessionSelection,
  IncomingEvent,
  JobInfo,
  LibrarySource,
  McpSpecInfo,
  MemoryDetail,
  MemoryEntryInfo,
  OutgoingCommand,
  PlanVerdict,
  RevisionVerdict,
  SettingsPatch,
  SkillPackSourceInfo,
  SkillInfo,
  SkillRootInfo,
  SourceIngestResultEvent,
  SourceSearchResultsEvent,
  StorageScanEvent,
  SubagentEvent,
  SubagentRunInfo,
  UpdateCheckEvent,
  UpdateReleaseUrls,
  WorkflowRun,
} from "./protocol";
import type { QQDesktopSettingsState } from "./qq-settings";
import {
  PANEL_SHORTCUT_MODES,
  matchDesktopShortcut,
  tabIndexFromShortcutAction,
} from "./shortcuts";
import {
  type SlashSettingsCommand,
  buildSlashSettingsDescriptors,
  parseSlashSettingsCommand,
} from "./slash-settings";
import {
  FONT_FAMILY,
  FONT_FAMILY_STACK,
  FONT_SCALE,
  FONT_SCALE_ZOOM,
  type FontFamily,
  type FontScale,
  THEME,
  type Theme,
  type ThemeStyle,
  defaultStyleForTheme,
  isFontFamily,
  isFontScale,
  isTheme,
  isThemeStyle,
  themeForStyle,
} from "./theme";
import { AboutModal } from "./ui/about";
import { AppContextMenu } from "./ui/app-context-menu";
import { WorkflowRunCard, parseEditResult } from "./ui/cards";
import {
  Composer,
  type ComposerSendPayload,
  type EditMode as DesktopEditMode,
  type SlashCmd,
} from "./ui/composer";
import {
  nextContextInfoToggle,
  nextContextSidebarToggle,
  nextSideChatSend,
} from "./ui/context-chrome";
import {
  type BrowserOpenRequest,
  ContextInfoPopover,
  ContextPanel,
  type ContextPanelMode,
  type ContextPanelTab,
} from "./ui/context-panel";
import { JobsPop } from "./ui/jobs-pop";
import { JumpBar } from "./ui/jump-bar";
import { useElapsed } from "./ui/live";
import { SettingsModal, type PageId as SettingsPageId } from "./ui/settings";
import { Sidebar } from "./ui/sidebar";
import { SourceSearchPopover } from "./ui/source-search-popover";
import { Splash, shouldShowSplash } from "./ui/splash";
import {
  StartupFailure,
  type StartupFailureState,
  coerceStartupFailure,
} from "./ui/startup-failure";
import { SettingsStatusCard } from "./ui/statusbar";
import { ThinkingBottomIndicator } from "./ui/thinking-indicator";
import {
  ActivePlanTaskCard,
  AssistantMsg,
  CheckpointApprovalCard,
  ChoiceApprovalCard,
  ConfirmApprovalCard,
  PathAccessApprovalCard,
  PlanApprovalCard,
  PlanBanner,
  RevisionApprovalCard,
  TurnDivider,
  UserMsg,
} from "./ui/thread";
import { getThreadMaxWidth, getVisibleContextWidth } from "./ui/thread-layout";
import { elideTranscriptMessages } from "./ui/transcript-elision";
import { useAutoCollapse } from "./ui/useAutoCollapse";
import { useDisableTextAssist } from "./ui/useDisableTextAssist";
import { useBottomResizable, useResizable } from "./ui/useResizable";
import {
  TRANSCRIPT_BOTTOM_THRESHOLD,
  followVirtuosoHeightChange,
  isScrollElementNearBottom,
  scrollVirtuosoToBottom,
} from "./ui/virtuoso-scroll";
import { WorkdirPop } from "./ui/workdir-pop";
import { displayWorkspaceBasename, displayWorkspacePath } from "./workspace-display";
import { BUILT_IN_WORKFLOWS } from "../../src/workflows/catalog";

const RIGHT_SIDEBAR_COLLAPSE_WIDTH = 1120;
const LEFT_SIDEBAR_COLLAPSE_WIDTH = 760;
const DEEPSEEK_API_KEYS_URL = "https://platform.deepseek.com/api_keys";

const RESPONSIVE_STAGE = {
  WIDE: "wide",
  COMPACT: "compact",
  NARROW: "narrow",
} as const;

export type SettingsToastKind = "model" | "reasoningEffort" | "editMode" | "language";

export function shouldShowSettingsChangeToast(_kind: SettingsToastKind): boolean {
  return false;
}

type ResponsiveStage = (typeof RESPONSIVE_STAGE)[keyof typeof RESPONSIVE_STAGE];

function responsiveStage(width: number): ResponsiveStage {
  if (width < LEFT_SIDEBAR_COLLAPSE_WIDTH) return RESPONSIVE_STAGE.NARROW;
  if (width < RIGHT_SIDEBAR_COLLAPSE_WIDTH) return RESPONSIVE_STAGE.COMPACT;
  return RESPONSIVE_STAGE.WIDE;
}

export type AssistantSegment =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      callId: string;
      name: string;
      args: string;
      startedAt: number;
      result?: string;
      ok?: boolean;
      durationMs?: number;
    };

export type SkillOrigin = {
  name: string;
  runAs: "inline" | "subagent";
};

export type ChatMessage =
  | {
      kind: "user";
      text: string;
      clientId: string;
      turn: number;
      rollbackable?: boolean;
      skill?: SkillOrigin;
    }
  | {
      kind: "assistant";
      turn: number;
      segments: AssistantSegment[];
      pending: boolean;
    }
  | { kind: "workflow"; run: WorkflowRun }
  | { kind: "status"; text: string }
  | { kind: "warning"; id: string; text: string; severity: "low" | "high" }
  | { kind: "error"; message: string; id: string; recoverable?: boolean };

export type SideChatEntry = {
  id: string;
  question: string;
  answer?: string;
  status: "pending" | "done";
};

export type PendingConfirm = {
  id: number;
  kind: "run_command" | "run_background";
  command: string;
  prompt: import("@jupiter/core-utils").ApprovalPrompt;
};

export type PendingPathAccess = {
  id: number;
  path: string;
  intent: "read" | "write";
  toolName: string;
  sandboxRoot: string;
  allowPrefix: string;
  prompt: import("@jupiter/core-utils").ApprovalPrompt;
};

export type PendingChoice = {
  id: number;
  question: string;
  options: { id: string; title: string; summary?: string }[];
  allowCustom: boolean;
};

export type PendingPlan = {
  id: number;
  plan: string;
  summary?: string;
  steps?: PlanStep[];
};

export type PlanStep = {
  id: string;
  title: string;
  action: string;
  risk?: "low" | "med" | "high";
};

export type ActivePlan = {
  plan: string;
  summary?: string;
  steps: PlanStep[];
  completedStepIds: string[];
  stepResults: Record<string, string>;
};

export type PendingCheckpoint = {
  id: number;
  stepId: string;
  title?: string;
  result: string;
  notes?: string;
  completed: number;
  total: number;
};

export type PendingRevision = {
  id: number;
  reason: string;
  remainingSteps: PlanStep[];
  summary?: string;
};

export type UsageStats = {
  totalCostUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  lastCallCacheHit: number | null;
  lastCallCacheMiss: number | null;
  /** System prompt + tool specs — constant for the session, sent on tab open. */
  reservedTokens: number;
  /** Current conversation log tokens, refreshed by the desktop sidecar. */
  liveLogTokens: number;
};

type WindowControls = Pick<
  ReturnType<typeof getCurrentWindow>,
  "isFullscreen" | "isMaximized" | "setFullscreen" | "toggleMaximize"
>;

export function readWindowExpanded(win: WindowControls, isMac: boolean): Promise<boolean> {
  return isMac ? win.isFullscreen() : win.isMaximized();
}

export function toggleWindowExpanded(
  win: WindowControls,
  isMac: boolean,
  expanded: boolean,
): Promise<void> {
  if (isMac) return win.setFullscreen(!expanded);
  return win.toggleMaximize();
}

export type SessionInfo = {
  name: string;
  path?: string;
  messageCount: number;
  mtime: string;
  summary?: string;
  workspace?: string;
  archivedAt?: number;
  pinnedAt?: number;
  unread?: boolean;
  workspaceStatus?: "matched" | "legacy_missing_meta";
};

export type Settings = {
  reasoningEffort: "low" | "medium" | "high" | "max";
  editMode: "review" | "auto" | "yolo" | "plan";
  budgetUsd: number | null;
  baseUrl?: string;
  apiKeyPrefix?: string;
  workspaceDir: string;
  recentWorkspaces: string[];
  model: string;
  editor?: string;
  desktopCloseBehavior?: "closeToTray" | "closeToQuit";
  webSearchEngine?:
    | "bing"
    | "bing-intl"
    | "searxng"
    | "metaso"
    | "baidu"
    | "tavily"
    | "perplexity"
    | "exa"
    | "brave"
    | "ollama";
  webSearchEndpoint?: string;
  browserAutomation?: BrowserAutomationStatus;
  skillPackSources?: SkillPackSourceInfo[];
  webSearchApiKeys?: {
    metaso?: string;
    baidu?: string;
    tavily?: string;
    perplexity?: string;
    exa?: string;
    ollama?: string;
    brave?: string;
  };
  subagentModels?: Record<string, "flash" | "pro">;
  /** Per-model context-window override (tokens). */
  contextTokens?: Record<string, number>;
  libraryRetrievalMode?: "off" | "on_demand" | "always";
  showSystemEvents?: boolean;
  processCardsDefaultOpen?: boolean;
  memoryConfirmWrites?: boolean;
  memoryGlobalEnabled?: boolean;
  promptHistory?: string[];
  version: string;
};

function desktopEditMode(mode?: Settings["editMode"]): DesktopEditMode {
  return mode === "auto" || mode === "yolo" ? mode : "review";
}

export type BalanceInfoItem = {
  currency: string;
  total: number;
  granted?: number;
  toppedUp?: number;
};

export type Balance = {
  currency: string;
  total: number;
  isAvailable: boolean;
  infos: BalanceInfoItem[];
};

type MentionResults = { nonce: number; query: string; results: string[] };
type MentionPreviewState = {
  nonce: number;
  path: string;
  head: string;
  totalLines: number;
};

type State = {
  ready: boolean;
  needsSetup: boolean;
  busy: boolean;
  transientStatus: string | null;
  model?: string;
  currentSession?: string;
  messages: ChatMessage[];
  pendingConfirms: PendingConfirm[];
  pendingPathAccess: PendingPathAccess[];
  pendingChoices: PendingChoice[];
  pendingPlans: PendingPlan[];
  pendingCheckpoints: PendingCheckpoint[];
  pendingRevisions: PendingRevision[];
  activePlan: ActivePlan | null;
  usage: UsageStats;
  sessions: SessionInfo[];
  archivedSessions: SessionInfo[];
  externalImportSources: ExternalSessionApp[];
  externalImportCandidates: ExternalSessionCandidate[];
  settings: Settings | null;
  qq: QQDesktopSettingsState | null;
  feishu: FeishuDesktopSettingsState | null;
  dingtalk: DingTalkDesktopSettingsState | null;
  balance: Balance | null;
  mentionResults: MentionResults | null;
  mentionPreview: MentionPreviewState | null;
  mcpSpecs: McpSpecInfo[];
  mcpBridged: boolean;
  subagents: SubagentRunInfo[];
  skills: SkillInfo[];
  skillRoots: SkillRootInfo[];
  /** Files the agent has read or modified this session — paths as the tool args provided them. */
  sessionFiles: SessionFile[];
  memory: MemoryEntryInfo[];
  memoryDetail: MemoryDetail | null;
  librarySources: LibrarySource[];
  storageScan: StorageScanEvent | null;
  sourceSearchResults: SourceSearchResultsEvent | null;
  sourceIngestResult: SourceIngestResultEvent | null;
  jobs: JobInfo[];
  /** Live "skill running" indicator — set when a `skill_run` RPC dispatches, cleared on `$turn_complete`. */
  activeSkill: SkillOrigin | null;
  /** Messages typed while busy=true — auto-sent FIFO once the current turn completes. Cleared on `clear`, `rpc_exit`, `session_loaded`. */
  queuedSends: string[];
  /** Temporary blank-slate side questions shown only in the right sidebar. */
  sideChats: SideChatEntry[];
  /** Populated by $retry_result — component useEffect reads and sets composer draft. */
  retryText?: string;
  retryNonce: number;
};

export type SessionFile = {
  path: string;
  /** "c": pulled into context (read_file). "m": modified by the agent (edit_file / write_file / multi_edit). */
  status: "c" | "m";
};

type LibrarySourceInput = Omit<LibrarySource, "id" | "addedAt">;

function libraryStorageKeyForWorkspace(workspaceDir?: string | null): string | null {
  if (!workspaceDir) return null;
  return `jupiter.library.sources:${workspaceDir}`;
}

export function pickEmptySuggestions(
  pool: readonly string[],
  count = 4,
  random: () => number = Math.random,
): string[] {
  const items = Array.from(new Set(pool.map((item) => item.trim()).filter(Boolean)));
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = items[i];
    items[i] = items[j]!;
    items[j] = tmp!;
  }
  return items.slice(0, Math.max(0, Math.min(count, items.length)));
}

function librarySourceIdentity(source: LibrarySourceInput | LibrarySource): string {
  if (source.kind === "web") return `web:${source.url}`;
  return `file:${source.path}`;
}

function filePathToLibrarySource(path: string): LibrarySourceInput {
  const normalized = path.replace(/\\/g, "/");
  const title = normalized.split("/").filter(Boolean).pop() || normalized;
  return {
    kind: "file",
    title,
    path: normalized,
    snippet: normalized,
  };
}

function titleFromBrowserUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") {
      return parsed.pathname.split("/").filter(Boolean).pop() || url;
    }
    return parsed.hostname || url;
  } catch {
    return url;
  }
}

function fileUrlToPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const decodedPath = decodeURIComponent(url.pathname);
    if (url.hostname) return `//${url.hostname}${decodedPath}`;
    return decodedPath.replace(/^\/([A-Za-z]:\/)/, "$1");
  } catch {
    return null;
  }
}

function normalizeLibraryFilePath(path: string, workspaceDir?: string): string {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedWorkspace = workspaceDir?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (
    normalizedWorkspace &&
    (normalizedPath === normalizedWorkspace || normalizedPath.startsWith(`${normalizedWorkspace}/`))
  ) {
    return normalizedPath.slice(normalizedWorkspace.length).replace(/^\/+/, "") || ".";
  }
  return normalizedPath;
}

function stripLibraryFileReference(raw: string): string {
  let value = raw.trim().replace(/^@/, "");
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("`") && value.endsWith("`"))
  ) {
    value = value.slice(1, -1);
  }
  value = value.replace(/[),.;，。！？!?]+$/g, "");
  value = fileUrlToPath(value) ?? value;
  value = value.replace(/(?<!^[A-Za-z]):\d+$/g, "");
  return value.trim();
}

function shouldAddLibraryFilesFromText(text: string): boolean {
  const lower = text.toLowerCase();
  const hasLibraryTarget =
    lower.includes("library") ||
    lower.includes("source") ||
    text.includes("资料库") ||
    text.includes("資料庫");
  const hasAddIntent = /\b(add|save|import)\b/.test(lower) || /添加|加入|导入|導入|保存/.test(text);
  return hasLibraryTarget && hasAddIntent;
}

function extractLibraryFileReferences(text: string, workspaceDir?: string): string[] {
  if (!shouldAddLibraryFilesFromText(text)) return [];
  const seen = new Set<string>();
  const paths: string[] = [];
  const add = (raw: string) => {
    const stripped = stripLibraryFileReference(raw);
    if (!stripped || /^https?:\/\//i.test(stripped)) return;
    const normalized = normalizeLibraryFilePath(stripped, workspaceDir);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    paths.push(normalized);
  };

  for (const match of text.matchAll(/(?:^|\s)@("[^"]+"|'[^']+'|`[^`]+`|[^\s]+)/g)) {
    add(match[1] ?? "");
  }
  for (const match of text.matchAll(/file:\/\/[^\s]+/g)) {
    add(match[0]);
  }
  return paths;
}

function parseLibrarySources(raw: string | null): LibrarySource[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is LibrarySource => {
      if (!item || typeof item !== "object") return false;
      const source = item as Partial<LibrarySource>;
      if (typeof source.id !== "string") return false;
      if (typeof source.title !== "string") return false;
      if (typeof source.addedAt !== "number") return false;
      if (source.kind === "web") return typeof source.url === "string";
      if (source.kind === "file") return typeof source.path === "string";
      return false;
    });
  } catch {
    return [];
  }
}

function tabBusyFromIncomingEvent(ev: IncomingEvent): boolean | null {
  switch (ev.type) {
    case "$tab_opened":
      return ev.busy ?? null;
    case "$session_loaded":
      return ev.busy ?? false;
    case "$session_empty":
    case "$turn_complete":
    case "$error":
    case "error":
      return false;
    case "user.message":
    case "model.turn.started":
    case "model.delta":
    case "model.final":
    case "tool.preparing":
    case "tool.intent":
    case "tool.result":
      return true;
    default:
      return null;
  }
}

type Action =
  | { t: "send_user"; text: string; clientId: string; rollbackable?: boolean }
  | { t: "start_skill"; skill: SkillOrigin; args?: string; clientId: string }
  | { t: "incoming"; event: IncomingEvent }
  | { t: "set_busy"; busy: boolean }
  | { t: "rpc_exit"; code: number | null }
  | { t: "clear" }
  | { t: "resolve_confirm"; id: number }
  | { t: "resolve_path_access"; id: number }
  | { t: "resolve_choice"; id: number }
  | { t: "resolve_plan"; id: number; verdict: PlanVerdict }
  | { t: "resolve_checkpoint"; id: number; verdict: CheckpointVerdict }
  | { t: "resolve_revision"; id: number; verdict: RevisionVerdict }
  | { t: "dismiss_plan" }
  | { t: "dismiss_error"; id: string }
  | { t: "mention_results"; results: MentionResults }
  | { t: "mention_preview"; preview: MentionPreviewState }
  | { t: "enqueue_send"; text: string }
  | { t: "dequeue_send"; index: number }
  | { t: "prioritize_queued_send"; index: number }
  | { t: "shift_queued_send" }
  | { t: "side_chat_sent"; id: string; question: string }
  | { t: "settings_patch"; patch: SettingsPatch }
  | { t: "push_status"; text: string };

function sanitizeSettingsPatch(patch: SettingsPatch): Partial<Settings> {
  const {
    metasoApiKey: _metaso,
    baiduApiKey: _baidu,
    tavilyApiKey: _tavily,
    perplexityApiKey: _perplexity,
    exaApiKey: _exa,
    ollamaApiKey: _ollama,
    webSearchEndpoint,
    ...rest
  } = patch;
  const sanitized: Partial<Settings> = { ...rest };
  if (webSearchEndpoint !== undefined) {
    sanitized.webSearchEndpoint = webSearchEndpoint ?? undefined;
  }
  return sanitized;
}

function fallbackSkillDesc(skill: SkillInfo): string {
  const scope =
    skill.scope === "builtin"
      ? t("app.skill.scope.builtin")
      : skill.scope === "global"
        ? t("app.skill.scope.global")
        : t("app.skill.scope.project");
  const runAs =
    skill.runAs === "subagent" ? t("app.skill.runAs.subagent") : t("app.skill.runAs.inline");
  return t("app.skill.generic", { scope, runAs });
}

function isCommandEchoClientId(clientId: string): boolean {
  return /^(slash|btw|skill)-/.test(clientId);
}

function isRollbackableUserMessage(
  message: ChatMessage,
): message is Extract<ChatMessage, { kind: "user" }> {
  return (
    message.kind === "user" &&
    message.rollbackable !== false &&
    !isCommandEchoClientId(message.clientId)
  );
}

function isConversationTurnMessage(message: ChatMessage): boolean {
  return isRollbackableUserMessage(message) || (message.kind === "assistant" && !message.pending);
}

function latestConversationTurn(messages: ChatMessage[]): number {
  const lastTurn = messages.reduce((max, m) => {
    if (isRollbackableUserMessage(m) || m.kind === "assistant") return Math.max(max, m.turn);
    return max;
  }, 0);
  return lastTurn;
}

function nextMessageTurn(messages: ChatMessage[]): number {
  return latestConversationTurn(messages) + 1;
}

export function chatMessageKey(message: ChatMessage | undefined, index: number): string {
  if (!message) return `missing-${index}`;
  switch (message.kind) {
    case "user":
      return `user-${message.clientId || message.turn}`;
    case "assistant":
      return `assistant-${message.turn}`;
    case "workflow":
      return `workflow-${message.run.id}`;
    case "warning":
      return `warning-${message.id}`;
    case "error":
      return `error-${message.id}`;
    case "status":
      return `status-${index}-${message.text.slice(0, 80)}`;
  }
}

export function canRollbackMessage(messages: ChatMessage[], index: number, busy: boolean): boolean {
  if (busy || index < 0 || index >= messages.length - 1) return false;
  const message = messages[index];
  if (!message || (message.kind !== "user" && message.kind !== "assistant")) return false;
  if (message.kind === "user" && !isRollbackableUserMessage(message)) return false;
  if (message.kind === "assistant" && message.pending) return false;
  return messages.slice(index + 1).some(isConversationTurnMessage);
}

export function rollbackTargetForMessage(
  messages: ChatMessage[],
  index: number,
): { turn: number; role: "user" | "assistant" } | null {
  const message = messages[index];
  if (!message || (message.kind !== "user" && message.kind !== "assistant")) return null;
  if (message.kind === "user" && !isRollbackableUserMessage(message)) return null;
  if (message.kind === "assistant" && message.pending) return null;

  let turn = 0;
  for (let i = 0; i <= index; i++) {
    const current = messages[i];
    if (current && isRollbackableUserMessage(current)) turn += 1;
  }
  if (message.kind === "assistant" && turn === 0) return null;
  if (message.kind === "user" && turn < 1) return null;
  return { turn, role: message.kind };
}

let _errSeq = 0;
function nextErrorId(): string {
  _errSeq += 1;
  return `err-${Date.now().toString(36)}-${_errSeq}`;
}

function upsertWorkflowRunMessage(messages: ChatMessage[], run: WorkflowRun): ChatMessage[] {
  const index = messages.findIndex((message) => message.kind === "workflow" && message.run.id === run.id);
  if (index < 0) return [...messages, { kind: "workflow", run }];
  const next = [...messages];
  next[index] = { kind: "workflow", run };
  return next;
}

export function reduce(state: State, action: Action): State {
  return withElidedTranscript(reduceRaw(state, action));
}

function reduceRaw(state: State, action: Action): State {
  switch (action.t) {
    case "send_user": {
      const rollbackable = action.rollbackable !== false;
      const turn = rollbackable
        ? nextMessageTurn(state.messages)
        : Math.max(1, latestConversationTurn(state.messages));
      return {
        ...state,
        busy: true,
        messages: [
          ...state.messages,
          {
            kind: "user",
            text: action.text,
            clientId: action.clientId,
            turn,
            ...(rollbackable ? {} : { rollbackable: false }),
          },
        ],
      };
    }
    case "start_skill": {
      const argsLine = action.args ? ` ${action.args}` : "";
      return {
        ...state,
        busy: true,
        activeSkill: action.skill,
        messages: [
          ...state.messages,
          {
            kind: "user",
            text: `/${action.skill.name}${argsLine}`,
            clientId: action.clientId,
            turn: Math.max(1, latestConversationTurn(state.messages)),
            rollbackable: false,
            skill: action.skill,
          },
        ],
      };
    }
    case "rpc_exit":
      return {
        ...state,
        ready: false,
        busy: false,
        transientStatus: null,
        activeSkill: null,
        queuedSends: [],
        sideChats: [],
        messages: [
          ...state.messages,
          {
            kind: "error",
            message: `jupiter exited (code ${action.code ?? "?"})`,
            id: nextErrorId(),
          },
        ],
      };
    case "incoming":
      return applyIncoming(state, action.event);
    case "set_busy":
      return {
        ...state,
        busy: action.busy,
        transientStatus: action.busy ? state.transientStatus : null,
        activeSkill: action.busy ? state.activeSkill : null,
      };
    case "settings_patch":
      return state.settings
        ? {
            ...state,
            settings: {
              ...state.settings,
              ...sanitizeSettingsPatch(action.patch),
            },
          }
        : state;
    case "clear":
      return {
        ...state,
        busy: false,
        transientStatus: null,
        currentSession: undefined,
        messages: [],
        pendingConfirms: [],
        pendingPathAccess: [],
        pendingChoices: [],
        pendingPlans: [],
        pendingCheckpoints: [],
        pendingRevisions: [],
        activePlan: null,
        usage: zeroUsage(),
        sessionFiles: [],
        subagents: [],
        activeSkill: null,
        queuedSends: [],
        sideChats: [],
        librarySources: [],
        storageScan: null,
        sourceSearchResults: null,
        sourceIngestResult: null,
        retryNonce: 0,
      };
    case "resolve_confirm":
      return {
        ...state,
        pendingConfirms: state.pendingConfirms.filter((c) => c.id !== action.id),
      };
    case "resolve_path_access":
      return {
        ...state,
        pendingPathAccess: state.pendingPathAccess.filter((p) => p.id !== action.id),
      };
    case "resolve_choice":
      return {
        ...state,
        pendingChoices: state.pendingChoices.filter((c) => c.id !== action.id),
      };
    case "resolve_plan": {
      const removed = state.pendingPlans.find((p) => p.id === action.id);
      let activePlan = state.activePlan;
      if (removed && action.verdict.type === "approve") {
        const pendingSteps = (removed as PendingPlan & { steps?: PlanStep[] }).steps;
        activePlan = {
          plan: removed.plan,
          summary: removed.summary,
          steps: pendingSteps ?? [],
          completedStepIds: [],
          stepResults: {},
        };
      }
      return {
        ...state,
        pendingPlans: state.pendingPlans.filter((p) => p.id !== action.id),
        activePlan,
      };
    }
    case "resolve_checkpoint":
      return {
        ...state,
        pendingCheckpoints: state.pendingCheckpoints.filter((c) => c.id !== action.id),
      };
    case "resolve_revision": {
      const removed = state.pendingRevisions.find((r) => r.id === action.id);
      let activePlan = state.activePlan;
      if (removed && action.verdict.type === "accepted" && activePlan) {
        const doneIds = new Set(activePlan.completedStepIds);
        const keptDone = activePlan.steps.filter((s) => doneIds.has(s.id));
        activePlan = {
          ...activePlan,
          steps: [...keptDone, ...removed.remainingSteps],
        };
      }
      return {
        ...state,
        pendingRevisions: state.pendingRevisions.filter((r) => r.id !== action.id),
        activePlan,
      };
    }
    case "dismiss_plan":
      return { ...state, activePlan: null };
    case "dismiss_error":
      return {
        ...state,
        messages: state.messages.filter((m) => !(m.kind === "error" && m.id === action.id)),
      };
    case "mention_results":
      return { ...state, mentionResults: action.results };
    case "mention_preview":
      return { ...state, mentionPreview: action.preview };
    case "enqueue_send":
      return { ...state, queuedSends: [...state.queuedSends, action.text] };
    case "dequeue_send":
      return {
        ...state,
        queuedSends: state.queuedSends.filter((_, i) => i !== action.index),
      };
    case "prioritize_queued_send": {
      const picked = state.queuedSends[action.index];
      if (!picked || action.index <= 0) return state;
      return {
        ...state,
        queuedSends: [picked, ...state.queuedSends.filter((_, i) => i !== action.index)],
      };
    }
    case "shift_queued_send":
      return { ...state, queuedSends: state.queuedSends.slice(1) };
    case "side_chat_sent":
      return {
        ...state,
        sideChats: [
          ...state.sideChats,
          { id: action.id, question: action.question, status: "pending" },
        ],
      };
    case "push_status":
      return {
        ...state,
        messages: [...state.messages, { kind: "status", text: action.text }],
      };
  }
}

function withElidedTranscript(state: State): State {
  const messages = elideTranscriptMessages(state.messages);
  return messages === state.messages ? state : { ...state, messages };
}

const READING_TOOLS = new Set(["read_file"]);
const MODIFYING_TOOLS = new Set(["edit_file", "write_file"]);

type FileStat = { filename: string; added: number; removed: number };
type FileStats = {
  entries: FileStat[];
  totalAdded: number;
  totalRemoved: number;
};

function countFileStats(segments: AssistantSegment[]): FileStats | null {
  const entries: FileStat[] = [];
  for (const s of segments) {
    if (s.kind !== "tool" || !s.result || s.ok === false) continue;
    if (s.name === "edit_file" || s.name === "multi_edit") {
      for (const f of parseEditResult(s.result)) {
        let added = 0;
        let removed = 0;
        for (const ln of f.lines) {
          if (ln.t === "add") added++;
          else if (ln.t === "rm") removed++;
        }
        entries.push({ filename: f.filename, added, removed });
      }
    } else if (s.name === "write_file") {
      let lines = 0;
      try {
        const parsed = JSON.parse(s.args);
        if (typeof parsed.content === "string") {
          lines = parsed.content.split("\n").length;
        }
      } catch {
        /* args unparseable */
      }
      let filename = "";
      try {
        filename = JSON.parse(s.args)?.path ?? "";
      } catch {
        /* ignore */
      }
      entries.push({ filename, added: lines, removed: 0 });
    }
  }
  if (entries.length === 0) return null;
  const totalAdded = entries.reduce((s, e) => s + e.added, 0);
  const totalRemoved = entries.reduce((s, e) => s + e.removed, 0);
  return { entries, totalAdded, totalRemoved };
}

function DiffStats({ stats }: { stats: FileStats }) {
  const [open, setOpen] = useState(false);
  const total = stats.entries.length;
  return (
    <div className="diff-stats">
      <button type="button" className="diff-stats-head" onClick={() => setOpen((v) => !v)}>
        <span className="ico">
          <I.diff size={11} />
        </span>
        <span>
          {total} {total === 1 ? "file" : "files"} changed · +{stats.totalAdded} / −
          {stats.totalRemoved} {stats.totalRemoved === 1 ? "line" : "lines"}
        </span>
        <span className="chev">{open ? <I.chev size={10} /> : <I.chevR size={10} />}</span>
      </button>
      {open ? (
        <div className="diff-stats-body">
          {stats.entries.map((e) => (
            <div key={e.filename} className="diff-stats-row">
              <span className="fn">{e.filename}</span>
              <span className="counts">
                <span className="add">+{e.added}</span>
                {e.removed > 0 ? <span className="rm"> / −{e.removed}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function extractToolFiles(name: string, args: string): SessionFile[] {
  try {
    const parsed = JSON.parse(args) as { path?: unknown; edits?: unknown };
    if (READING_TOOLS.has(name) && typeof parsed?.path === "string") {
      return [{ path: parsed.path, status: "c" }];
    }
    if (MODIFYING_TOOLS.has(name) && typeof parsed?.path === "string") {
      return [{ path: parsed.path, status: "m" }];
    }
    if (name === "multi_edit" && Array.isArray(parsed?.edits)) {
      const out: SessionFile[] = [];
      const seen = new Set<string>();
      for (const e of parsed.edits as Array<{ path?: unknown }>) {
        if (typeof e?.path === "string" && !seen.has(e.path)) {
          seen.add(e.path);
          out.push({ path: e.path, status: "m" });
        }
      }
      return out;
    }
  } catch {
    // malformed args — skip; tool will error on the real side anyway
  }
  return [];
}

function mergeSessionFiles(existing: SessionFile[], adds: SessionFile[]): SessionFile[] {
  if (adds.length === 0) return existing;
  const next = [...existing];
  const indexByPath = new Map<string, number>();
  next.forEach((f, i) => indexByPath.set(f.path, i));
  let changed = false;
  for (const add of adds) {
    const idx = indexByPath.get(add.path);
    if (idx === undefined) {
      indexByPath.set(add.path, next.length);
      next.push(add);
      changed = true;
      continue;
    }
    const prev = next[idx];
    if (!prev || prev.status === "m") continue; // never downgrade m → c
    if (prev.status === add.status) continue;
    next[idx] = add;
    changed = true;
  }
  return changed ? next : existing;
}

function zeroUsage(): UsageStats {
  return {
    totalCostUsd: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    lastCallCacheHit: null,
    lastCallCacheMiss: null,
    reservedTokens: 0,
    liveLogTokens: 0,
  };
}

function appendTextSegment(
  segments: AssistantSegment[],
  kind: "text" | "reasoning",
  text: string,
): AssistantSegment[] {
  const last = segments[segments.length - 1];
  if (last && last.kind === kind) {
    return [...segments.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...segments, { kind, text }];
}

function mergeFinalTextSegment(segments: AssistantSegment[], text: string): AssistantSegment[] {
  if (!text) return segments;
  let lastToolIndex = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]?.kind === "tool") {
      lastToolIndex = i;
      break;
    }
  }
  for (let i = segments.length - 1; i > lastToolIndex; i--) {
    const segment = segments[i];
    if (segment?.kind !== "text") continue;
    if (segment.text === text) return segments;
    const next = [...segments];
    next[i] = { ...segment, text };
    return next;
  }
  return [...segments, { kind: "text", text }];
}

function mergeFinalReasoningSegment(
  segments: AssistantSegment[],
  text?: string,
): AssistantSegment[] {
  if (!text) return segments;
  let lastToolIndex = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]?.kind === "tool") {
      lastToolIndex = i;
      break;
    }
  }
  for (let i = lastToolIndex + 1; i < segments.length; i++) {
    const segment = segments[i];
    if (segment?.kind !== "reasoning") continue;
    if (segment.text === text) return segments;
    const next = [...segments];
    next[i] = { ...segment, text };
    return next;
  }
  let insertAt = segments.length;
  for (let i = lastToolIndex + 1; i < segments.length; i++) {
    if (segments[i]?.kind === "text") {
      insertAt = i;
      break;
    }
  }
  return [...segments.slice(0, insertAt), { kind: "reasoning", text }, ...segments.slice(insertAt)];
}

function mergeFinalSegments(
  segments: AssistantSegment[],
  ev: { content: string; reasoningContent?: string },
): AssistantSegment[] {
  const withReasoning = mergeFinalReasoningSegment(segments, ev.reasoningContent);
  return mergeFinalTextSegment(withReasoning, ev.content);
}

function sessionFilesForMessages(messages: ChatMessage[]): SessionFile[] {
  let sessionFiles: SessionFile[] = [];
  for (const m of messages) {
    if (m.kind !== "assistant") continue;
    for (const s of m.segments) {
      if (s.kind !== "tool") continue;
      sessionFiles = mergeSessionFiles(sessionFiles, extractToolFiles(s.name, s.args));
    }
  }
  return sessionFiles;
}

export function applyIncoming(state: State, ev: IncomingEvent): State {
  return withElidedTranscript(applyIncomingRaw(state, ev));
}

type SessionSnapshotEvent = Extract<
  IncomingEvent,
  { type: "$session_loaded" | "$session_reconciled" }
>;

function applySessionSnapshot(
  state: State,
  ev: SessionSnapshotEvent,
  opts: { resetUi: boolean },
): State {
  const sessionName = ev.name;
  let loadedUserTurn = 0;
  const loaded: ChatMessage[] = ev.messages.map((m, i) => {
    if (m.kind === "user") {
      loadedUserTurn += 1;
      return {
        kind: "user",
        text: m.text,
        clientId: `c-loaded-${i}`,
        turn: loadedUserTurn,
      };
    }
    const segments: AssistantSegment[] = m.segments.map((s) => {
      if (s.kind === "tool") {
        return {
          kind: "tool",
          callId: s.callId,
          name: s.name,
          args: s.args,
          startedAt: 0,
          result: s.result,
          ok: s.ok,
          durationMs: 0,
        };
      }
      return s;
    });
    return { kind: "assistant", turn: m.turn, segments, pending: false };
  });
  const usage = {
    ...zeroUsage(),
    totalCostUsd: ev.carryover.totalCostUsd,
    totalPromptTokens: ev.carryover.cacheHitTokens + ev.carryover.cacheMissTokens,
    totalCompletionTokens: ev.carryover.totalCompletionTokens ?? 0,
    cacheHitTokens: ev.carryover.cacheHitTokens,
    cacheMissTokens: ev.carryover.cacheMissTokens,
  };
  if (!opts.resetUi) {
    const nextMessages = shouldKeepCurrentMessagesForReconcile(state.messages, loaded)
      ? state.messages
      : loaded;
    const sessionFiles = sessionFilesForMessages(nextMessages);
    return {
      ...state,
      currentSession: sessionName,
      messages: nextMessages,
      usage,
      sessionFiles,
      transientStatus: null,
    };
  }
  const keepLiveMessages =
    Boolean(ev.busy) && shouldKeepCurrentMessagesForReconcile(state.messages, loaded);
  const nextMessages = keepLiveMessages ? state.messages : loaded;
  return {
    ...state,
    busy: ev.busy ?? false,
    transientStatus: keepLiveMessages ? state.transientStatus : null,
    currentSession: sessionName,
    messages: nextMessages,
    pendingConfirms: keepLiveMessages ? state.pendingConfirms : [],
    pendingPathAccess: keepLiveMessages ? state.pendingPathAccess : [],
    pendingChoices: keepLiveMessages ? state.pendingChoices : [],
    pendingPlans: keepLiveMessages ? state.pendingPlans : [],
    pendingCheckpoints: keepLiveMessages ? state.pendingCheckpoints : [],
    pendingRevisions: keepLiveMessages ? state.pendingRevisions : [],
    activePlan: keepLiveMessages ? state.activePlan : null,
    usage,
    sessionFiles: sessionFilesForMessages(nextMessages),
    subagents: keepLiveMessages ? state.subagents : [],
    activeSkill: ev.busy ? state.activeSkill : null,
    queuedSends: keepLiveMessages ? state.queuedSends : [],
    sideChats: keepLiveMessages ? state.sideChats : [],
    retryNonce: keepLiveMessages ? state.retryNonce : 0,
  };
}

function assistantTextLengthForTurn(messages: ChatMessage[], turn: number): number {
  const assistant = [...messages].reverse().find((m) => m.kind === "assistant" && m.turn === turn);
  if (!assistant || assistant.kind !== "assistant") return 0;
  return assistant.segments.reduce((sum, segment) => {
    if (segment.kind === "text" || segment.kind === "reasoning") return sum + segment.text.length;
    if (segment.kind === "tool")
      return sum + segment.args.length + (segment.result ? segment.result.length : 0);
    return sum;
  }, 0);
}

function latestAssistantTurn(messages: ChatMessage[]): number {
  return messages.reduce((max, m) => (m.kind === "assistant" ? Math.max(max, m.turn) : max), 0);
}

function latestPendingAssistantTurn(messages: ChatMessage[]): number {
  return messages.reduce(
    (max, m) => (m.kind === "assistant" && m.pending ? Math.max(max, m.turn) : max),
    0,
  );
}

function latestUserIndexForTurn(messages: ChatMessage[], turn: number): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.kind === "user" && message.turn === turn) return i;
  }
  return -1;
}

function latestAssistantIndexForLiveTurn(messages: ChatMessage[], turn: number): number {
  const userIndex = latestUserIndexForTurn(messages, turn);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.kind !== "assistant" || message.turn !== turn) continue;
    if (userIndex >= 0 && i < userIndex) continue;
    return i;
  }
  return -1;
}

function shouldKeepCurrentMessagesForReconcile(
  current: ChatMessage[],
  loaded: ChatMessage[],
): boolean {
  const currentTurn = latestConversationTurn(current);
  const loadedTurn = latestConversationTurn(loaded);
  if (loadedTurn < currentTurn) return true;

  const currentAssistantTurn = latestAssistantTurn(current);
  const loadedAssistantTurn = latestAssistantTurn(loaded);
  const pendingAssistantTurn = latestPendingAssistantTurn(current);
  if (pendingAssistantTurn > 0) {
    if (loadedAssistantTurn < pendingAssistantTurn) return true;
    return (
      assistantTextLengthForTurn(loaded, pendingAssistantTurn) <=
      assistantTextLengthForTurn(current, pendingAssistantTurn)
    );
  }
  if (loadedAssistantTurn < currentAssistantTurn) return true;
  return (
    currentAssistantTurn > 0 &&
    loadedAssistantTurn === currentAssistantTurn &&
    assistantTextLengthForTurn(loaded, currentAssistantTurn) <
      assistantTextLengthForTurn(current, currentAssistantTurn)
  );
}

export function shouldShowThinkingFooter(messages: ChatMessage[], busy: boolean): boolean {
  if (!busy) return false;
  const pendingAssistant = [...messages].reverse().find((m) => m.kind === "assistant" && m.pending);
  if (!pendingAssistant || pendingAssistant.kind !== "assistant") return true;
  return !pendingAssistant.segments.some((segment) => {
    if (segment.kind === "tool") return true;
    if (segment.kind === "text") return segment.text.trim().length > 0;
    return false;
  });
}

export function reduceSubagentRuns(
  prev: SubagentRunInfo[],
  ev: SubagentEvent,
  currentSession?: string,
): SubagentRunInfo[] {
  if (!currentSession && ev.parentSession) return prev;
  if (currentSession && ev.parentSession && ev.parentSession !== currentSession) {
    return prev;
  }

  const idx = prev.findIndex((run) => run.runId === ev.runId);
  const current = idx >= 0 ? prev[idx] : undefined;
  if (!current && ev.kind !== "start" && ev.kind !== "end") return prev;

  const base: SubagentRunInfo = current ?? {
    runId: ev.runId,
    parentSession: ev.parentSession,
    sessionName: ev.sessionName,
    task: ev.task,
    skillName: ev.skillName,
    model: ev.model,
    status: ev.kind === "end" ? (ev.error ? "failed" : "done") : "running",
    phase: "exploring",
    iter: 0,
    elapsedMs: 0,
    outputChars: 0,
    reasoningChars: 0,
    toolReadChars: 0,
  };

  const next: SubagentRunInfo = {
    ...base,
    parentSession: ev.parentSession ?? base.parentSession,
    sessionName: ev.sessionName ?? base.sessionName,
    task: ev.task || base.task,
    skillName: ev.skillName ?? base.skillName,
    model: ev.model ?? base.model,
    status:
      ev.kind === "end"
        ? ev.error
          ? "failed"
          : "done"
        : ev.kind === "start"
          ? "running"
          : base.status,
    phase: ev.phase ?? base.phase,
    iter: ev.iter ?? base.iter,
    elapsedMs: ev.elapsedMs ?? base.elapsedMs,
    summary: ev.summary ?? base.summary,
    error: ev.error ?? base.error,
    turns: ev.turns ?? base.turns,
    costUsd: ev.costUsd ?? base.costUsd,
    outputChars: ev.outputChars ?? base.outputChars,
    reasoningChars: ev.reasoningChars ?? base.reasoningChars,
    toolReadChars: ev.toolReadChars ?? base.toolReadChars,
  };

  const out = [...prev];
  if (idx >= 0) out[idx] = next;
  else out.push(next);
  return out;
}

function applyIncomingRaw(state: State, ev: IncomingEvent): State {
  switch (ev.type) {
    case "user.message": {
      if (ev.clientId) {
        const existingIndex = state.messages.findIndex(
          (m) => m.kind === "user" && m.clientId === ev.clientId,
        );
        if (existingIndex >= 0) {
          const messages = [...state.messages];
          const existing = messages[existingIndex]!;
          if (existing.kind === "user") {
            const existingUser = { ...existing };
            delete existingUser.rollbackable;
            messages[existingIndex] = {
              ...existingUser,
              text: ev.text,
              turn: ev.turn > 0 ? ev.turn : existing.turn,
            };
          }
          return { ...state, busy: true, messages };
        }
      }
      return {
        ...state,
        busy: true,
        messages: [
          ...state.messages,
          {
            kind: "user",
            text: ev.text,
            clientId: ev.clientId ?? `remote-${ev.id}`,
            turn: ev.turn > 0 ? ev.turn : nextMessageTurn(state.messages),
          },
        ],
      };
    }
    case "$ready":
      return { ...state, ready: true, needsSetup: false };
    case "$needs_setup":
      return { ...state, needsSetup: true, ready: false };
    case "workflow_started":
    case "workflow_phase_changed":
    case "workflow_log":
    case "workflow_agent_started":
    case "workflow_agent_updated":
    case "workflow_agent_completed":
    case "workflow_token_usage":
    case "workflow_waiting_approval":
    case "workflow_completed":
    case "workflow_failed":
    case "workflow_canceled":
      return { ...state, messages: upsertWorkflowRunMessage(state.messages, ev.run) };
    case "$turn_complete":
      // Clear pause-gate-tied modals too. By the time the loop emits
      // $turn_complete, anything still in these arrays is orphaned — the
      // tool call that opened it has either resolved (so it's gone already)
      // or the turn was aborted (so the model isn't coming back for it).
      // Without this, an Esc/abort during plan approval leaves the plan
      // card rendered AFTER state.messages forever; the queued user input
      // that drains next then appears above the zombie card (#1456).
      return {
        ...state,
        busy: false,
        transientStatus: null,
        activeSkill: null,
        pendingConfirms: [],
        pendingPathAccess: [],
        pendingChoices: [],
        pendingPlans: [],
        pendingCheckpoints: [],
        pendingRevisions: [],
      };
    case "$confirm_required":
      return {
        ...state,
        pendingConfirms: [
          ...state.pendingConfirms,
          { id: ev.id, kind: ev.kind, command: ev.command, prompt: ev.prompt! },
        ],
      };
    case "$path_access_required":
      return {
        ...state,
        pendingPathAccess: [
          ...state.pendingPathAccess,
          {
            id: ev.id,
            path: ev.path,
            intent: ev.intent,
            toolName: ev.toolName,
            sandboxRoot: ev.sandboxRoot,
            allowPrefix: ev.allowPrefix,
            prompt: ev.prompt!,
          },
        ],
      };
    case "$choice_required":
      return {
        ...state,
        pendingChoices: [
          ...state.pendingChoices,
          {
            id: ev.id,
            question: ev.question,
            options: ev.options,
            allowCustom: ev.allowCustom,
          },
        ],
      };
    case "$plan_required": {
      const steps = Array.isArray(ev.steps) ? (ev.steps as PlanStep[]) : undefined;
      return {
        ...state,
        pendingPlans: [
          ...state.pendingPlans,
          {
            id: ev.id,
            plan: ev.plan,
            summary: ev.summary,
            ...(steps ? { steps } : {}),
          },
        ],
      };
    }
    case "$checkpoint_required":
      return {
        ...state,
        pendingCheckpoints: [
          ...state.pendingCheckpoints,
          {
            id: ev.id,
            stepId: ev.stepId,
            title: ev.title,
            result: ev.result,
            notes: ev.notes,
            completed: ev.completed,
            total: ev.total,
          },
        ],
      };
    case "$revision_required":
      return {
        ...state,
        pendingRevisions: [
          ...state.pendingRevisions,
          {
            id: ev.id,
            reason: ev.reason,
            remainingSteps: ev.remainingSteps,
            summary: ev.summary,
          },
        ],
      };
    case "$step_completed": {
      if (!state.activePlan) return state;
      const stepIds = new Set(state.activePlan.completedStepIds);
      stepIds.add(ev.stepId);
      return {
        ...state,
        activePlan: {
          ...state.activePlan,
          completedStepIds: [...stepIds],
          stepResults: {
            ...state.activePlan.stepResults,
            [ev.stepId]: ev.result,
          },
        },
      };
    }
    case "$plan_cleared":
      return {
        ...state,
        activePlan: null,
        pendingCheckpoints: [],
        pendingRevisions: [],
      };
    case "$sessions":
      return { ...state, sessions: ev.items };
    case "$archived_sessions":
      return { ...state, archivedSessions: ev.items };
    case "$session_import_sources":
      return {
        ...state,
        externalImportSources: ev.apps,
        externalImportCandidates: ev.candidates ?? [],
      };
    case "$session_import_result":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            kind: "status",
            text: t("sidebarPanel.importResult", {
              imported: ev.imported,
              skipped: ev.skipped,
              failed: ev.failed,
            }),
          },
        ],
      };
    case "$mcp_specs":
      return {
        ...state,
        mcpSpecs: Array.isArray(ev.specs) ? ev.specs : [],
        mcpBridged: Boolean(ev.bridged),
      };
    case "$subagent_event":
      return {
        ...state,
        subagents: reduceSubagentRuns(state.subagents, ev, state.currentSession),
      };
    case "$skills":
      return { ...state, skills: ev.items, skillRoots: ev.roots ?? [] };
    case "$ctx_breakdown": {
      const next: UsageStats = {
        ...state.usage,
        reservedTokens: ev.reservedTokens,
      };
      if (typeof ev.logTokens === "number") {
        next.liveLogTokens = ev.logTokens;
      }
      return { ...state, usage: next };
    }
    case "$compact_result": {
      const compactStats =
        typeof ev.totalTokens === "number" && typeof ev.tailBudget === "number"
          ? ` ${t("app.compact.stats", {
              total: ev.totalTokens.toLocaleString(),
              budget: ev.tailBudget.toLocaleString(),
            })}`
          : "";
      const compactNoopReason =
        ev.reason === "empty"
          ? t("app.compact.noopEmpty")
          : ev.reason === "already-small"
            ? t("app.compact.noopAlreadySmall")
            : ev.reason === "tail-boundary-missing"
              ? t("app.compact.noopTailBoundary")
              : ev.reason === "insufficient-savings"
                ? t("app.compact.noopInsufficientSavings")
                : ev.reason === "summary-empty"
                  ? t("app.compact.noopSummaryEmpty")
                  : t("app.compact.noopUnknown");
      const text = ev.folded
        ? t("app.compact.done", {
            before: ev.beforeMessages,
            after: ev.afterMessages,
            chars: ev.summaryChars.toLocaleString(),
          })
        : `${compactNoopReason}${compactStats}`;
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            kind: "status",
            text,
          },
        ],
      };
    }
    case "$memory":
      return {
        ...state,
        memory: ev.entries,
        memoryDetail:
          state.memoryDetail && ev.entries.some((entry) => entry.path === state.memoryDetail?.path)
            ? state.memoryDetail
            : null,
      };
    case "$memory_detail":
      return { ...state, memoryDetail: ev.detail };
    case "$source_search_results":
      return { ...state, sourceSearchResults: ev };
    case "$source_ingest_result":
      return { ...state, sourceIngestResult: ev };
    case "$library_sources":
      return { ...state, librarySources: ev.sources };
    case "$storage_scan":
      return { ...state, storageScan: ev };
    case "$storage_cleanup":
      return { ...state, storageScan: ev.scan };
    case "$jobs":
      return { ...state, jobs: ev.items };
    case "$balance":
      return {
        ...state,
        balance: {
          currency: ev.currency,
          total: ev.total,
          isAvailable: ev.isAvailable,
          infos: ev.balanceInfos ?? [],
        },
      };
    case "$qq_settings":
      return {
        ...state,
        qq: {
          appId: ev.appId,
          appSecret: ev.appSecret,
          sandbox: ev.sandbox,
          enabled: ev.enabled,
          configured: ev.configured,
          runtimeState: ev.runtimeState,
          lastError: ev.lastError,
          appIdPreview: ev.appIdPreview,
          access: ev.access,
        },
      };
    case "$feishu_settings":
      return {
        ...state,
        feishu: {
          appId: ev.appId,
          appSecret: ev.appSecret,
          enabled: ev.enabled,
          configured: ev.configured,
          requireMentionInGroup: ev.requireMentionInGroup,
          runtimeState: ev.runtimeState,
          lastError: ev.lastError,
          appIdPreview: ev.appIdPreview,
        },
      };
    case "$dingtalk_settings":
      return {
        ...state,
        dingtalk: {
          clientId: ev.clientId,
          clientSecret: ev.clientSecret,
          enabled: ev.enabled,
          configured: ev.configured,
          requireMentionInGroup: ev.requireMentionInGroup,
          runtimeState: ev.runtimeState,
          lastError: ev.lastError,
          clientIdPreview: ev.clientIdPreview,
        },
      };
    case "$settings": {
      const prevWs = state.settings?.workspaceDir;
      const wsChanged = prevWs !== undefined && prevWs !== ev.workspaceDir;
      return {
        ...state,
        busy: wsChanged ? false : state.busy,
        messages: wsChanged ? [] : state.messages,
        transientStatus: wsChanged ? null : state.transientStatus,
        pendingConfirms: wsChanged ? [] : state.pendingConfirms,
        pendingPathAccess: wsChanged ? [] : state.pendingPathAccess,
        pendingChoices: wsChanged ? [] : state.pendingChoices,
        pendingPlans: wsChanged ? [] : state.pendingPlans,
        pendingCheckpoints: wsChanged ? [] : state.pendingCheckpoints,
        pendingRevisions: wsChanged ? [] : state.pendingRevisions,
        activePlan: wsChanged ? null : state.activePlan,
        usage: wsChanged ? zeroUsage() : state.usage,
        sessionFiles: wsChanged ? [] : state.sessionFiles,
        subagents: wsChanged ? [] : state.subagents,
        retryNonce: wsChanged ? 0 : state.retryNonce,
        settings: {
          reasoningEffort: ev.reasoningEffort,
          editMode: ev.editMode,
          budgetUsd: ev.budgetUsd,
          baseUrl: ev.baseUrl,
          apiKeyPrefix: ev.apiKeyPrefix,
          workspaceDir: ev.workspaceDir,
          recentWorkspaces: ev.recentWorkspaces,
          model: ev.model,
          editor: ev.editor,
          desktopCloseBehavior: ev.desktopCloseBehavior,
          webSearchEngine: ev.webSearchEngine,
          webSearchEndpoint: ev.webSearchEndpoint,
          browserAutomation: ev.browserAutomation,
          skillPackSources: ev.skillPackSources,
          webSearchApiKeys: ev.webSearchApiKeys,
          subagentModels: ev.subagentModels,
          contextTokens: ev.contextTokens,
          libraryRetrievalMode: ev.libraryRetrievalMode,
          showSystemEvents: ev.showSystemEvents,
          processCardsDefaultOpen: ev.processCardsDefaultOpen,
          memoryConfirmWrites: ev.memoryConfirmWrites,
          memoryGlobalEnabled: ev.memoryGlobalEnabled,
          promptHistory: ev.promptHistory,
          version: ev.version,
        },
      };
    }
    case "$session_loaded": {
      return applySessionSnapshot(state, ev, { resetUi: true });
    }
    case "$session_reconciled": {
      return applySessionSnapshot(state, ev, { resetUi: false });
    }
    case "$session_empty": {
      // The sidecar successfully ran loadSessionMessages but the jsonl is
      // empty / all-malformed. Without this, the click looks like a no-op
      // because the chat just re-renders empty. Issue #1179.
      const sizeNote = ev.sizeBytes === 0 ? "0 bytes" : `${ev.sizeBytes} bytes, no valid entries`;
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            kind: "error",
            message:
              `Session "${ev.name}" loaded with no messages (${sizeNote}). ` +
              `The file ~/.jupiter/sessions/${ev.name}.jsonl exists but couldn't be parsed — ` +
              `start a new chat or restore from .jsonl.bak if you have one.`,
            id: nextErrorId(),
          },
        ],
      };
    }
    case "$error":
    case "error": {
      // Kernel-level errors carry a `recoverable` flag — true for
      // storm-repair / repeat-loop warnings the loop already worked
      // around, false for hard failures. The desktop renders both as
      // dismissable cards but uses softer tone for the recoverable
      // ones so a session full of self-repaired loops doesn't look
      // like everything's on fire (#1456-followup).
      const recoverable = ev.type === "error" ? ev.recoverable : false;
      // Loop has returned (any error path ends the turn); flip the still-
      // streaming assistant message to settled so the UI doesn't keep
      // showing a "thinking" spinner above the error card (#1660).
      const settled = state.messages.map((m) =>
        m.kind === "assistant" && m.pending ? { ...m, pending: false } : m,
      );
      return {
        ...state,
        busy: false,
        transientStatus: null,
        activeSkill: null,
        messages: [
          ...settled,
          {
            kind: "error",
            message: ev.message,
            id: nextErrorId(),
            recoverable,
          },
        ],
      };
    }
    case "model.turn.started":
      if (latestAssistantIndexForLiveTurn(state.messages, ev.turn) >= 0) {
        return { ...state, model: ev.model, transientStatus: null };
      }
      return {
        ...state,
        model: ev.model,
        transientStatus: null,
        messages: [
          ...state.messages,
          { kind: "assistant", turn: ev.turn, segments: [], pending: true },
        ],
      };
    case "model.delta": {
      const assistantIndex = latestAssistantIndexForLiveTurn(state.messages, ev.turn);
      if (assistantIndex >= 0) {
        const m = state.messages[assistantIndex]!;
        if (m.kind !== "assistant") return state;
        let updated = m;
        if (ev.channel === "content")
          updated = {
            ...m,
            segments: appendTextSegment(m.segments, "text", ev.text),
          };
        else if (ev.channel === "reasoning")
          updated = {
            ...m,
            segments: appendTextSegment(m.segments, "reasoning", ev.text),
          };
        const next = [...state.messages];
        next[assistantIndex] = updated;
        return { ...state, transientStatus: null, messages: next };
      }
      let segments: AssistantSegment[] = [];
      if (ev.channel === "content") segments = appendTextSegment(segments, "text", ev.text);
      else if (ev.channel === "reasoning")
        segments = appendTextSegment(segments, "reasoning", ev.text);
      if (segments.length === 0) return state;
      return {
        ...state,
        busy: true,
        transientStatus: null,
        messages: [
          ...state.messages,
          { kind: "assistant", turn: ev.turn, segments, pending: true },
        ],
      };
    }
    case "model.final": {
      const u = ev.usage;
      const promptTokens =
        u?.prompt_tokens ?? (u?.prompt_cache_hit_tokens ?? 0) + (u?.prompt_cache_miss_tokens ?? 0);
      const callHit = u?.prompt_cache_hit_tokens ?? 0;
      const callMiss = u?.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - callHit);
      const hasCall = promptTokens > 0 || callHit > 0 || callMiss > 0;
      const usage: UsageStats = {
        totalCostUsd: state.usage.totalCostUsd + (ev.costUsd ?? 0),
        totalPromptTokens: state.usage.totalPromptTokens + promptTokens,
        totalCompletionTokens: state.usage.totalCompletionTokens + (u?.completion_tokens ?? 0),
        cacheHitTokens: state.usage.cacheHitTokens + callHit,
        cacheMissTokens: state.usage.cacheMissTokens + callMiss,
        lastCallCacheHit: hasCall ? callHit : state.usage.lastCallCacheHit,
        lastCallCacheMiss: hasCall ? callMiss : state.usage.lastCallCacheMiss,
        reservedTokens: state.usage.reservedTokens,
        liveLogTokens: state.usage.liveLogTokens,
      };
      let matchedAssistant = false;
      const assistantIndex = latestAssistantIndexForLiveTurn(state.messages, ev.turn);
      if (assistantIndex >= 0) {
        const m = state.messages[assistantIndex]!;
        if (m.kind !== "assistant") return state;
        const segments = mergeFinalSegments(m.segments, ev);
        if (m.pending || segments !== m.segments) {
          const messages = [...state.messages];
          messages[assistantIndex] = { ...m, segments, pending: false };
          state = { ...state, messages };
        }
        matchedAssistant = true;
      }
      const finalSegments = mergeFinalSegments([], ev);
      if (!matchedAssistant && finalSegments.length > 0) {
        state = {
          ...state,
          messages: [
            ...state.messages,
            {
              kind: "assistant",
              turn: ev.turn,
              segments: finalSegments,
              pending: false,
            },
          ],
        };
      }
      return { ...state, transientStatus: null, usage };
    }
    case "tool.preparing": {
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i]!;
        if (m.kind !== "assistant" || m.turn !== ev.turn) continue;
        if (m.segments.some((s) => s.kind === "tool" && s.callId === ev.callId)) return state;
        const next = [...state.messages];
        next[i] = {
          ...m,
          segments: [
            ...m.segments,
            {
              kind: "tool" as const,
              callId: ev.callId,
              name: ev.name,
              args: "",
              startedAt: Date.now(),
            },
          ],
        };
        return { ...state, messages: next };
      }
      return state;
    }
    case "tool.intent": {
      const adds = extractToolFiles(ev.name, ev.args);
      let nextState = {
        ...state,
        sessionFiles: mergeSessionFiles(state.sessionFiles, adds),
      };
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i]!;
        if (m.kind !== "assistant" || m.turn !== ev.turn) continue;
        const idx = m.segments.findIndex((s) => s.kind === "tool" && s.callId === ev.callId);
        if (idx >= 0) {
          const segs = [...m.segments];
          if (segs[idx]?.kind === "tool")
            segs[idx] = {
              ...(segs[idx] as AssistantSegment & { kind: "tool" }),
              args: ev.args,
            };
          const msgs = [...nextState.messages];
          msgs[i] = { ...m, segments: segs };
          nextState = { ...nextState, messages: msgs };
        } else {
          const msgs = [...nextState.messages];
          msgs[i] = {
            ...m,
            segments: [
              ...m.segments,
              {
                kind: "tool" as const,
                callId: ev.callId,
                name: ev.name,
                args: ev.args,
                startedAt: Date.now(),
              },
            ],
          };
          nextState = { ...nextState, messages: msgs };
        }
        break;
      }
      return nextState;
    }
    case "tool.result": {
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i]!;
        if (m.kind !== "assistant") continue;
        let mutated = false;
        const segs = m.segments.map((s) => {
          if (s.kind === "tool" && s.callId === ev.callId) {
            mutated = true;
            return {
              ...s,
              result: ev.output,
              ok: ev.ok,
              durationMs: Date.now() - s.startedAt,
            };
          }
          return s;
        });
        if (!mutated) continue;
        const next = [...state.messages];
        next[i] = { ...m, segments: segs };
        return { ...state, messages: next };
      }
      return state;
    }
    case "$retry_result":
      return { ...state, retryText: ev.text, retryNonce: state.retryNonce + 1 };
    case "$btw_result":
      if (ev.clientId) {
        const idx = state.sideChats.findIndex((item) => item.id === ev.clientId);
        if (idx >= 0) {
          const sideChats = [...state.sideChats];
          sideChats[idx] = {
            ...sideChats[idx],
            answer: ev.answer,
            status: "done",
          };
          return { ...state, sideChats };
        }
        return state;
      }
      return {
        ...state,
        busy: false,
        messages: [...state.messages, { kind: "status", text: `≫ btw\n${ev.answer}` }],
      };
    case "status":
      return {
        ...state,
        transientStatus: ev.text,
      };
    case "warning":
      // High-severity only — eventize already drops "low". Inline divider only.
      if (ev.severity !== "high") return state;
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            kind: "warning",
            id: `w-${ev.id}`,
            text: ev.text,
            severity: ev.severity,
          },
        ],
      };
    default:
      return state;
  }
}

export function formatWorkflowRunMarkdown(run: WorkflowRun): string {
  const lines = [
    `# ${run.title}`,
    "",
    `- Workflow: ${run.workflowId}@${run.workflowVersion}`,
    `- Status: ${run.status}`,
    `- Phase: ${run.phase ?? "-"}`,
    `- Started: ${run.startedAt}`,
    run.completedAt ? `- Completed: ${run.completedAt}` : null,
    `- Tokens: ${run.tokenUsage.total.toLocaleString()}`,
    "",
    "## Agents",
    "",
    ...run.agents.flatMap((agent) => [
      `### ${agent.label}`,
      "",
      `- Status: ${agent.status}`,
      `- Phase: ${agent.phase}`,
      `- Tokens: ${agent.tokenUsage.total.toLocaleString()}`,
      agent.summary ? `\n${agent.summary}` : "",
      agent.error ? `\nError: ${agent.error}` : "",
      "",
    ]),
  ].filter((line): line is string => line !== null);

  if (run.sources.length > 0) {
    lines.push("## Sources", "");
    for (const source of run.sources) {
      const target = source.url ?? source.path ?? "";
      lines.push(`- ${source.title}${target ? `: ${target}` : ""}`);
    }
    lines.push("");
  }
  if (run.result !== undefined) {
    lines.push("## Result", "", "```json", JSON.stringify(run.result, null, 2), "```", "");
  }
  if (run.error) {
    lines.push("## Error", "", run.error, "");
  }
  return `${lines.join("\n").trim()}\n`;
}

function formatConversationMarkdown(messages: ChatMessage[], userLabel: string): string {
  return messages
    .map((m) => {
      if (m.kind === "user") return `### ${userLabel}\n\n${m.text}`;
      if (m.kind === "assistant") {
        const body = m.segments
          .map((s) => {
            if (s.kind === "text") return s.text;
            if (s.kind === "reasoning")
              return `<details>\n<summary>${t("app.exportReasoningSummary")}</summary>\n\n${s.text}\n\n</details>`;
            if (s.kind === "tool") {
              const arg = s.args ? `\n\n\`\`\`json\n${s.args}\n\`\`\`` : "";
              const res = s.result ? `\n\n\`\`\`\n${s.result}\n\`\`\`` : "";
              return `> **${t("app.exportToolLabel")} · \`${s.name}\`**${arg}${res}`;
            }
            return "";
          })
          .filter(Boolean)
          .join("\n\n");
        return `### Jupiter\n\n${body}`;
      }
      if (m.kind === "workflow") {
        return formatWorkflowRunMarkdown(m.run);
      }
      if (m.kind === "error") return `### Error\n\n${m.message}`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 200) || "session"
  );
}

function defaultExportFilename(session: string): string {
  const safe = sanitizeFilename(session);
  return `${safe}.md`;
}

type TabAction = Action;
type TabDispatcher = (action: TabAction) => void;

type TabRuntimeSnapshot = {
  currentSession?: string;
  busy: boolean;
  sessions: SessionInfo[];
  importSources: ExternalSessionApp[];
  importCandidates: ExternalSessionCandidate[];
  workspaceDir?: string;
  recentWorkspaces: string[];
  model?: string;
  hasMessages: boolean;
  contextInfoOpen: boolean;
};

type TabRuntimeControls = {
  clearAbortDraft: () => void;
  openSettingsCard: () => void;
  openSettingsPage: (page?: SettingsPageId) => void;
  openCommandPalette: () => void;
};

interface TabRuntimeProps {
  tabId: string;
  active: boolean;
  currency: "CNY" | "USD";
  registerDispatch: (tabId: string, d: TabDispatcher | null) => void;
  sendRpcToTab: (tabId: string, cmd: OutgoingCommand) => void;
  onRuntimeSnapshot: (tabId: string, snapshot: TabRuntimeSnapshot) => void;
  registerRuntimeControls: (tabId: string, controls: TabRuntimeControls | null) => void;
  onNewTab: () => void;
  onCloseTab: () => void;
  canCloseTab: boolean;
  theme: Theme;
  themeStyle: ThemeStyle;
  onSetTheme: (theme: Theme) => void;
  onSetThemeStyle: (style: ThemeStyle) => void;
  onToggleTheme: () => void;
  fontScale: FontScale;
  onSetFontScale: (scale: FontScale) => void;
  fontFamily: FontFamily;
  onSetFontFamily: (family: FontFamily) => void;
  customFontFamily: string;
  onSetCustomFontFamily: (family: string) => void;
  sideCollapsed: boolean;
  ctxCollapsed: boolean;
  bottomCollapsed: boolean;
  sideWidth: number;
  ctxWidth: number;
  onCtxResizeDown: (e: React.MouseEvent) => void;
  onBottomResizeDown: (e: React.MouseEvent) => void;
  onToggleSide: () => void;
  onToggleCtx: () => void;
  onToggleBottom: () => void;
  onToggleCurrency: () => void;
  tabsList: TabMeta[];
  activeTabId: string;
  setActiveTabId: (id: string) => void;
  updateCheck: UpdateCheckViewState;
  onCheckUpdates: (manual: boolean) => void;
  onOpenUpdateRelease: (source: keyof UpdateReleaseUrls) => void;
}

function TabRuntimeInner({
  tabId,
  active,
  currency,
  registerDispatch,
  sendRpcToTab,
  onRuntimeSnapshot,
  registerRuntimeControls,
  onNewTab,
  onCloseTab,
  canCloseTab,
  theme,
  themeStyle,
  onSetTheme,
  onSetThemeStyle,
  onToggleTheme,
  fontScale,
  onSetFontScale,
  fontFamily,
  onSetFontFamily,
  customFontFamily,
  onSetCustomFontFamily,
  sideCollapsed,
  ctxCollapsed,
  bottomCollapsed,
  sideWidth,
  ctxWidth,
  onCtxResizeDown,
  onBottomResizeDown,
  onToggleSide,
  onToggleCtx,
  onToggleBottom,
  onToggleCurrency,
  tabsList,
  activeTabId,
  setActiveTabId,
  updateCheck,
  onCheckUpdates,
  onOpenUpdateRelease,
}: TabRuntimeProps) {
  const [state, dispatch] = useReducer(reduce, {
    ready: false,
    needsSetup: false,
    busy: false,
    transientStatus: null,
    messages: [],
    pendingConfirms: [],
    pendingPathAccess: [],
    pendingChoices: [],
    pendingPlans: [],
    pendingCheckpoints: [],
    pendingRevisions: [],
    activePlan: null,
    usage: zeroUsage(),
    sessions: [],
    archivedSessions: [],
    externalImportSources: [],
    externalImportCandidates: [],
    settings: null,
    qq: null,
    feishu: null,
    dingtalk: null,
    balance: null,
    mentionResults: null,
    mentionPreview: null,
    mcpSpecs: [],
    mcpBridged: false,
    subagents: [],
    skills: [],
    skillRoots: [],
    sessionFiles: [],
    memory: [],
    memoryDetail: null,
    librarySources: [],
    storageScan: null,
    sourceSearchResults: null,
    sourceIngestResult: null,
    jobs: [],
    activeSkill: null,
    queuedSends: [],
    sideChats: [],
    retryNonce: 0,
  });
  useLang();
  useDisableTextAssist();
  const [draft, setDraft] = useState("");
  const [oneShotPlanArmed, setOneShotPlanArmed] = useState(false);
  const [filePreview, setFilePreview] = useState<{
    target: FilePreviewTarget | null;
    preview: FilePreview | null;
    loading: boolean;
    error: string | null;
  }>({ target: null, preview: null, loading: false, error: null });
  const [contextTabState, setContextTabState] = useState<{
    tabs: ContextPanelTab[];
    activeId: string | null;
    history: string[];
  }>({ tabs: [], activeId: null, history: [] });
  const libraryStorageKey = useMemo(
    () => libraryStorageKeyForWorkspace(state.settings?.workspaceDir),
    [state.settings?.workspaceDir],
  );
  const librarySources = state.librarySources;
  const [librarySearchFocusNonce] = useState(0);
  const [sourceSearchOpen, setSourceSearchOpen] = useState(false);
  const [contextInfoOpen, setContextInfoOpen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; yolo?: boolean } | null>(null);
  const [wdOpen, setWdOpen] = useState(false);
  const [wdAnchor, setWdAnchor] = useState<
    { top?: number; bottom?: number; left: number } | undefined
  >(undefined);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const contextTabIdRef = useRef(0);
  const browserRequestIdRef = useRef(0);
  const migratedLibraryStorageKeysRef = useRef<Set<string>>(new Set());
  const threadRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const virtuosoScrollerRef = useRef<HTMLElement | null>(null);
  const optimisticBusyRef = useRef(false);
  const [virtuosoScroller, setVirtuosoScroller] = useState<HTMLElement | null>(null);
  const setTranscriptScroller = useCallback((node: HTMLElement | Window | null) => {
    const element = node instanceof HTMLElement ? node : null;
    virtuosoScrollerRef.current = element;
    setVirtuosoScroller((current) => (current === element ? current : element));
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPageId>("general");
  const [settingsCardOpen, setSettingsCardOpen] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const previousApprovalSnapshotRef = useRef<ApprovalSnapshot>({
    confirms: [],
    pathAccess: [],
    choices: [],
    plans: [],
    checkpoints: [],
    revisions: [],
  });
  const wasBusyRef = useRef(false);
  const busyStartedAtRef = useRef<number | null>(null);
  const abortDraftRef = useRef<string | null>(null);
  const clearAbortDraft = useCallback(() => {
    abortDraftRef.current = nextAbortDraftCandidate(abortDraftRef.current, {
      type: "clear",
    });
  }, []);
  const recordAbortDraft = useCallback((source: AbortDraftSource, text: string) => {
    abortDraftRef.current = nextAbortDraftCandidate(abortDraftRef.current, {
      type: "record",
      source,
      text,
    });
  }, []);
  const openSettingsAt = useCallback((page: SettingsPageId = "general") => {
    setSettingsPage(page);
    setSettingsCardOpen(false);
    setSettingsOpen(true);
  }, []);
  const palette = useCommandPalette(active);
  const setPaletteOpen = palette.setOpen;
  useEffect(() => {
    registerRuntimeControls(tabId, {
      clearAbortDraft,
      openSettingsCard: () => setSettingsCardOpen((open) => !open),
      openSettingsPage: openSettingsAt,
      openCommandPalette: () => setPaletteOpen(true),
    });
    return () => registerRuntimeControls(tabId, null);
  }, [clearAbortDraft, openSettingsAt, registerRuntimeControls, setPaletteOpen, tabId]);
  useEffect(() => {
    onRuntimeSnapshot(tabId, {
      currentSession: state.currentSession,
      busy: state.busy,
      sessions: state.sessions,
      importSources: state.externalImportSources,
      importCandidates: state.externalImportCandidates,
      workspaceDir: state.settings?.workspaceDir,
      recentWorkspaces: state.settings?.recentWorkspaces ?? [],
      model: state.settings?.model ?? state.model,
      hasMessages: state.messages.length > 0,
      contextInfoOpen,
    });
  }, [
    contextInfoOpen,
    onRuntimeSnapshot,
    state.busy,
    state.currentSession,
    state.externalImportCandidates,
    state.externalImportSources,
    state.messages.length,
    state.model,
    state.sessions,
    state.settings?.model,
    state.settings?.recentWorkspaces,
    state.settings?.workspaceDir,
    tabId,
  ]);
  const activeContextTab = useMemo(
    () => contextTabState.tabs.find((tab) => tab.id === contextTabState.activeId) ?? null,
    [contextTabState.activeId, contextTabState.tabs],
  );
  const ensureContextPanelVisible = useCallback(() => {
    if (bottomCollapsed && ctxCollapsed) onToggleCtx();
  }, [bottomCollapsed, ctxCollapsed, onToggleCtx]);
  const activateContextTab = useCallback((id: string) => {
    setContextTabState((current) => {
      if (!current.tabs.some((tab) => tab.id === id)) return current;
      return {
        ...current,
        activeId: id,
        history: [...current.history.filter((item) => item !== id), id],
      };
    });
  }, []);
  const openContextTab = useCallback((tab: Omit<ContextPanelTab, "id">) => {
    contextTabIdRef.current += 1;
    const id = `ctx-${contextTabIdRef.current}`;
    setContextTabState((current) => ({
      tabs: [...current.tabs, { ...tab, id }],
      activeId: id,
      history: [...current.history.filter((item) => item !== id), id],
    }));
    return id;
  }, []);
  const openContextPanelMode = useCallback(
    (mode: ContextPanelMode) => {
      setContextInfoOpen(false);
      if (mode === "home") {
        setContextTabState({ tabs: [], activeId: null, history: [] });
        return;
      }
      ensureContextPanelVisible();
      if (
        mode === "files" ||
        mode === "library" ||
        mode === "sidechat" ||
        mode === "review" ||
        mode === "terminal"
      ) {
        const existing = contextTabState.tabs.find((tab) => tab.mode === mode);
        if (existing) {
          activateContextTab(existing.id);
          return;
        }
      }
      openContextTab({ mode });
    },
    [activateContextTab, contextTabState.tabs, ensureContextPanelVisible, openContextTab],
  );
  const selectContextTab = useCallback(
    (id: string) => {
      activateContextTab(id);
    },
    [activateContextTab],
  );
  const closeContextTab = useCallback((id: string) => {
    setContextTabState((current) => {
      const closingIndex = current.tabs.findIndex((tab) => tab.id === id);
      if (closingIndex < 0) return current;
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      const remainingIds = new Set(tabs.map((tab) => tab.id));
      const history = current.history.filter((item) => item !== id && remainingIds.has(item));
      if (current.activeId !== id) {
        return {
          tabs,
          history,
          activeId: tabs.some((tab) => tab.id === current.activeId)
            ? current.activeId
            : (tabs[tabs.length - 1]?.id ?? null),
        };
      }
      const previousActiveId = history[history.length - 1] ?? null;
      const fallbackActive =
        tabs[Math.min(closingIndex, tabs.length - 1)] ?? tabs[closingIndex - 1] ?? null;
      const activeId = previousActiveId ?? fallbackActive?.id ?? null;
      return {
        tabs,
        activeId,
        history: activeId ? [...history.filter((item) => item !== activeId), activeId] : [],
      };
    });
  }, []);

  useEffect(() => {
    registerDispatch(tabId, dispatch);
    return () => registerDispatch(tabId, null);
  }, [tabId, registerDispatch]);

  const sendRpc = useCallback(
    (cmd: OutgoingCommand) => sendRpcToTab(tabId, cmd),
    [sendRpcToTab, tabId],
  );
  useEffect(() => {
    if (state.settings?.workspaceDir) sendRpc({ cmd: "library_list" });
  }, [sendRpc, state.settings?.workspaceDir]);
  useEffect(() => {
    if (!libraryStorageKey || migratedLibraryStorageKeysRef.current.has(libraryStorageKey)) return;
    migratedLibraryStorageKeysRef.current.add(libraryStorageKey);
    const legacySources = parseLibrarySources(localStorage.getItem(libraryStorageKey));
    for (const source of legacySources) {
      const { id: _id, addedAt: _addedAt, updatedAt: _updatedAt, ...input } = source;
      sendRpc({ cmd: "library_add", source: input });
    }
  }, [libraryStorageKey, sendRpc]);
  const addLibrarySource = useCallback(
    (source: LibrarySourceInput) => {
      const identity = librarySourceIdentity(source);
      if (librarySources.some((item) => librarySourceIdentity(item) === identity)) return;
      sendRpc({ cmd: "library_add", source });
    },
    [librarySources, sendRpc],
  );
  const importLibraryFiles = useCallback(() => {
    void (async () => {
      const selected = await openDialog({
        multiple: true,
        directory: false,
      });
      const paths = Array.isArray(selected)
        ? selected
        : typeof selected === "string"
          ? [selected]
          : [];
      for (const path of paths) {
        addLibrarySource(
          filePathToLibrarySource(normalizeLibraryFilePath(path, state.settings?.workspaceDir)),
        );
      }
    })().catch((err) => {
      console.error("library file import failed", err);
    });
  }, [addLibrarySource, state.settings?.workspaceDir]);
  const addLibraryFilesFromMessage = useCallback(
    (text: string) => {
      for (const path of extractLibraryFileReferences(text, state.settings?.workspaceDir)) {
        addLibrarySource(filePathToLibrarySource(path));
      }
    },
    [addLibrarySource, state.settings?.workspaceDir],
  );
  const removeLibrarySource = useCallback(
    (id: string) => {
      sendRpc({ cmd: "library_remove", id });
    },
    [sendRpc],
  );
  const searchLibrarySources = useCallback(
    (query: string, nonce: number, topK = 6) =>
      sendRpc({ cmd: "source_search", query, nonce, topK }),
    [sendRpc],
  );
  const markOptimisticBusy = useCallback(() => {
    optimisticBusyRef.current = true;
  }, []);
  const isTabBusy = useCallback(() => state.busy || optimisticBusyRef.current, [state.busy]);

  const queryMentions = useCallback(
    (query: string, nonce: number) => sendRpc({ cmd: "mention_query", query, nonce }),
    [sendRpc],
  );
  const previewMention = useCallback(
    (path: string, nonce: number) => sendRpc({ cmd: "mention_preview", path, nonce }),
    [sendRpc],
  );
  const markMentionPicked = useCallback(
    (path: string) => sendRpc({ cmd: "mention_picked", path }),
    [sendRpc],
  );
  const previewFile = useCallback(
    (target: FilePreviewTarget) => {
      const workspaceDir = state.settings?.workspaceDir;
      ensureContextPanelVisible();
      setContextInfoOpen(false);
      const tabId = openContextTab({
        mode: "preview",
        title: target.path.split(/[\\/]/).filter(Boolean).pop() || target.path,
        filePreview: null,
        filePreviewLoading: true,
        filePreviewError: null,
        filePreviewPath: target.path,
      });
      setFilePreview({ target, preview: null, loading: true, error: null });
      void readFilePreview(target.path, workspaceDir).then(
        (preview) => {
          setContextTabState((current) => ({
            ...current,
            tabs: current.tabs.map((tab) =>
              tab.id === tabId
                ? {
                    ...tab,
                    title: preview.name || tab.title,
                    filePreview: preview,
                    filePreviewLoading: false,
                    filePreviewError: null,
                    filePreviewPath: target.path,
                  }
                : tab,
            ),
          }));
          setFilePreview({ target, preview, loading: false, error: null });
        },
        (err) => {
          const message = err instanceof Error ? err.message : String(err);
          setContextTabState((current) => ({
            ...current,
            tabs: current.tabs.map((tab) =>
              tab.id === tabId
                ? {
                    ...tab,
                    filePreview: null,
                    filePreviewLoading: false,
                    filePreviewError: message,
                    filePreviewPath: target.path,
                  }
                : tab,
            ),
          }));
          setFilePreview({
            target,
            preview: null,
            loading: false,
            error: message,
          });
        },
      );
    },
    [ensureContextPanelVisible, openContextTab, state.settings?.workspaceDir],
  );
  const openBrowserUrl = useCallback(
    (url: string) => {
      ensureContextPanelVisible();
      setContextInfoOpen(false);
      browserRequestIdRef.current += 1;
      const request: BrowserOpenRequest = { id: browserRequestIdRef.current, url };
      openContextTab({
        mode: "browser",
        title: titleFromBrowserUrl(url),
        browserRequest: request,
      });
    },
    [ensureContextPanelVisible, openContextTab],
  );
  const revealLibraryFileSource = useCallback(
    (path: string) => {
      void revealFileInFolder(path, state.settings?.workspaceDir).catch((err) =>
        console.error("reveal library source failed", err),
      );
    },
    [state.settings?.workspaceDir],
  );
  const openLibrarySearch = useCallback(() => {
    setContextInfoOpen(false);
    setSourceSearchOpen(true);
  }, []);
  const openHtmlFileInBrowser = useCallback(
    (target: FilePreviewTarget) => {
      const absPath = resolveWorkspacePath(target.path, state.settings?.workspaceDir);
      openBrowserUrl(pathToFileUrl(absPath));
    },
    [openBrowserUrl, state.settings?.workspaceDir],
  );
  useEffect(() => {
    setFilePreview({
      target: null,
      preview: null,
      loading: false,
      error: null,
    });
    setContextTabState({ tabs: [], activeId: null, history: [] });
    setContextInfoOpen(false);
    setSourceSearchOpen(false);
  }, [state.currentSession, state.settings?.workspaceDir]);
  const showContextInfo = useCallback(() => {
    const next = nextContextInfoToggle({
      infoOpen: contextInfoOpen,
      sidebarCollapsed: ctxCollapsed,
    });
    if (next.collapseSidebar) onToggleCtx();
    if (next.infoOpen && !bottomCollapsed) onToggleBottom();
    setContextInfoOpen(next.infoOpen);
  }, [bottomCollapsed, contextInfoOpen, ctxCollapsed, onToggleBottom, onToggleCtx]);
  const toggleContextPanel = useCallback(() => {
    const next = nextContextSidebarToggle({
      infoOpen: contextInfoOpen,
      sidebarCollapsed: ctxCollapsed,
    });
    if (next.panelMode) openContextPanelMode(next.panelMode);
    setContextInfoOpen(next.infoOpen);
    if (ctxCollapsed && !bottomCollapsed) onToggleBottom();
    onToggleCtx();
  }, [
    bottomCollapsed,
    contextInfoOpen,
    ctxCollapsed,
    openContextPanelMode,
    onToggleBottom,
    onToggleCtx,
  ]);
  const toggleBottomPanel = useCallback(() => {
    const expandingBottom = bottomCollapsed;
    if (expandingBottom) {
      setContextInfoOpen(false);
      if (!ctxCollapsed) onToggleCtx();
    }
    onToggleBottom();
  }, [bottomCollapsed, ctxCollapsed, onToggleBottom, onToggleCtx]);
  const saveSettings = useCallback(
    (patch: SettingsPatch) => sendRpc({ cmd: "settings_save", ...patch }),
    [sendRpc],
  );
  const applySettingsPatch = useCallback(
    (patch: SettingsPatch) => {
      dispatch({ t: "settings_patch", patch });
      saveSettings(patch);
    },
    [saveSettings],
  );
  const loadQQSettings = useCallback(() => sendRpc({ cmd: "qq_status_get" }), [sendRpc]);
  const connectQQ = useCallback(() => sendRpc({ cmd: "qq_connect" }), [sendRpc]);
  const disconnectQQ = useCallback(() => sendRpc({ cmd: "qq_disconnect" }), [sendRpc]);
  const saveQQConfig = useCallback(
    (patch: { appId?: string; appSecret?: string; sandbox: boolean }) =>
      sendRpc({ cmd: "qq_config_save", ...patch }),
    [sendRpc],
  );
  const loadFeishuSettings = useCallback(() => sendRpc({ cmd: "feishu_status_get" }), [sendRpc]);
  const connectFeishu = useCallback(() => sendRpc({ cmd: "feishu_connect" }), [sendRpc]);
  const disconnectFeishu = useCallback(() => sendRpc({ cmd: "feishu_disconnect" }), [sendRpc]);
  const saveFeishuConfig = useCallback(
    (patch: { appId?: string; appSecret?: string; requireMentionInGroup?: boolean }) =>
      sendRpc({ cmd: "feishu_config_save", ...patch }),
    [sendRpc],
  );
  const loadDingTalkSettings = useCallback(
    () => sendRpc({ cmd: "dingtalk_status_get" }),
    [sendRpc],
  );
  const connectDingTalk = useCallback(() => sendRpc({ cmd: "dingtalk_connect" }), [sendRpc]);
  const disconnectDingTalk = useCallback(
    () => sendRpc({ cmd: "dingtalk_disconnect" }),
    [sendRpc],
  );
  const saveDingTalkConfig = useCallback(
    (patch: { clientId?: string; clientSecret?: string; requireMentionInGroup?: boolean }) =>
      sendRpc({ cmd: "dingtalk_config_save", ...patch }),
    [sendRpc],
  );
  const saveApiKey = useCallback(
    (key: string) => sendRpc({ cmd: "setup_save_key", key }),
    [sendRpc],
  );
  const signOutApiKey = useCallback(() => sendRpc({ cmd: "settings_sign_out" }), [sendRpc]);
  const scanStorage = useCallback(() => sendRpc({ cmd: "storage_scan" }), [sendRpc]);
  const cleanStorage = useCallback(
    (itemIds: string[]) => sendRpc({ cmd: "storage_cleanup", itemIds }),
    [sendRpc],
  );
  const addMcpSpec = useCallback(
    (spec: string) => sendRpc({ cmd: "mcp_specs_add", spec }),
    [sendRpc],
  );
  const removeMcpSpec = useCallback(
    (spec: string) => sendRpc({ cmd: "mcp_specs_remove", spec }),
    [sendRpc],
  );
  const enableMcpSpec = useCallback(
    (name: string) => sendRpc({ cmd: "mcp_specs_enable", name }),
    [sendRpc],
  );
  const disableMcpSpec = useCallback(
    (name: string) => sendRpc({ cmd: "mcp_specs_disable", name }),
    [sendRpc],
  );
  const reconnectMcpSpecs = useCallback(() => sendRpc({ cmd: "mcp_specs_reconnect" }), [sendRpc]);
  const addSkillPath = useCallback(
    (path: string) => sendRpc({ cmd: "skill_path_add", path }),
    [sendRpc],
  );
  const removeSkillPath = useCallback(
    (path: string) => sendRpc({ cmd: "skill_path_remove", path }),
    [sendRpc],
  );
  const createSkill = useCallback(
    (name: string, scope: "project" | "global") => sendRpc({ cmd: "skill_create", name, scope }),
    [sendRpc],
  );
  const setSkillModel = useCallback(
    (name: string, model: "flash" | "pro" | null) =>
      sendRpc({ cmd: "skill_model_set", name, model }),
    [sendRpc],
  );
  const newChat = useCallback(() => {
    clearAbortDraft();
    setOneShotPlanArmed(false);
    sendRpc({ cmd: "new_chat", openInNewTab: isTabBusy() });
    if (!isTabBusy()) dispatch({ t: "clear" });
  }, [clearAbortDraft, isTabBusy, sendRpc]);

  const pickWorkspace = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("workdir.title"),
        defaultPath: state.settings?.workspaceDir,
      });
      if (typeof picked === "string" && picked.length > 0) {
        clearAbortDraft();
        saveSettings({ workspaceDir: picked });
      }
    } catch (err) {
      console.error("pickWorkspace failed", err);
    }
  }, [clearAbortDraft, saveSettings, state.settings?.workspaceDir]);

  const flashToast = useCallback((msg: string, opts?: { yolo?: boolean; duration?: number }) => {
    setToast({ msg, yolo: opts?.yolo });
    window.setTimeout(() => setToast(null), opts?.duration ?? 1600);
  }, []);

  const applyReasoningEffort = useCallback(
    (reasoningEffort: Settings["reasoningEffort"]) => {
      applySettingsPatch({ reasoningEffort });
      if (shouldShowSettingsChangeToast("reasoningEffort")) {
        flashToast(t("app.toast.effortSwitched", { effort: reasoningEffort }));
      }
    },
    [applySettingsPatch, flashToast],
  );

  const applyEditMode = useCallback(
    (mode: Settings["editMode"]) => {
      applySettingsPatch({ editMode: mode });
      if (mode === "yolo" && shouldShowSettingsChangeToast("editMode")) {
        flashToast(t("app.yolo.toast"), { yolo: true, duration: 3000 });
      } else if (shouldShowSettingsChangeToast("editMode")) {
        flashToast(t("app.toast.modeSwitched", { mode: t(`editMode.${mode}` as any) }));
      }
    },
    [applySettingsPatch, flashToast],
  );

  const applySlashSettingsCommand = useCallback(
    (command: SlashSettingsCommand) => {
      if (command.type === "reasoningEffort") {
        applyReasoningEffort(command.reasoningEffort);
      } else {
        applyEditMode(command.editMode);
      }
    },
    [applyEditMode, applyReasoningEffort],
  );

  // Drag-and-drop: dropping files/folders onto the window inserts them
  // as @-mentions in the draft (relative to workspaceDir when inside it).
  // activeRef gates the handler — without it, a single drop hits every
  // mounted tab's draft (issue #1027, exposed once #1063 restored tabs).
  const dropActiveRef = useRef(active);
  useEffect(() => {
    dropActiveRef.current = active;
  }, [active]);
  useEffect(() => {
    const ws = state.settings?.workspaceDir;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const mod = await import("@tauri-apps/api/webview");
        const webview = mod.getCurrentWebview();
        const handle = await webview.onDragDropEvent((event) => {
          if (!dropActiveRef.current) return;
          if (event.payload.type === "enter") {
            document.body.style.setProperty("--drop-overlay-label", `"${t("dragDrop.overlay")}"`);
            document.body.dataset.dragOver = "1";
            return;
          }
          if (event.payload.type === "leave") {
            delete document.body.dataset.dragOver;
            return;
          }
          if (event.payload.type !== "drop") return;
          delete document.body.dataset.dragOver;
          const paths = event.payload.paths ?? [];
          if (paths.length === 0) return;
          const mentions = paths.map((p) => {
            const norm = p.replace(/\\/g, "/");
            if (ws) {
              const wsNorm = ws.replace(/\\/g, "/").replace(/\/+$/, "");
              if (norm === wsNorm || norm.startsWith(`${wsNorm}/`)) {
                return norm.slice(wsNorm.length).replace(/^\/+/, "") || ".";
              }
            }
            return norm;
          });
          setDraft((d) => {
            const prefix = d.trim() ? `${d.replace(/\s+$/, "")} ` : "";
            return `${prefix}${mentions.map((m) => `@${m}`).join(" ")} `;
          });
          for (const m of mentions) markMentionPicked(m);
          composerRef.current?.focus();
        });
        if (cancelled) handle();
        else unlisten = handle;
      } catch (err) {
        console.error("drag-drop listen failed", err);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      delete document.body.dataset.dragOver;
    };
  }, [state.settings?.workspaceDir, markMentionPicked]);

  const send = useCallback(
    (override?: string, payload?: ComposerSendPayload) => {
      const text = (override ?? draft).trim();
      const hiddenMentions = payload?.hiddenMentions?.filter(Boolean) ?? [];
      if ((!text && hiddenMentions.length === 0) || !state.ready || state.busy) return;

      const settingsCommand = parseSlashSettingsCommand(text);
      if (settingsCommand) {
        applySlashSettingsCommand(settingsCommand);
        if (!override) setDraft("");
        return;
      }

      const oneShotPlanCommand = parseOneShotPlanCommand(text);
      if (oneShotPlanCommand) {
        if (oneShotPlanCommand.type === "arm") {
          setOneShotPlanArmed(true);
          dispatch({
            t: "push_status",
            text:
              getLang() === "zh-CN"
                ? "▸ /plan 已开启：下一条普通消息只生成计划/spec，不执行；确认后下一轮再执行。"
                : "▸ /plan armed: the next normal message will produce a spec/plan only. It will not execute until you approve in a later message.",
          });
          if (!override) setDraft("");
          return;
        }
        if (oneShotPlanCommand.type === "cancel") {
          setOneShotPlanArmed(false);
          dispatch({
            t: "push_status",
            text: getLang() === "zh-CN" ? "▸ /plan 已取消。" : "▸ /plan cancelled.",
          });
          if (!override) setDraft("");
          return;
        }

        const clientId = `plan-${Date.now()}`;
        setOneShotPlanArmed(false);
        recordAbortDraft("user_input", oneShotPlanCommand.text);
        markOptimisticBusy();
        dispatch({ t: "send_user", text: oneShotPlanCommand.text, clientId });
        sendRpc({
          cmd: "user_input",
          text: oneShotPlanCommand.text,
          clientId,
          planOneShot: true,
        });
        if (!override) setDraft("");
        return;
      }

      // /btw <question> — route to side-question RPC instead of user_input.
      // Empty payload used to silently swallow the keystroke (#1370); surface
      // the usage hint as a status message so the user knows what's expected.
      // The full /btw line is echoed via send_user so the typed text appears
      // immediately and busy=true gives a thinking indicator while the side
      // call runs (#1470).
      const btwMatch = /^\/btw(?:\s+([\s\S]+))?$/.exec(text);
      if (btwMatch) {
        const question = btwMatch[1]?.trim() ?? "";
        if (!question) {
          dispatch({ t: "push_status", text: t("app.btwUsage") });
          if (!override) setDraft("/btw ");
          return;
        }
        const clientId = `btw-${Date.now()}`;
        recordAbortDraft("btw", text);
        markOptimisticBusy();
        dispatch({ t: "send_user", text, clientId, rollbackable: false });
        sendRpc({ cmd: "btw", text: question });
        if (!override) setDraft("");
        return;
      }

      if (/^\/compact(?:\s|$)/.test(text)) {
        dispatch({ t: "push_status", text: t("app.compact.starting") });
        sendRpc({ cmd: "compact_history" });
        if (!override) setDraft("");
        return;
      }

      const slash = parseDesktopSlash(text);
      if (slash) {
        if (isKnownDesktopCliSlash(slash.cmd)) {
          const clientId = `slash-${Date.now()}`;
          recordAbortDraft("user_input", text);
          markOptimisticBusy();
          dispatch({ t: "send_user", text, clientId, rollbackable: false });
          sendRpc({ cmd: "slash", text, clientId });
          if (!override) setDraft("");
          return;
        }
      }

      const skillMatch = text.match(/^\/([a-zA-Z0-9_-]+)(\s+.*)?$/);
      if (skillMatch) {
        const [, name, args] = skillMatch;
        if (name === "search-engine" || name === "se") {
          openSettingsAt("mcp");
          if (!override) setDraft("");
          return;
        }
        if (name === "skill" || name === "skills") {
          openSettingsAt("skills");
          if (!override) setDraft("");
          return;
        }
        const skill = state.skills.find((s) => s.name === name);
        if (skill) {
          const clientId = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const trimmedArgs = args?.trim() ?? "";
          recordAbortDraft("skill_run", text);
          markOptimisticBusy();
          dispatch({
            t: "start_skill",
            skill: { name: skill.name, runAs: skill.runAs },
            args: trimmedArgs,
            clientId,
          });
          sendRpc({
            cmd: "skill_run",
            name: skill.name,
            args: trimmedArgs || undefined,
          });
          if (!override) setDraft("");
          return;
        }
      }

      const clientId = `c-${Date.now()}`;
      const planFirst = oneShotPlanArmed;
      if (oneShotPlanArmed) setOneShotPlanArmed(false);
      const hiddenMentionText = hiddenMentions.map((mention) => `@${mention}`).join(" ");
      const wireText = text
        ? hiddenMentionText
          ? `${text}\n\n${hiddenMentionText}`
          : text
        : hiddenMentionText;
      const displayText = text || (getLang() === "zh-CN" ? "图片附件" : "Image attachment");
      addLibraryFilesFromMessage(wireText);
      recordAbortDraft("user_input", wireText);
      markOptimisticBusy();
      dispatch({ t: "send_user", text: displayText, clientId });
      sendRpc({
        cmd: "user_input",
        text: wireText,
        displayText,
        clientId,
        planOneShot: planFirst,
      });
      if (!override) setDraft("");
    },
    [
      draft,
      state.ready,
      state.busy,
      state.skills,
      sendRpc,
      recordAbortDraft,
      markOptimisticBusy,
      addLibraryFilesFromMessage,
      applySlashSettingsCommand,
      openSettingsAt,
      oneShotPlanArmed,
    ],
  );

  const abort = useCallback(() => {
    setOneShotPlanArmed(false);
    const restored = restoreAbortedDraft(draft, abortDraftRef.current);
    clearAbortDraft();
    if (restored !== null) {
      setDraft(restored);
      composerRef.current?.focus();
    }
    sendRpc({ cmd: "abort" });
  }, [clearAbortDraft, draft, sendRpc]);

  const prioritizeQueuedSend = useCallback(
    (index: number) => {
      if (!state.queuedSends[index]) return;
      dispatch({ t: "prioritize_queued_send", index });
      if (state.busy) sendRpc({ cmd: "abort" });
    },
    [sendRpc, state.busy, state.queuedSends],
  );

  useEffect(() => {
    if (!state.busy) clearAbortDraft();
  }, [clearAbortDraft, state.busy]);

  const clearConversation = useCallback(() => {
    clearAbortDraft();
    setOneShotPlanArmed(false);
    dispatch({ t: "clear" });
  }, [clearAbortDraft]);

  // When /retry returns the last user text, set it as the composer draft
  useEffect(() => {
    if (state.retryNonce > 0 && state.retryText) {
      setDraft(state.retryText);
      composerRef.current?.focus();
    }
    // Only fire when retryNonce changes — retryText alone would re-fire on re-renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.retryNonce]);

  const onEditUserMsg = useCallback((t: string) => {
    setDraft(t);
    composerRef.current?.focus();
  }, []);
  const rollbackToMessage = useCallback(
    (turn: number, role: "user" | "assistant") => {
      clearAbortDraft();
      sendRpc({ cmd: "rollback_to_turn", turn, role });
    },
    [clearAbortDraft, sendRpc],
  );

  useEffect(() => {
    if (state.busy || !state.ready || state.queuedSends.length === 0) return;
    const next = state.queuedSends[0];
    if (!next) return;
    dispatch({ t: "shift_queued_send" });
    send(next);
  }, [state.busy, state.ready, state.queuedSends, send]);
  const sendSideChat = useCallback(
    (text: string) => {
      const next = nextSideChatSend({ text, ready: state.ready });
      if (!next) return;
      const id = `side-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      dispatch({ t: "side_chat_sent", id, question: next.question });
      sendRpc({ cmd: "btw", text: next.question, clientId: id });
    },
    [sendRpc, state.ready],
  );

  useEffect(() => {
    const currentSnapshot: ApprovalSnapshot = {
      confirms: state.pendingConfirms.map((c) => ({
        id: c.id,
        command: c.command,
      })),
      pathAccess: state.pendingPathAccess.map((p) => ({
        id: p.id,
        path: p.path,
        intent: p.intent,
      })),
      choices: state.pendingChoices.map((c) => ({
        id: c.id,
        question: c.question,
      })),
      plans: state.pendingPlans.map((p) => ({
        id: p.id,
        summary: p.summary,
        plan: p.plan,
      })),
      checkpoints: state.pendingCheckpoints.map((c) => ({
        id: c.id,
        title: c.title,
        result: c.result,
      })),
      revisions: state.pendingRevisions.map((r) => ({
        id: r.id,
        summary: r.summary,
        reason: r.reason,
      })),
    };
    const previousSnapshot = previousApprovalSnapshotRef.current;
    const wasBusy = wasBusyRef.current;
    const busyDurationMs =
      wasBusy && !state.busy && busyStartedAtRef.current
        ? Date.now() - busyStartedAtRef.current
        : 0;

    if (state.busy && busyStartedAtRef.current === null) {
      busyStartedAtRef.current = Date.now();
    } else if (!state.busy) {
      busyStartedAtRef.current = null;
    }

    previousApprovalSnapshotRef.current = currentSnapshot;
    wasBusyRef.current = state.busy;

    void getCurrentWindow()
      .isFocused()
      .catch(() => true)
      .then((focused) => {
        if (
          shouldShowCompletionToast({
            wasBusy,
            isBusy: state.busy,
            busyDurationMs,
            focused,
          })
        ) {
          flashToast(t("app.toast.taskComplete"), { duration: 2400 });
        }
        const notifications = deriveDesktopNotifications({
          previous: previousSnapshot,
          current: currentSnapshot,
          wasBusy,
          isBusy: state.busy,
          busyDurationMs,
          focused,
        });
        void dispatchDesktopNotifications(notifications, {
          isFocused: async () => focused,
          isPermissionGranted: isNotificationPermissionGranted,
          requestPermission: requestNotificationPermission,
          sendNotification,
        });
      });
  }, [
    flashToast,
    state.busy,
    state.pendingChoices,
    state.pendingCheckpoints,
    state.pendingConfirms,
    state.pendingPathAccess,
    state.pendingPlans,
    state.pendingRevisions,
  ]);

  useEffect(() => {
    if (!state.busy) optimisticBusyRef.current = false;
  }, [state.busy]);

  const resolveConfirm = useCallback(
    (id: number, response: ConfirmationChoice) => {
      sendRpc({ cmd: "confirm_response", id, response });
      dispatch({ t: "resolve_confirm", id });
    },
    [sendRpc],
  );
  const onApproveConfirm = useCallback(
    (id: number) => resolveConfirm(id, { type: "run_once" }),
    [resolveConfirm],
  );
  const onRejectConfirm = useCallback(
    (id: number) => resolveConfirm(id, { type: "deny" }),
    [resolveConfirm],
  );
  const onAlwaysAllowConfirm = useCallback(
    (id: number, prefix: string) => resolveConfirm(id, { type: "always_allow", prefix }),
    [resolveConfirm],
  );
  const resolvePathAccess = useCallback(
    (id: number, response: ConfirmationChoice) => {
      sendRpc({ cmd: "confirm_response", id, response });
      dispatch({ t: "resolve_path_access", id });
    },
    [sendRpc],
  );
  const resolveChoice = useCallback(
    (id: number, response: ChoiceVerdict) => {
      sendRpc({ cmd: "choice_response", id, response });
      dispatch({ t: "resolve_choice", id });
    },
    [sendRpc],
  );
  const resolvePlan = useCallback(
    (id: number, response: PlanVerdict) => {
      sendRpc({ cmd: "plan_response", id, response });
      dispatch({ t: "resolve_plan", id, verdict: response });
    },
    [sendRpc],
  );
  const resolveCheckpoint = useCallback(
    (id: number, response: CheckpointVerdict) => {
      sendRpc({ cmd: "checkpoint_response", id, response });
      dispatch({ t: "resolve_checkpoint", id, verdict: response });
    },
    [sendRpc],
  );
  const resolveRevision = useCallback(
    (id: number, response: RevisionVerdict) => {
      sendRpc({ cmd: "revision_response", id, response });
      dispatch({ t: "resolve_revision", id, verdict: response });
    },
    [sendRpc],
  );

  const messageItems = state.messages;
  const transcriptFollowRef = useRef(true);
  const followFrameIdsRef = useRef<number[]>([]);

  const [showJumpButton, setShowJumpButton] = useState(false);
  const cancelScheduledTranscriptFollow = useCallback(() => {
    for (const id of followFrameIdsRef.current) window.cancelAnimationFrame(id);
    followFrameIdsRef.current = [];
  }, []);
  const requestTranscriptFollow = useCallback(
    (smooth = false, followUpFrames = 8) => {
      if (!transcriptFollowRef.current) return false;
      const didScroll = scrollVirtuosoToBottom(virtuosoRef, messageItems.length, smooth);
      if (!didScroll) return false;
      setShowJumpButton(false);
      cancelScheduledTranscriptFollow();

      let remaining = followUpFrames;
      const tick = () => {
        if (!transcriptFollowRef.current) return;
        scrollVirtuosoToBottom(virtuosoRef, messageItems.length, false);
        if (remaining <= 0) return;
        remaining -= 1;
        followFrameIdsRef.current.push(window.requestAnimationFrame(tick));
      };
      followFrameIdsRef.current.push(window.requestAnimationFrame(tick));
      return true;
    },
    [cancelScheduledTranscriptFollow, messageItems.length],
  );
  useEffect(() => cancelScheduledTranscriptFollow, [cancelScheduledTranscriptFollow]);
  useEffect(() => {
    transcriptFollowRef.current = true;
    setShowJumpButton(false);
  }, [state.currentSession]);
  const scrollToBottom = useCallback(
    (smooth = true) => {
      transcriptFollowRef.current = true;
      requestTranscriptFollow(smooth, 3);
    },
    [requestTranscriptFollow],
  );

  const handleTranscriptBottomState = useCallback((atBottom: boolean) => {
    if (atBottom) {
      transcriptFollowRef.current = true;
      setShowJumpButton(false);
      return;
    }
    setShowJumpButton(!transcriptFollowRef.current);
  }, []);

  useEffect(() => {
    const el = virtuosoScroller;
    if (!el) return;

    let pendingFrame = 0;
    const updateAfterGesture = () => {
      transcriptFollowRef.current = false;
      if (pendingFrame) window.cancelAnimationFrame(pendingFrame);
      pendingFrame = window.requestAnimationFrame(() => {
        pendingFrame = 0;
        const atBottom = isScrollElementNearBottom(el);
        transcriptFollowRef.current = atBottom;
        setShowJumpButton(!atBottom);
      });
    };

    let dragging = false;
    const onScrollDuringDrag = () => {
      const atBottom = isScrollElementNearBottom(el);
      transcriptFollowRef.current = atBottom;
      setShowJumpButton(!atBottom);
    };
    const onPointerDown = () => {
      updateAfterGesture();
      if (dragging) return;
      dragging = true;
      el.addEventListener("scroll", onScrollDuringDrag, { passive: true });
    };
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      el.removeEventListener("scroll", onScrollDuringDrag);
      updateAfterGesture();
    };

    el.addEventListener("wheel", updateAfterGesture, { passive: true });
    el.addEventListener("touchmove", updateAfterGesture, { passive: true });
    el.addEventListener("keydown", updateAfterGesture);
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      if (pendingFrame) window.cancelAnimationFrame(pendingFrame);
      el.removeEventListener("wheel", updateAfterGesture);
      el.removeEventListener("touchmove", updateAfterGesture);
      el.removeEventListener("keydown", updateAfterGesture);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("scroll", onScrollDuringDrag);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [virtuosoScroller]);

  const wasTranscriptBusyRef = useRef(state.busy);
  useEffect(() => {
    if (wasTranscriptBusyRef.current !== state.busy) {
      transcriptFollowRef.current = true;
      const id = window.requestAnimationFrame(() => requestTranscriptFollow(true, 8));
      wasTranscriptBusyRef.current = state.busy;
      return () => window.cancelAnimationFrame(id);
    }
    wasTranscriptBusyRef.current = state.busy;
  }, [state.busy, requestTranscriptFollow]);

  useEffect(() => {
    if (!state.busy || messageItems.length === 0) return;
    const id = window.requestAnimationFrame(() => {
      requestTranscriptFollow(false, 8);
    });
    return () => window.cancelAnimationFrame(id);
  }, [
    state.busy,
    messageItems,
    state.pendingCheckpoints.length,
    state.pendingChoices.length,
    state.pendingConfirms.length,
    state.pendingPathAccess.length,
    state.pendingPlans.length,
    state.pendingRevisions.length,
    requestTranscriptFollow,
  ]);

  useEffect(() => {
    if (!transcriptFollowRef.current || messageItems.length === 0) return;
    const id = window.requestAnimationFrame(() => requestTranscriptFollow(false, 6));
    return () => window.cancelAnimationFrame(id);
  }, [
    ctxCollapsed,
    ctxWidth,
    sideCollapsed,
    sideWidth,
    state.pendingCheckpoints.length,
    state.pendingChoices.length,
    state.pendingConfirms.length,
    state.pendingPathAccess.length,
    state.pendingPlans.length,
    state.pendingRevisions.length,
    messageItems.length,
    requestTranscriptFollow,
  ]);

  // Persist the transcript scroll offset per session so a restart reopens
  // the conversation where the user left it (#1244).
  useEffect(() => {
    const el = virtuosoScroller;
    const session = state.currentSession;
    if (!el || !session) return;
    const key = `jupiter.scroll.${session}`;
    let timer: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
        if (atBottom) localStorage.removeItem(key);
        else localStorage.setItem(key, String(Math.round(el.scrollTop)));
      }, 250);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      clearTimeout(timer);
    };
  }, [state.currentSession, virtuosoScroller]);

  useEffect(() => {
    if (!active) return;
    if (!jobsOpen) return;
    sendRpc({ cmd: "jobs_list" });
    const id = window.setInterval(() => sendRpc({ cmd: "jobs_list" }), 1500);
    return () => window.clearInterval(id);
  }, [active, jobsOpen, sendRpc]);

  useEffect(() => {
    if (!active) return;
    if (state.busy) return;
    sendRpc({ cmd: "jobs_list" });
  }, [active, state.busy, sendRpc]);

  useEffect(() => {
    if (!active) return;
    loadQQSettings();
    loadFeishuSettings();
    loadDingTalkSettings();
  }, [active, loadDingTalkSettings, loadQQSettings, loadFeishuSettings]);

  useEffect(() => {
    // Every TabRuntime stays mounted (display:none on inactive), so each registers its own keydown — without this gate Cmd+N would fire newChat() in every tab and wipe the inactive ones' sessions.
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const shortcut = matchDesktopShortcut(e);
      const panelMode = shortcut ? PANEL_SHORTCUT_MODES[shortcut] : undefined;
      if (mod && (e.key === "a" || e.key === "A")) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA") e.preventDefault();
        return;
      }
      if (shortcut === "focus-composer") {
        e.preventDefault();
        composerRef.current?.focus();
      } else if (shortcut === "new-chat") {
        e.preventDefault();
        newChat();
      } else if (shortcut === "pick-workspace") {
        e.preventDefault();
        setWdAnchor(undefined);
        setWdOpen((v) => !v);
      } else if (shortcut === "settings") {
        e.preventDefault();
        if (settingsCardOpen) setSettingsCardOpen(false);
        else setSettingsCardOpen(true);
      } else if (shortcut === "keyboard-shortcuts") {
        e.preventDefault();
        openSettingsAt("shortcuts");
      } else if (shortcut === "jobs") {
        e.preventDefault();
        setJobsOpen((v) => !v);
      } else if (shortcut === "toggle-bottom-bar") {
        e.preventDefault();
        toggleBottomPanel();
      } else if (panelMode) {
        e.preventDefault();
        openContextPanelMode(panelMode);
      } else if (shortcut === "stop-current-run" && state.busy) {
        if (settingsOpen || settingsCardOpen || aboutOpen || jobsOpen || wdOpen || palette.open)
          return;
        e.preventDefault();
        abort();
      } else if (e.key === "Escape" && state.busy) {
        const target = e.target as HTMLElement | null;
        if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
        // A modal is open — let its own Esc handler close it (#1670).
        if (settingsOpen || settingsCardOpen || aboutOpen || jobsOpen || wdOpen) return;
        e.preventDefault();
        abort();
      } else if (e.key === "Enter" && !mod && !e.shiftKey && !e.altKey) {
        // Defer to any control that already handles Enter — native inputs/buttons,
        // ARIA button/link widgets (sidebar rows, file pills), or anything that called
        // preventDefault — so we only grant when focus is on inert layout (#2015).
        if (e.defaultPrevented) return;
        const target = e.target as HTMLElement | null;
        if (
          target?.isContentEditable ||
          target?.closest('input, textarea, button, select, a, [role="button"], [role="link"]')
        ) {
          return;
        }
        if (settingsOpen || settingsCardOpen || aboutOpen || jobsOpen || wdOpen) return;
        // Enter grants the pending authorization prompt (run once), matching the
        // TUI where Enter confirms the highlighted choice (#1962).
        const confirm = state.pendingConfirms.at(-1);
        if (confirm) {
          e.preventDefault();
          resolveConfirm(confirm.id, { type: "run_once" });
          return;
        }
        const pathAccess = state.pendingPathAccess.at(-1);
        if (pathAccess) {
          e.preventDefault();
          resolvePathAccess(pathAccess.id, { type: "run_once" });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    active,
    state.busy,
    state.pendingConfirms,
    state.pendingPathAccess,
    resolveConfirm,
    resolvePathAccess,
    abort,
    newChat,
    openContextPanelMode,
    openSettingsAt,
    toggleBottomPanel,
    settingsOpen,
    settingsCardOpen,
    aboutOpen,
    jobsOpen,
    wdOpen,
    palette.open,
  ]);

  const commands = buildCommands({
    newChat: () => {
      newChat();
      flashToast(t("app.toast.newSession"));
    },
    clearChat: () => {
      clearConversation();
      flashToast(t("app.toast.cleared"));
    },
    focusComposer: () => composerRef.current?.focus(),
    openSettings: () => setSettingsCardOpen(true),
    about: () => setAboutOpen(true),
    abort,
    copyLast: () => {
      const last = [...state.messages].reverse().find((m) => m.kind === "assistant");
      if (!last || last.kind !== "assistant") return;
      const text = last.segments
        .filter((s): s is { kind: "text"; text: string } => s.kind === "text")
        .map((s) => s.text)
        .join("\n\n")
        .trim();
      if (text) {
        void navigator.clipboard.writeText(text);
        flashToast(t("app.toast.copied"));
      }
    },
    conversationCopy: () => {
      conversationCopy();
    },
    exportMarkdown: () => {
      exportConversation();
    },
    pickWorkspace,
    newTab: onNewTab,
    closeTab: onCloseTab,
    busy: state.busy,
    canCloseTab,
    hasMessages: state.messages.length > 0,
    workflowCommands: BUILT_IN_WORKFLOWS.map((workflow) => ({
      id: `workflow-${workflow.id}`,
      label: `Workflow: ${workflow.title}`,
      hint: workflow.description,
      run: () => {
        setDraft(`/workflow start ${workflow.id} `);
        composerRef.current?.focus();
      },
    })),
  });

  const slashSettingCommands: SlashCmd[] = buildSlashSettingsDescriptors().map(
    ({ cmd, action }) => ({
      cmd,
      desc:
        action.type === "editMode"
          ? t("app.cmd.setMode", {
              mode: t(`editMode.${action.editMode}` as any),
            })
          : t("app.cmd.setEffort", { effort: action.reasoningEffort }),
      run: () => applySlashSettingsCommand(action),
    }),
  );

  const slashCommands: SlashCmd[] = [
    {
      cmd: "/help",
      desc: t("app.cmd.help"),
      run: () => {
        setDraft("/");
        composerRef.current?.focus();
      },
    },
    { cmd: "/new", desc: t("app.cmd.newSession"), run: () => newChat() },
    {
      cmd: "/clear",
      desc: t("app.cmd.clearChat"),
      run: () => clearConversation(),
    },
    { cmd: "/abort", desc: t("app.cmd.abort"), run: () => abort() },
    {
      cmd: "/copy",
      desc: t("app.cmd.copyLast"),
      run: () => {
        const last = [...state.messages].reverse().find((m) => m.kind === "assistant");
        if (last?.kind === "assistant") {
          const text = last.segments
            .filter((s): s is { kind: "text"; text: string } => s.kind === "text")
            .map((s) => s.text)
            .join("\n\n");
          if (text) {
            void navigator.clipboard.writeText(text);
            flashToast(t("app.toast.copied"));
          }
        }
      },
    },
    {
      cmd: "/model",
      desc: t("app.cmd.switchModel"),
      run: () => openSettingsAt("models"),
    },
    {
      cmd: "/search-engine",
      desc: t("app.cmd.searchEngine"),
      run: () => openSettingsAt("mcp"),
    },
    {
      cmd: "/skill",
      desc: t("app.cmd.skill"),
      run: () => openSettingsAt("skills"),
    },
    {
      cmd: "/skills",
      desc: t("app.cmd.skill"),
      run: () => openSettingsAt("skills"),
    },
    ...slashSettingCommands,
    { cmd: "/theme", desc: t("app.cmd.toggleTheme"), run: onToggleTheme },
    {
      cmd: "/currency",
      desc: t("app.cmd.toggleCurrency"),
      run: onToggleCurrency,
    },
    {
      cmd: "/lang",
      desc: t("app.cmd.toggleLang"),
      run: () => {
        const langs = getSupportedLangs();
        const next = langs[(langs.indexOf(getLang()) + 1) % langs.length] ?? "en";
        setLang(next);
        const langName = getLangLabel(next);
        if (shouldShowSettingsChangeToast("language")) {
          flashToast(t("app.toast.langSwitched", { lang: langName }));
        }
      },
    },
    {
      cmd: "/export",
      desc: t("app.cmd.exportMd"),
      run: () => exportConversation(),
    },
    {
      cmd: "/compact",
      desc: t("app.cmd.compact"),
      run: () => {
        dispatch({ t: "push_status", text: t("app.compact.starting") });
        sendRpc({ cmd: "compact_history" });
      },
    },
    {
      cmd: "/retry",
      desc: t("app.cmd.retry"),
      run: () => sendRpc({ cmd: "retry" }),
    },
    {
      cmd: "/btw",
      desc: t("app.cmd.btw"),
      run: () => {
        // Sets the draft to /btw so the user can type their question.
        // The send() handler detects the /btw prefix and routes to the btw RPC.
        setDraft("/btw ");
        composerRef.current?.focus();
      },
    },
    ...state.skills.map((s) => ({
      cmd: `/${s.name}`,
      desc: s.description?.trim() || fallbackSkillDesc(s),
      insertOnly: true,
      run: () => {
        recordAbortDraft("skill_run", `/${s.name}`);
        dispatch({
          t: "start_skill",
          skill: { name: s.name, runAs: s.runAs },
          clientId: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
        sendRpc({ cmd: "skill_run", name: s.name });
      },
    })),
  ];
  const slashCommandNames = new Set(slashCommands.map((command) => command.cmd.replace(/^\//, "")));
  const cliSlashCommands: SlashCmd[] = DESKTOP_CLI_SLASH_COMMANDS.filter(
    (spec) => !slashCommandNames.has(spec.cmd),
  ).map((spec) => ({
    cmd: `/${spec.cmd}`,
    desc: spec.argsHint ? `${spec.argsHint} · ${spec.summary}` : spec.summary,
    insertOnly: true,
    run: () => {
      setDraft(`/${spec.cmd} `);
      composerRef.current?.focus();
    },
  }));
  const allSlashCommands = [...slashCommands, ...cliSlashCommands];

  const elapsed = useElapsed(state.busy);
  const workspaceLabel = state.settings?.workspaceDir
    ? displayWorkspaceBasename(state.settings.workspaceDir)
    : "Jupiter";
  const session = (() => {
    if (state.currentSession) {
      const s = state.sessions.find((x) => x.name === state.currentSession);
      if (s?.summary?.trim()) return s.summary.trim();
    }
    const firstUser = state.messages.find((m) => m.kind === "user");
    if (firstUser && firstUser.kind === "user") {
      const cleaned = firstUser.text.replace(/\s+/g, " ").trim();
      if (cleaned) return cleaned.length > 60 ? `${cleaned.slice(0, 60)}…` : cleaned;
    }
    if (state.currentSession) {
      const m = state.currentSession.match(/^desktop-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
      if (m)
        return t("app.session.format", {
          month: m[2],
          day: m[3],
          hour: m[4],
          minute: m[5],
        });
    }
    return state.messages.length === 0
      ? t("app.session.new", { workspace: workspaceLabel })
      : workspaceLabel;
  })();

  const openWorkspacePickerFromComposer = (anchor: {
    top?: number;
    bottom?: number;
    left: number;
  }) => {
    setWdAnchor(anchor);
    setWdOpen(true);
  };

  const handleEmptySuggestion = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.startsWith("/")) {
      const cmd = trimmed.split(/\s+/)[0] ?? "";
      const match = allSlashCommands.find((s) => s.cmd === cmd);
      if (match) {
        match.run();
        return;
      }
    }
    send(text);
  };

  const renderComposer = (variant: "default" | "hero" = "default") => (
    <Composer
      draft={draft}
      setDraft={setDraft}
      onSend={(payload) => send(undefined, payload)}
      onAbort={abort}
      disabled={!state.ready}
      busy={state.busy}
      busyLabel={state.busy ? t("app.thinkingNow") : undefined}
      busyElapsedMs={elapsed}
      textareaRef={composerRef}
      modelLabel={state.settings?.model ?? "deepseek-v4-flash"}
      reasoningEffort={state.settings?.reasoningEffort ?? "high"}
      onModelChange={(model) => {
        applySettingsPatch({ model });
        if (shouldShowSettingsChangeToast("model")) {
          flashToast(t("app.toast.modelSwitched", { model }));
        }
      }}
      onEffortChange={applyReasoningEffort}
      editMode={desktopEditMode(state.settings?.editMode)}
      onEditModeChange={applyEditMode}
      planArmed={oneShotPlanArmed}
      onPlanArmedChange={setOneShotPlanArmed}
      workspaceDir={state.settings?.workspaceDir}
      slashCommands={allSlashCommands}
      onMentionQuery={queryMentions}
      onMentionPreview={previewMention}
      onMentionPicked={markMentionPicked}
      mentionResults={state.mentionResults}
      onOpenSourceSearch={openLibrarySearch}
      variant={variant}
      workspacePickerLabel={variant === "hero" ? workspaceLabel : undefined}
      onOpenWorkspacePicker={
        variant === "hero" ? openWorkspacePickerFromComposer : undefined
      }
      queuedSends={state.queuedSends}
      onQueueWhileBusy={(text) => {
        dispatch({ t: "enqueue_send", text });
        setDraft("");
      }}
      onDequeueSend={(index) => dispatch({ t: "dequeue_send", index })}
      onPrioritizeQueuedSend={prioritizeQueuedSend}
      initialHistory={state.settings?.promptHistory}
      onHistoryPush={(entry) => {
        // Use saveSettings (RPC only, no local state patch) so the
        // sentinel [entry] is never written into state.settings and
        // historyRef is not transiently reset. The backend merges
        // against the freshly-loaded persisted list and re-emits
        // $settings with the merged result (#2051).
        saveSettings({ promptHistory: [entry] });
      }}
    />
  );

  const exportConversation = useCallback(async () => {
    const userLabel = t("app.exportUserLabel");
    const md = formatConversationMarkdown(state.messages, userLabel);
    if (!md) {
      flashToast(t("app.toast.emptySession"));
      return;
    }
    try {
      const filename = defaultExportFilename(session);
      const path = await saveDialog({
        defaultPath: filename,
        filters: [{ name: "Markdown", extensions: ["md"] }],
        title: t("app.toast.exportDialogTitle"),
      });
      if (!path) return;
      await invoke("write_text_file", { path, content: md });
      flashToast(t("app.toast.exportedMd"));
    } catch (err) {
      console.error("export failed", err);
      flashToast(t("app.toast.exportFailed", { error: String(err) }));
    }
  }, [state.messages, session, flashToast]);

  const exportWorkflowRun = useCallback(
    async (run: WorkflowRun) => {
      try {
        const filename = defaultExportFilename(run.title || run.id);
        const path = await saveDialog({
          defaultPath: filename,
          filters: [{ name: "Markdown", extensions: ["md"] }],
          title: t("app.toast.exportDialogTitle"),
        });
        if (!path) return;
        await invoke("write_text_file", { path, content: formatWorkflowRunMarkdown(run) });
        flashToast(t("app.toast.exportedMd"));
      } catch (err) {
        console.error("workflow export failed", err);
        flashToast(t("app.toast.exportFailed", { error: String(err) }));
      }
    },
    [flashToast],
  );

  const conversationCopy = useCallback(() => {
    const userLabel = t("app.exportUserLabel");
    const md = formatConversationMarkdown(state.messages, userLabel);
    if (!md) {
      flashToast(t("app.toast.emptySession"));
      return;
    }
    void navigator.clipboard.writeText(md);
    flashToast(t("app.toast.copiedMd"));
  }, [state.messages, flashToast]);

  const threadVirtuosoComponents = useMemo(
    () => ({
      Header: state.activePlan
        ? () => (
            <div className="thread-inner">
              <PlanBanner
                plan={state.activePlan!}
                onDismiss={state.busy ? undefined : () => dispatch({ t: "dismiss_plan" })}
              />
              <ActivePlanTaskCard plan={state.activePlan!} />
            </div>
          )
        : undefined,
      Footer: () => (
        <div className="thread-bottom-spacer">
          <ThinkingBottomIndicator
            active={shouldShowThinkingFooter(state.messages, state.busy)}
          />
        </div>
      ),
    }),
    [state.activePlan, state.busy, state.messages],
  );

  return (
    <WorkspaceProvider
      value={{
        dir: state.settings?.workspaceDir,
        editor: state.settings?.editor,
        onPreviewFile: previewFile,
        onOpenBrowserUrl: openBrowserUrl,
        onOpenHtmlFile: openHtmlFileInBrowser,
      }}
    >
      <>
        {active ? (
          <>
            <TitleBar
              session={session}
              model={state.settings?.model}
              sideOn={!sideCollapsed}
              ctxOn={!ctxCollapsed}
              contextInfoOn={contextInfoOpen}
              bottomBarOn={!bottomCollapsed}
              onToggleSide={onToggleSide}
              onToggleCtx={toggleContextPanel}
              onShowContextInfo={showContextInfo}
              onToggleBottomBar={toggleBottomPanel}
              onOpenCommands={() => palette.setOpen(true)}
              onOpenSettings={() => openSettingsAt("general")}
              onCopy={conversationCopy}
              onExport={exportConversation}
              onClear={clearConversation}
              hasMessages={state.messages.length > 0}
            />

            <TabBar
              tabs={tabsList}
              activeId={activeTabId}
              setActive={setActiveTabId}
              onClose={(id) => {
                if (tabsList.length <= 1) return;
                invoke("rpc_send", {
                  line: JSON.stringify({ cmd: "tab_close", tabId: id }),
                }).catch((err) => console.error("tab_close failed", err));
              }}
              onNew={onNewTab}
              singleTab={tabsList.length <= 1}
            />
          </>
        ) : null}

        <main
          className="main"
          style={{ display: active ? undefined : "none", position: "relative" }}
        >
          <JumpBar messages={state.messages} virtuosoRef={virtuosoRef} />
          {state.needsSetup ? (
            <NeedsSetupView
              workspaceDir={state.settings?.workspaceDir}
              onPickWorkspace={pickWorkspace}
              onSubmit={(key) => sendRpc({ cmd: "setup_save_key", key })}
            />
          ) : (
            <>
              <MainHead
                session={session}
                busy={state.busy}
                hasMessages={state.messages.length > 0}
                onAbort={abort}
                onCopy={conversationCopy}
                onExport={exportConversation}
              />
              <div className="thread" ref={threadRef}>
                {state.messages.length === 0 ? (
                  <div className="thread-inner thread-inner--standalone">
                    <EmptyState
                      onPick={handleEmptySuggestion}
                      workspaceDir={state.settings?.workspaceDir}
                      composer={renderComposer("hero")}
                    />
                  </div>
                ) : (
                  <Virtuoso
                    ref={virtuosoRef}
                    scrollerRef={setTranscriptScroller}
                    style={{ height: "100%" }}
                    data={messageItems}
                    computeItemKey={(index, item) => chatMessageKey(item, index)}
                    atBottomThreshold={TRANSCRIPT_BOTTOM_THRESHOLD}
                    followOutput={"auto"}
                    atBottomStateChange={handleTranscriptBottomState}
                    totalListHeightChanged={() => {
                      const didFollow = transcriptFollowRef.current
                        ? requestTranscriptFollow(false, 8)
                        : followVirtuosoHeightChange(
                            virtuosoRef,
                            messageItems.length,
                            transcriptFollowRef.current,
                          );
                      if (didFollow) setShowJumpButton(false);
                    }}
                    components={threadVirtuosoComponents}
                    itemContent={(index, m) => {
                      if (!m) return null;
                      if (m.kind === "user") {
                        const rollbackAvailable = canRollbackMessage(
                          state.messages,
                          index,
                          state.busy,
                        );
                        const rollbackTarget = rollbackTargetForMessage(state.messages, index);
                        return (
                          <div className="thread-inner" data-turn={m.turn}>
                            <TurnDivider label={`turn ${m.turn}`} />
                            <UserMsg
                              text={m.text}
                              skill={m.skill}
                              onEdit={onEditUserMsg}
                              rollbackAvailable={rollbackAvailable}
                              onRollback={() => {
                                if (rollbackTarget)
                                  rollbackToMessage(rollbackTarget.turn, rollbackTarget.role);
                              }}
                            />
                          </div>
                        );
                      }
                      if (m.kind === "assistant") {
                        const rollbackAvailable = canRollbackMessage(
                          state.messages,
                          index,
                          state.busy,
                        );
                        const stats = !m.pending ? countFileStats(m.segments) : null;
                        const rollbackTarget = rollbackTargetForMessage(state.messages, index);
                        return (
                          <div className="thread-inner">
                            <AssistantMsg
                              segments={m.segments}
                              pending={m.pending}
                              model={state.model}
                              onApproveConfirm={onApproveConfirm}
                              onRejectConfirm={onRejectConfirm}
                              onAlwaysAllowConfirm={onAlwaysAllowConfirm}
                              pendingConfirms={state.pendingConfirms}
                              rollbackAvailable={rollbackAvailable}
                              onRollback={() => {
                                if (rollbackTarget)
                                  rollbackToMessage(rollbackTarget.turn, rollbackTarget.role);
                              }}
                              processCardsDefaultOpen={
                                state.settings?.processCardsDefaultOpen ?? false
                              }
                            />
                            {stats ? <DiffStats stats={stats} /> : null}
                          </div>
                        );
                      }
                      if (m.kind === "workflow") {
                        return (
                          <div className="thread-inner">
                            <WorkflowRunCard
                              run={m.run}
                              defaultOpen={state.settings?.processCardsDefaultOpen ?? false}
                              onCancel={(runId) => sendRpc({ cmd: "workflow_cancel", runId })}
                              onSaveToLibrary={(runId) =>
                                sendRpc({ cmd: "workflow_save_library", runId })
                              }
                              onInsertResult={() => {
                                setDraft((current) => {
                                  const markdown = formatWorkflowRunMarkdown(m.run).trim();
                                  return current.trim()
                                    ? `${current.trimEnd()}\n\n${markdown}`
                                    : markdown;
                                });
                                composerRef.current?.focus();
                              }}
                              onExportMarkdown={() => {
                                void exportWorkflowRun(m.run);
                              }}
                              onCopyResult={() => {
                                void navigator.clipboard.writeText(formatWorkflowRunMarkdown(m.run));
                                flashToast(t("app.toast.copiedMd"));
                              }}
                            />
                          </div>
                        );
                      }
                      if (m.kind === "status") {
                        return (
                          <div className="thread-inner">
                            <div className="sys-event-row">
                              <span className="line" />
                              <span className="label">{m.text}</span>
                              <span className="line" />
                            </div>
                          </div>
                        );
                      }
                      if (m.kind === "warning") {
                        return (
                          <div className="thread-inner">
                            <div className="warning-card" data-severity={m.severity}>
                              {m.text}
                            </div>
                          </div>
                        );
                      }
                      if (m.kind === "error") {
                        return (
                          <div className="thread-inner">
                            <div className="error-card">
                              <span>{m.message}</span>
                            </div>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                )}
                {showJumpButton ? (
                  <button
                    className="thread-jump-bottom"
                    onClick={() => scrollToBottom(true)}
                    title={t("app.jumpToBottom") ?? "Jump to bottom"}
                    aria-label={t("app.jumpToBottom") ?? "Jump to bottom"}
                  >
                    <I.chev size={16} />
                  </button>
                ) : null}
              </div>

              {state.pendingPlans.length > 0 ||
              state.pendingCheckpoints.length > 0 ||
              state.pendingRevisions.length > 0 ||
              state.pendingConfirms.length > 0 ||
              state.pendingPathAccess.length > 0 ||
              state.pendingChoices.length > 0 ||
              !state.ready ? (
                <div className="pending-approvals">
                  {state.pendingPlans.map((p) => (
                    <PlanApprovalCard
                      key={`pp-${p.id}`}
                      p={p}
                      onApprove={() => resolvePlan(p.id, { type: "approve" })}
                      onRefine={() => resolvePlan(p.id, { type: "refine" })}
                      onCancel={() => resolvePlan(p.id, { type: "cancel" })}
                    />
                  ))}
                  {state.pendingCheckpoints.map((c) => (
                    <CheckpointApprovalCard
                      key={`cp-${c.id}`}
                      c={c}
                      onContinue={() => resolveCheckpoint(c.id, { type: "continue" })}
                      onRevise={() => resolveCheckpoint(c.id, { type: "revise" })}
                      onStop={() => resolveCheckpoint(c.id, { type: "stop" })}
                    />
                  ))}
                  {state.pendingRevisions.map((r) => (
                    <RevisionApprovalCard
                      key={`rv-${r.id}`}
                      r={r}
                      onAccept={() => resolveRevision(r.id, { type: "accepted" })}
                      onReject={() => resolveRevision(r.id, { type: "rejected" })}
                    />
                  ))}
                  {state.pendingConfirms.map((c) => (
                    <ConfirmApprovalCard
                      key={`cc-${c.id}`}
                      prompt={c.prompt}
                      onAllow={() => resolveConfirm(c.id, { type: "run_once" })}
                      onAlwaysAllow={(prefix) =>
                        resolveConfirm(c.id, { type: "always_allow", prefix })
                      }
                      onDeny={() => resolveConfirm(c.id, { type: "deny" })}
                    />
                  ))}
                  {state.pendingPathAccess.map((p) => (
                    <PathAccessApprovalCard
                      key={`pa-${p.id}`}
                      prompt={p.prompt}
                      onAllow={() => resolvePathAccess(p.id, { type: "run_once" })}
                      onAlwaysAllow={(prefix) =>
                        resolvePathAccess(p.id, {
                          type: "always_allow",
                          prefix,
                        })
                      }
                      onDeny={() => resolvePathAccess(p.id, { type: "deny" })}
                    />
                  ))}
                  {state.pendingChoices.map((c) => (
                    <ChoiceApprovalCard
                      key={`ch-${c.id}`}
                      c={c}
                      onPick={(optionId) => resolveChoice(c.id, { type: "pick", optionId })}
                      onCancel={() => resolveChoice(c.id, { type: "cancel" })}
                    />
                  ))}
                  {!state.ready ? (
                    <div
                      style={{
                        padding: 12,
                        color: "var(--muted)",
                        fontFamily: "Geist Mono, monospace",
                        fontSize: 11,
                      }}
                    >
                      {t("app.connecting")}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {state.messages.length > 0 ? renderComposer() : null}
              <SourceSearchPopover
                open={sourceSearchOpen}
                sources={librarySources}
                sourceSearch={state.sourceSearchResults}
                onClose={() => setSourceSearchOpen(false)}
                onSourceSearch={searchLibrarySources}
                onAddSource={addLibrarySource}
                onOpenWebSource={openBrowserUrl}
                onPreviewFileSource={(path) => previewFile({ path })}
                onRevealFileSource={revealLibraryFileSource}
              />
            </>
          )}
        </main>

        {active ? (
          <>
            {(!ctxCollapsed || contextInfoOpen) && bottomCollapsed ? (
              <div
                className="resize-handle"
                data-side="right"
                data-dragging={undefined}
                role="separator"
                aria-orientation="vertical"
                aria-label={t("app.resizeContextSidebar")}
                title={t("app.resizeContextSidebar")}
                tabIndex={0}
                onMouseDown={onCtxResizeDown}
              />
            ) : null}
            {!bottomCollapsed ? (
              <div
                className="resize-handle"
                data-side="bottom"
                data-dragging={undefined}
                role="separator"
                aria-orientation="horizontal"
                aria-label={t("app.resizeBottomBar")}
                title={t("app.resizeBottomBar")}
                tabIndex={0}
                onMouseDown={onBottomResizeDown}
              />
            ) : null}
            <ContextPanel
              settings={state.settings}
              usage={state.usage}
              mcpSpecs={state.mcpSpecs}
              mcpBridged={state.mcpBridged}
              subagents={state.subagents}
              sessionFiles={state.sessionFiles}
              memory={state.memory}
              memoryDetail={state.memoryDetail}
              librarySources={librarySources}
              librarySearchFocusNonce={librarySearchFocusNonce}
              sourceSearch={state.sourceSearchResults}
              selectedFilePreview={filePreview.preview}
              filePreviewLoading={filePreview.loading}
              filePreviewError={filePreview.error}
              filePreviewPath={filePreview.target?.path ?? null}
              tabs={contextTabState.tabs}
              activeTabId={contextTabState.activeId}
              onTabSelect={selectContextTab}
              onTabClose={closeContextTab}
              onNewTabMode={openContextPanelMode}
              onCloseSidebar={() => {
                if (!bottomCollapsed) {
                  toggleBottomPanel();
                  return;
                }
                if (!ctxCollapsed) onToggleCtx();
              }}
              onMentionQuery={queryMentions}
              onMentionPicked={markMentionPicked}
              mentionResults={state.mentionResults}
              sideChats={state.sideChats}
              sideChatBusy={state.sideChats.some((entry) => entry.status === "pending")}
              sideChatDisabled={!state.ready}
              onSideChatSend={sendSideChat}
              visible={bottomCollapsed ? !ctxCollapsed && !contextInfoOpen : !bottomCollapsed}
              placement={bottomCollapsed ? "side" : "bottom"}
              onOpenSubagent={(name) => {
                clearAbortDraft();
                sendRpc({ cmd: "session_load", name, openInNewTab: isTabBusy() });
              }}
              onReadMemory={(path) => sendRpc({ cmd: "memory_read", path })}
              onSourceSearch={searchLibrarySources}
              onAddLibrarySource={addLibrarySource}
              onRemoveLibrarySource={removeLibrarySource}
              onImportLibraryFiles={importLibraryFiles}
              onOpenWebSource={openBrowserUrl}
              onRevealFileSource={revealLibraryFileSource}
              onPreviewFile={previewFile}
              onOpenHtmlFile={openHtmlFileInBrowser}
            />
            <ContextInfoPopover
              open={contextInfoOpen}
              settings={state.settings}
              usage={state.usage}
              mcpSpecs={state.mcpSpecs}
              mcpBridged={state.mcpBridged}
              subagents={state.subagents}
              sessionFiles={state.sessionFiles}
              memory={state.memory}
              memoryDetail={state.memoryDetail}
              activePath={
                activeContextTab?.filePreview?.path ??
                activeContextTab?.filePreviewPath ??
                filePreview.preview?.path ??
                filePreview.target?.path ??
                null
              }
              onOpenSubagent={(name) => {
                clearAbortDraft();
                sendRpc({ cmd: "session_load", name, openInNewTab: isTabBusy() });
              }}
              onReadMemory={(path) => sendRpc({ cmd: "memory_read", path })}
              onPreviewFile={previewFile}
            />

            {settingsCardOpen ? (
              <SettingsStatusCard
                balance={state.balance}
                usage={state.usage}
                currency={currency}
                theme={theme}
                themeStyle={themeStyle}
                jobs={state.jobs}
                jobsOpen={jobsOpen}
                onToggleJobs={() => {
                  setJobsOpen((v) => !v);
                  setSettingsCardOpen(false);
                }}
                onSetThemeStyle={onSetThemeStyle}
                onToggleTheme={onToggleTheme}
                onToggleCurrency={onToggleCurrency}
                onOpenSettings={() => openSettingsAt("general")}
                onClose={() => setSettingsCardOpen(false)}
              />
            ) : null}

            <CommandPalette
              open={palette.open}
              onClose={() => palette.setOpen(false)}
              commands={commands}
            />

            <WorkdirPop
              open={wdOpen}
              onClose={() => setWdOpen(false)}
              recent={state.settings?.recentWorkspaces ?? []}
              current={state.settings?.workspaceDir}
              anchor={wdAnchor}
              onPick={(path) => {
                clearAbortDraft();
                saveSettings({ workspaceDir: path });
              }}
              onBrowse={pickWorkspace}
              onRemoveRecent={(path) => {
                const nextRecent = (state.settings?.recentWorkspaces ?? []).filter(
                  (p) => p !== path,
                );
                applySettingsPatch({ recentWorkspaces: nextRecent });
              }}
            />

            {aboutOpen ? (
              <AboutModal
                onClose={() => setAboutOpen(false)}
                updateCheck={updateCheck}
                onCheckUpdates={onCheckUpdates}
                onOpenRelease={onOpenUpdateRelease}
              />
            ) : null}

            {settingsOpen && state.settings ? (
              <SettingsModal
                settings={state.settings}
                balance={state.balance}
                usage={state.usage}
                currency={currency}
                theme={theme}
                themeStyle={themeStyle}
                onSetTheme={onSetTheme}
                onSetThemeStyle={onSetThemeStyle}
                fontScale={fontScale}
                onSetFontScale={onSetFontScale}
                fontFamily={fontFamily}
                onSetFontFamily={onSetFontFamily}
                customFontFamily={customFontFamily}
                onSetCustomFontFamily={onSetCustomFontFamily}
                initialPage={settingsPage}
                mcpSpecs={state.mcpSpecs}
                mcpBridged={state.mcpBridged}
                skills={state.skills}
                skillRoots={state.skillRoots}
                memory={state.memory}
                memoryDetail={state.memoryDetail}
                archivedSessions={state.archivedSessions}
                storageScan={state.storageScan}
                qq={state.qq}
                feishu={state.feishu}
                dingtalk={state.dingtalk}
                onClose={() => setSettingsOpen(false)}
                onSave={applySettingsPatch}
                onSaveApiKey={saveApiKey}
                onSignOutApiKey={signOutApiKey}
                onLoadQQ={loadQQSettings}
                onConnectQQ={connectQQ}
                onDisconnectQQ={disconnectQQ}
                onSaveQQConfig={saveQQConfig}
                onOpenQQApplyLink={() =>
                  openUrl("https://q.qq.com/qqbot/openclaw/login.html").catch(() => undefined)
                }
                onLoadFeishu={loadFeishuSettings}
                onConnectFeishu={connectFeishu}
                onDisconnectFeishu={disconnectFeishu}
                onSaveFeishuConfig={saveFeishuConfig}
                onOpenFeishuApplyLink={() =>
                  openUrl("https://open.feishu.cn/app").catch(() => undefined)
                }
                onLoadDingTalk={loadDingTalkSettings}
                onConnectDingTalk={connectDingTalk}
                onDisconnectDingTalk={disconnectDingTalk}
                onSaveDingTalkConfig={saveDingTalkConfig}
                onOpenDingTalkApplyLink={() =>
                  openUrl("https://open-dev.dingtalk.com/").catch(() => undefined)
                }
                onPickWorkspace={pickWorkspace}
                onAddMcpSpec={addMcpSpec}
                onRemoveMcpSpec={removeMcpSpec}
                onEnableMcpSpec={enableMcpSpec}
                onDisableMcpSpec={disableMcpSpec}
                onReconnectMcpSpecs={reconnectMcpSpecs}
                onAddSkillPath={addSkillPath}
                onRemoveSkillPath={removeSkillPath}
                onCreateSkill={createSkill}
                onSetSkillModel={setSkillModel}
                onReadMemory={(path) => sendRpc({ cmd: "memory_read", path })}
                onRefreshMemory={() => sendRpc({ cmd: "memory_refresh" })}
                onDeleteMemory={(path) => sendRpc({ cmd: "memory_delete", path })}
                onSaveMemory={(input) => sendRpc({ cmd: "memory_save", ...input })}
                onRefreshArchivedSessions={() => sendRpc({ cmd: "session_list_archived" })}
                onRestoreArchivedSession={(name) =>
                  sendRpc({ cmd: "session_restore_archived", name })
                }
                onDeleteArchivedSession={(name) =>
                  sendRpc({ cmd: "session_delete_archived", name })
                }
                onClearArchivedSessions={() => sendRpc({ cmd: "session_clear_archived" })}
                onScanStorage={scanStorage}
                onCleanStorage={cleanStorage}
                onOpenAbout={() => {
                  setSettingsOpen(false);
                  setAboutOpen(true);
                }}
              />
            ) : null}

            <JobsPop
              open={jobsOpen}
              onClose={() => setJobsOpen(false)}
              jobs={state.jobs}
              onStop={(jobId) => sendRpc({ cmd: "jobs_stop", jobId })}
              onStopAll={() => sendRpc({ cmd: "jobs_stop_all" })}
            />

            <Toast message={toast} />

            <AppContextMenu
              workspaceDir={state.settings?.workspaceDir}
              editor={state.settings?.editor}
              onPreviewFile={previewFile}
              onOpenHtmlFile={openHtmlFileInBrowser}
            />
          </>
        ) : null}
      </>
    </WorkspaceProvider>
  );
}

function WinMinimize() {
  return (
    <svg width="10" height="1" viewBox="0 0 10 1" aria-hidden>
      <rect width="10" height="1" fill="currentColor" />
    </svg>
  );
}
function WinMaximize() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect
        x="0.5"
        y="0.5"
        width="9"
        height="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}
function WinRestore() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect
        x="2.5"
        y="0.5"
        width="7"
        height="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <rect
        x="0.5"
        y="2.5"
        width="7"
        height="7"
        fill="var(--bg-2, #eee)"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}
function WinClose() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <line
        x1="0.5"
        y1="0.5"
        x2="9.5"
        y2="9.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <line
        x1="9.5"
        y1="0.5"
        x2="0.5"
        y2="9.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function shouldSkipInactiveTabRuntimeRender(
  prev: { tabId: string; active: boolean },
  next: { tabId: string; active: boolean },
): boolean {
  if (prev.tabId !== next.tabId) return false;
  if (prev.active !== next.active) return false;
  if (prev.active || next.active) return false;
  return true;
}

function areTabRuntimePropsEqual(prev: TabRuntimeProps, next: TabRuntimeProps): boolean {
  return shouldSkipInactiveTabRuntimeRender(prev, next);
}

const TabRuntime = memo(TabRuntimeInner, areTabRuntimePropsEqual);

function TitleBar({
  session,
  model,
  sideOn,
  ctxOn,
  contextInfoOn,
  bottomBarOn,
  onToggleSide,
  onToggleCtx,
  onShowContextInfo,
  onToggleBottomBar,
  onOpenCommands,
  onOpenSettings,
  onCopy,
  onExport,
  onClear,
  hasMessages,
}: {
  session: string;
  model?: string;
  sideOn: boolean;
  ctxOn: boolean;
  contextInfoOn: boolean;
  bottomBarOn: boolean;
  onToggleSide: () => void;
  onToggleCtx: () => void;
  onShowContextInfo: () => void;
  onToggleBottomBar: () => void;
  onOpenCommands: () => void;
  onOpenSettings: () => void;
  onCopy: () => void;
  onExport: () => void;
  onClear: () => void;
  hasMessages: boolean;
}) {
  useLang();
  const [menuOpen, setMenuOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const moreWrapRef = useRef<HTMLDivElement>(null);
  const isMac = document.documentElement.dataset.platform === "macos";

  useEffect(() => {
    const win = getCurrentWindow();
    const syncWindowState = async () => {
      setIsMaximized(await readWindowExpanded(win, isMac));
    };
    void syncWindowState();
    let unlisten: (() => void) | undefined;
    win
      .listen("tauri://resize", async () => {
        await syncWindowState();
      })
      .then((fn) => {
        unlisten = fn;
      });
    let fullscreenUnlisten: (() => void) | undefined;
    win
      .listen("tauri://fullscreen", async () => {
        await syncWindowState();
      })
      .then((fn) => {
        fullscreenUnlisten = fn;
      });
    return () => {
      unlisten?.();
      fullscreenUnlisten?.();
    };
  }, [isMac]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreWrapRef.current && !moreWrapRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const win = getCurrentWindow();

  return (
    <header className="titlebar">
      {/* left: sidebar toggle + brand */}
      <div className="tb-left">
        <button
          type="button"
          className="iconbtn"
          data-on={sideOn}
          title={t("app.titlebar.sidebar")}
          onClick={onToggleSide}
        >
          <I.panel_l size={14} />
        </button>
        <div className="tb-meta" data-tauri-drag-region>
          <div className="brand" data-tauri-drag-region>
            <span className="mark" />
            <span className="brand-name">Jupiter</span>
          </div>
          {session && (
            <div className="crumbs" data-tauri-drag-region>
              <span className="sep">/</span>
              <span className="cur">{model ?? "—"}</span>
            </div>
          )}
        </div>
      </div>

      {/* center: drag region */}
      <span className="grow" data-tauri-drag-region />

      {/* right: panel toggles + more + window controls */}
      <div className="tb-right">
        <button
          type="button"
          className="iconbtn"
          data-on={contextInfoOn}
          title={t("contextPanel.showInfo")}
          aria-label={t("contextPanel.showInfo")}
          onClick={onShowContextInfo}
        >
          <I.info size={14} />
        </button>
        <button
          type="button"
          className="iconbtn"
          data-on={bottomBarOn}
          title={t("contextPanel.toggleBottomBar")}
          aria-label={t("contextPanel.toggleBottomBar")}
          onClick={onToggleBottomBar}
        >
          <I.panel_b size={14} />
        </button>
        <button
          type="button"
          className="iconbtn"
          data-on={ctxOn}
          title={t("contextPanel.toggleRightSidebar")}
          aria-label={t("contextPanel.toggleRightSidebar")}
          onClick={onToggleCtx}
        >
          <I.panel_r size={14} />
        </button>

        <div ref={moreWrapRef} style={{ position: "relative" }}>
          <button
            type="button"
            className="iconbtn"
            title={t("app.titlebar.more")}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <I.more size={14} />
          </button>
          {menuOpen ? (
            <div
              className="popup"
              style={{
                top: "calc(100% + 6px)",
                right: 0,
                left: "auto",
                bottom: "auto",
                width: 220,
              }}
            >
              <div className="popup-list">
                <div
                  className="popup-item"
                  onClick={() => {
                    onOpenCommands();
                    setMenuOpen(false);
                  }}
                >
                  <span className="ico">
                    <I.search size={12} />
                  </span>
                  <div className="nm">
                    <span>{t("app.titlebar.commandPalette")}</span>
                  </div>
                </div>
                <div
                  className="popup-item"
                  onClick={() => {
                    if (hasMessages) onCopy();
                    setMenuOpen(false);
                  }}
                  style={{ opacity: hasMessages ? 1 : 0.5 }}
                >
                  <span className="ico">
                    <I.copy size={12} />
                  </span>
                  <div className="nm">
                    <span>{t("app.titlebar.copyMd")}</span>
                  </div>
                </div>
                <div
                  className="popup-item"
                  onClick={() => {
                    if (hasMessages) onExport();
                    setMenuOpen(false);
                  }}
                  style={{ opacity: hasMessages ? 1 : 0.5 }}
                >
                  <span className="ico">
                    <I.download size={12} />
                  </span>
                  <div className="nm">
                    <span>{t("app.titlebar.exportMd")}</span>
                  </div>
                </div>
                <div
                  className="popup-item"
                  onClick={() => {
                    onClear();
                    setMenuOpen(false);
                  }}
                >
                  <span className="ico">
                    <I.x size={12} />
                  </span>
                  <div className="nm">
                    <span>{t("app.titlebar.clearChat")}</span>
                  </div>
                </div>
                <div
                  className="popup-item"
                  onClick={() => {
                    onOpenSettings();
                    setMenuOpen(false);
                  }}
                >
                  <span className="ico">
                    <I.cog size={12} />
                  </span>
                  <div className="nm">
                    <span>{t("app.titlebar.settings")}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* window controls — use onMouseDown+stopPropagation so the drag region doesn't swallow the event */}
        {isMac ? null : (
          <div className="win-controls">
            <button
              type="button"
              className="win-ctrl"
              title={t("app.titlebar.minimize")}
              onMouseDown={(e) => {
                e.stopPropagation();
                win.minimize();
              }}
            >
              <WinMinimize />
            </button>
            <button
              type="button"
              className="win-ctrl"
              title={isMaximized ? t("app.titlebar.restore") : t("app.titlebar.maximize")}
              onMouseDown={(e) => {
                e.stopPropagation();
                void toggleWindowExpanded(win, false, isMaximized);
              }}
            >
              {isMaximized ? <WinRestore /> : <WinMaximize />}
            </button>
            <button
              type="button"
              className="win-ctrl close"
              title={t("app.titlebar.close")}
              onMouseDown={(e) => {
                e.stopPropagation();
                win.close();
              }}
            >
              <WinClose />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

function TabBar({
  tabs,
  activeId,
  setActive,
  onClose,
  onNew,
  singleTab,
}: {
  tabs: TabMeta[];
  activeId: string;
  setActive: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  singleTab?: boolean;
}) {
  useLang();
  return (
    <div className="tabbar">
      {tabs.map((t) => {
        const ws = t.workspaceDir ?? "";
        const label = displayWorkspaceBasename(ws);
        return (
          <div
            key={t.id}
            className="tab"
            data-active={t.id === activeId}
            onClick={() => setActive(t.id)}
            title={displayWorkspacePath(ws, label)}
          >
            <span className="dot" data-state={t.busy ? "running" : "idle"} />
            <span className="label">{label}</span>
            {!singleTab ? (
              <span
                className="close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
              >
                <I.x size={11} />
              </span>
            ) : null}
          </div>
        );
      })}
      <div className="tab newtab" title={t("app.tab.newTabTitle")} onClick={onNew}>
        <I.plus size={12} />
        <span className="newtab-label">{t("app.tab.newTab")}</span>
      </div>
    </div>
  );
}

function MainHead({
  session,
  busy,
  hasMessages,
  onAbort,
  onCopy,
  onExport,
}: {
  session: string;
  busy: boolean;
  hasMessages: boolean;
  onAbort: () => void;
  onCopy: () => void;
  onExport: () => void;
}) {
  useLang();
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [exportMenuOpen]);

  return (
    <div className="main-head">
      <div className="title-wrap">
        <h1>
          <span className="editable">{session}</span>
          {busy ? (
            <span className="pill" style={{ color: "var(--accent)" }}>
              <span className="dot" />
              <span className="shimmer">{t("app.header.running")}</span>
            </span>
          ) : null}
        </h1>
      </div>
      <span className="grow" />
      <div ref={exportMenuRef} className="head-action-wrap">
        <button
          type="button"
          className="h-btn"
          onClick={() => setExportMenuOpen((v) => !v)}
          disabled={!hasMessages}
          title={`${t("app.header.copy")} / ${t("app.header.export")}`}
        >
          <I.download size={12} /> {t("app.header.export")} <I.chev size={12} />
        </button>
        {exportMenuOpen ? (
          <div
            className="popup"
            style={{
              top: "calc(100% + 6px)",
              right: 0,
              left: "auto",
              bottom: "auto",
              width: 230,
            }}
          >
            <div className="popup-list">
              <div
                className="popup-item"
                onClick={() => {
                  onCopy();
                  setExportMenuOpen(false);
                }}
              >
                <span className="ico">
                  <I.copy size={12} />
                </span>
                <div className="nm">
                  <span>{t("app.header.copyMd")}</span>
                </div>
              </div>
              <div
                className="popup-item"
                onClick={() => {
                  onExport();
                  setExportMenuOpen(false);
                }}
              >
                <span className="ico">
                  <I.download size={12} />
                </span>
                <div className="nm">
                  <span>{t("app.header.exportMd")}</span>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      {busy ? (
        <button type="button" className="h-btn primary" onClick={onAbort}>
          <I.stop size={12} /> {t("app.header.abort")}
        </button>
      ) : null}
    </div>
  );
}

function EmptyState({
  onPick,
  workspaceDir,
  composer,
}: {
  onPick: (text: string) => void;
  workspaceDir?: string;
  composer: ReactNode;
}) {
  const lang = useLang();
  const suggestions = useMemo(
    () =>
      pickEmptySuggestions([
        t("app.empty.suggestion0"),
        t("app.empty.suggestion1"),
        t("app.empty.suggestion2"),
        t("app.empty.suggestion3"),
        t("app.empty.suggestion4"),
        t("app.empty.suggestion5"),
        t("app.empty.suggestion6"),
        t("app.empty.suggestion7"),
        t("app.empty.suggestion8"),
        t("app.empty.suggestion9"),
      ]),
    [lang],
  );
  const wsLabel = workspaceDir ? displayWorkspaceBasename(workspaceDir) : null;
  return (
    <div className="empty-state">
      <div className="empty-logo" />
      <div className="empty-title">{t("app.empty.welcome")}</div>
      <div className="empty-sub">
        {wsLabel ? (
          <>
            {t("app.empty.currentWorkspace")}
            <code>{wsLabel}</code>
          </>
        ) : (
          t("app.empty.selectWorkspace")
        )}
      </div>
      {composer}
      <div className="empty-suggestions">
        {suggestions.map((s) => (
          <button key={s} type="button" className="empty-suggestion" onClick={() => onPick(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

export function NeedsSetupView({
  workspaceDir,
  onPickWorkspace,
  onSubmit,
}: {
  workspaceDir?: string;
  onPickWorkspace: () => void;
  onSubmit: (key: string) => void;
}) {
  useLang();
  const [key, setKey] = useState("");
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        gap: 18,
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 600 }}>{t("app.setup.welcome")}</div>
      <div
        style={{
          fontSize: 12.5,
          color: "var(--muted)",
          maxWidth: 400,
          textAlign: "center",
        }}
      >
        {t("app.setup.description")}
      </div>
      <div
        style={{
          width: "min(420px, 100%)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div className="setting-row" style={{ borderBottom: "none" }}>
          <div className="l">
            <div className="n">{t("app.setup.workspace")}</div>
            <div className="h">
              {displayWorkspacePath(workspaceDir, t("app.setup.notSelected"))}
            </div>
          </div>
          <button type="button" className="btn" onClick={onPickWorkspace}>
            {t("app.setup.choose")}
          </button>
        </div>
        <input
          className="field mono"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-label={t("app.setup.apiKeyLabel")}
          placeholder={t("app.setup.apiKeyPlaceholder")}
          style={{ width: "100%" }}
        />
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 12,
            background: "var(--panel)",
            color: "var(--muted)",
            padding: "11px 12px",
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
          }}
        >
          <I.info size={15} style={{ marginTop: 1, flex: "0 0 auto" }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12.5, fontWeight: 650, color: "var(--fg)" }}>
              {t("app.setup.apiKeyHintTitle")}
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.5, marginTop: 3 }}>
              {t("app.setup.apiKeyHintBody")}
            </div>
            <button
              type="button"
              className="btn ghost"
              style={{ marginTop: 7, padding: "4px 0", height: "auto" }}
              onClick={() => openUrl(DEEPSEEK_API_KEYS_URL).catch(() => undefined)}
              aria-label={t("app.setup.openApiKeysAria")}
            >
              <I.link size={13} />
              {t("app.setup.openApiKeys")}
            </button>
          </div>
        </div>
        <button
          type="button"
          className="btn primary"
          disabled={!key.trim()}
          onClick={() => onSubmit(key.trim())}
        >
          {t("app.setup.saveAndStart")}
        </button>
      </div>
    </div>
  );
}

function UpdateOverlay({
  update,
  onOpenRelease,
  onSkip,
  onDisablePrompts,
  onDismiss,
}: {
  update: AvailableUpdateEvent;
  onOpenRelease: (source: keyof UpdateReleaseUrls) => void;
  onSkip: () => void;
  onDisablePrompts: () => void;
  onDismiss: () => void;
}) {
  useLang();
  return (
    <div className="update-overlay" aria-live="polite">
      <div className="plan-banner update-overlay-card">
        <span className="ico">
          <I.rotate size={14} />
        </span>
        <div className="body">
          <div className="t">
            {t("app.update.available", {
              current: update.currentVersion,
              latest: update.latestVersion,
            })}
          </div>
          <div className="s">{t("app.update.openReleaseHint")}</div>
        </div>
        <div className="prog">
          <button type="button" onClick={() => onOpenRelease("gitee")}>
            {t("app.update.openGitee")}
          </button>
          <button type="button" onClick={() => onOpenRelease("github")}>
            {t("app.update.openGithub")}
          </button>
          <button type="button" onClick={onSkip}>
            {t("app.update.skipVersion")}
          </button>
          <button type="button" onClick={onDisablePrompts}>
            {t("app.update.disablePrompts")}
          </button>
          <button type="button" onClick={onDismiss}>
            {t("app.update.later")}
          </button>
        </div>
      </div>
    </div>
  );
}

type TabMeta = { id: string; workspaceDir?: string; busy?: boolean };
type AvailableUpdateEvent = Extract<UpdateCheckEvent, { status: "available" }>;
type UpdateCheckViewState =
  | UpdateCheckEvent
  | {
      type: "$update_check";
      mode: "manual";
      status: "idle";
      currentVersion: string;
      releaseUrls: UpdateReleaseUrls;
    };

const DEFAULT_UPDATE_RELEASE_URLS: UpdateReleaseUrls = {
  gitee: "https://gitee.com/nighty35628/jupiter/releases",
  github: "https://github.com/nighty35628/Jupiter/releases/latest",
};
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

export function App() {
  const [tabs, setTabs] = useState<TabMeta[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");
  const [splashOn, setSplashOn] = useState<boolean>(() => shouldShowSplash());
  const [startupFailure, setStartupFailure] = useState<StartupFailureState | null>(null);
  const [startupRetryNonce, setStartupRetryNonce] = useState(0);
  const [runtimeSnapshots, setRuntimeSnapshots] = useState<Record<string, TabRuntimeSnapshot>>({});
  const [sidebarSessions, setSidebarSessions] = useState<SessionInfo[]>([]);
  const [sidebarImportSources, setSidebarImportSources] = useState<ExternalSessionApp[]>([]);
  const [sidebarImportCandidates, setSidebarImportCandidates] = useState<ExternalSessionCandidate[]>(
    [],
  );
  const dispatchersRef = useRef<Map<string, TabDispatcher>>(new Map());
  const pendingEventsRef = useRef<Map<string, TabAction[]>>(new Map());
  const runtimeControlsRef = useRef<Map<string, TabRuntimeControls>>(new Map());
  const rpcSendQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
  const startupStderrRef = useRef<string[]>([]);
  const tabsRef = useRef<TabMeta[]>([]);
  const pendingRestoredFocusRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const [pendingUpdate, setPendingUpdate] = useState<AvailableUpdateEvent | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckViewState>({
    type: "$update_check",
    mode: "manual",
    status: "idle",
    currentVersion: APP_VERSION,
    releaseUrls: DEFAULT_UPDATE_RELEASE_URLS,
  });
  const [currency, setCurrency] = useState<"CNY" | "USD">(() => {
    const v = localStorage.getItem("jupiter.currency");
    return v === "USD" ? "USD" : "CNY";
  });
  const [theme, setTheme] = useState<Theme>(() => {
    const v = localStorage.getItem("jupiter.theme");
    const style = localStorage.getItem("jupiter.themeStyle");
    if (isThemeStyle(style)) return themeForStyle(style);
    return isTheme(v) ? v : THEME.LIGHT;
  });
  const [themeStyle, setThemeStyle] = useState<ThemeStyle>(() => {
    const style = localStorage.getItem("jupiter.themeStyle");
    if (isThemeStyle(style)) return style;
    const storedTheme = localStorage.getItem("jupiter.theme");
    return defaultStyleForTheme(isTheme(storedTheme) ? storedTheme : THEME.LIGHT);
  });
  const [fontScale, setFontScale] = useState<FontScale>(() => {
    const v = localStorage.getItem("jupiter.fontScale");
    return isFontScale(v) ? v : FONT_SCALE.MEDIUM;
  });
  const [fontFamily, setFontFamily] = useState<FontFamily>(() => {
    const v = localStorage.getItem("jupiter.fontFamily");
    return isFontFamily(v) ? v : FONT_FAMILY.SANS;
  });
  const [customFontFamily, setCustomFontFamily] = useState<string>(() => {
    return localStorage.getItem("jupiter.customFontFamily") ?? "";
  });
  const {
    collapsed: sideCollapsed,
    toggle: onToggleSide,
    requireCollapsed: requireSideCollapsed,
    releaseCollapsed: releaseSideCollapsed,
  } = useAutoCollapse("jupiter.sideCollapsed");
  const {
    collapsed: ctxCollapsed,
    toggle: onToggleCtx,
    requireCollapsed: requireCtxCollapsed,
    releaseCollapsed: releaseCtxCollapsed,
  } = useAutoCollapse("jupiter.ctxCollapsed");
  const {
    collapsed: bottomCollapsed,
    toggle: onToggleBottom,
    requireCollapsed: requireBottomCollapsed,
  } = useAutoCollapse("jupiter.bottomCollapsed", true);

  const { width: sideWidth, onMouseDown: onSideResizeDown } = useResizable("side", sideCollapsed);
  const { width: ctxWidth, onMouseDown: onCtxResizeDown } = useResizable("ctx", ctxCollapsed, true);
  const { height: bottomHeight, onMouseDown: onBottomResizeDown } =
    useBottomResizable(bottomCollapsed);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themeStyle = themeStyle;
    localStorage.setItem("jupiter.theme", theme);
    localStorage.setItem("jupiter.themeStyle", themeStyle);
  }, [theme, themeStyle]);

  useEffect(() => {
    let raf = 0;
    let prevStage: ResponsiveStage | null = null;

    const sync = () => {
      raf = 0;
      const width = window.innerWidth;
      setViewportWidth(width);
      const next = responsiveStage(width);
      if (prevStage === next) return;
      const prev = prevStage;
      prevStage = next;

      if (next === RESPONSIVE_STAGE.WIDE) {
        releaseCtxCollapsed();
        releaseSideCollapsed();
      } else if (next === RESPONSIVE_STAGE.COMPACT) {
        // Only force ctx collapse when entering compact from wider — coming
        // from narrow, the user may have manually opened ctx and we keep that.
        if (prev === null || prev === RESPONSIVE_STAGE.WIDE) requireCtxCollapsed();
        requireBottomCollapsed();
        releaseSideCollapsed();
      } else {
        requireCtxCollapsed();
        requireBottomCollapsed();
        requireSideCollapsed();
      }
    };

    const onResize = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(sync);
    };

    sync();
    window.addEventListener("resize", onResize);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [
    requireBottomCollapsed,
    requireCtxCollapsed,
    releaseCtxCollapsed,
    requireSideCollapsed,
    releaseSideCollapsed,
  ]);

  useEffect(() => {
    // Chromium webview supports `zoom`; scales every px-based size without touching CSS rules.
    document.documentElement.style.setProperty("zoom", String(FONT_SCALE_ZOOM[fontScale]));
    localStorage.setItem("jupiter.fontScale", fontScale);
  }, [fontScale]);

  useEffect(() => {
    const custom = customFontFamily.trim();
    const stack =
      fontFamily === FONT_FAMILY.CUSTOM && custom
        ? custom
        : (FONT_FAMILY_STACK[fontFamily] ?? FONT_FAMILY_STACK.sans);
    document.documentElement.style.setProperty("--font-sans", stack);
    localStorage.setItem("jupiter.fontFamily", fontFamily);
    localStorage.setItem("jupiter.customFontFamily", customFontFamily);
  }, [fontFamily, customFontFamily]);

  useEffect(() => {
    const onCur = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail === "CNY" || detail === "USD") setCurrency(detail);
    };
    window.addEventListener("jupiter:currency", onCur);
    return () => window.removeEventListener("jupiter:currency", onCur);
  }, []);

  const deliverToTab = useCallback((tabId: string, action: TabAction) => {
    const dispatch = dispatchersRef.current.get(tabId);
    if (dispatch) {
      dispatch(action);
      return true;
    } else {
      const buf = pendingEventsRef.current.get(tabId) ?? [];
      buf.push(action);
      pendingEventsRef.current.set(tabId, buf);
      return false;
    }
  }, []);

  const registerDispatch = useCallback((tabId: string, d: TabDispatcher | null) => {
    if (d) {
      dispatchersRef.current.set(tabId, d);
      const buf = pendingEventsRef.current.get(tabId);
      let drainedBufferedEvents = false;
      if (buf && buf.length > 0) {
        for (const action of buf) d(action);
        pendingEventsRef.current.delete(tabId);
        drainedBufferedEvents = true;
      }
      if (drainedBufferedEvents && pendingRestoredFocusRef.current.delete(tabId)) {
        setActiveTabId(tabId);
      }
    } else {
      dispatchersRef.current.delete(tabId);
    }
  }, []);

  const sendRpcToTab = useCallback((tabId: string, cmd: OutgoingCommand) => {
    if (!tabId) return;
    const payload = { tabId, ...cmd };
    const line = JSON.stringify(payload);
    const write = (): Promise<void> =>
      invoke("rpc_send", { line })
        .then(() => undefined)
        .catch((err) => {
          console.error(`${cmd.cmd} failed`, err);
        });
    const current = rpcSendQueuesRef.current.get(tabId) ?? Promise.resolve();
    const next = current.then(write, write);
    rpcSendQueuesRef.current.set(
      tabId,
      next.catch(() => {}),
    );
  }, []);

  const onRuntimeSnapshot = useCallback((tabId: string, snapshot: TabRuntimeSnapshot) => {
    setRuntimeSnapshots((prev) => {
      const current = prev[tabId];
      if (
        current &&
        current.currentSession === snapshot.currentSession &&
        current.busy === snapshot.busy &&
        current.sessions === snapshot.sessions &&
        current.importSources === snapshot.importSources &&
        current.importCandidates === snapshot.importCandidates &&
        current.workspaceDir === snapshot.workspaceDir &&
        current.recentWorkspaces === snapshot.recentWorkspaces &&
        current.model === snapshot.model &&
        current.hasMessages === snapshot.hasMessages &&
        current.contextInfoOpen === snapshot.contextInfoOpen
      ) {
        return prev;
      }
      return { ...prev, [tabId]: snapshot };
    });
  }, []);

  const registerRuntimeControls = useCallback(
    (tabId: string, controls: TabRuntimeControls | null) => {
      if (controls) runtimeControlsRef.current.set(tabId, controls);
      else runtimeControlsRef.current.delete(tabId);
    },
    [],
  );

  const retryStartup = useCallback(() => {
    setStartupRetryNonce((n) => n + 1);
  }, []);

  const sendGlobalRpc = useCallback((cmd: OutgoingCommand) => {
    invoke("rpc_send", { line: JSON.stringify(cmd) }).catch((err) =>
      console.error(`${cmd.cmd} failed`, err),
    );
  }, []);

  const checkForUpdates = useCallback(
    (manual: boolean) => {
      sendGlobalRpc({ cmd: "update_check", manual });
    },
    [sendGlobalRpc],
  );

  const openUpdateRelease = useCallback(
    (source: keyof UpdateReleaseUrls) => {
      const urls =
        updateCheck.status === "available" ||
        updateCheck.status === "up_to_date" ||
        updateCheck.status === "suppressed" ||
        updateCheck.status === "checking" ||
        updateCheck.status === "error"
          ? updateCheck.releaseUrls
          : DEFAULT_UPDATE_RELEASE_URLS;
      openUrl(urls[source]).catch(() => undefined);
    },
    [updateCheck],
  );

  const skipPendingUpdate = useCallback(() => {
    if (!pendingUpdate) return;
    sendGlobalRpc({ cmd: "update_skip", version: pendingUpdate.latestVersion });
    setPendingUpdate(null);
  }, [pendingUpdate, sendGlobalRpc]);

  const disableUpdatePrompts = useCallback(() => {
    sendGlobalRpc({ cmd: "update_disable_prompts" });
    setPendingUpdate(null);
  }, [sendGlobalRpc]);

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const setup = async () => {
      startupStderrRef.current = [];
      setStartupFailure(null);
      const subs = await Promise.all([
        listen<{ data: string }>("rpc:event", (e) => {
          try {
            const ev = JSON.parse(e.payload.data) as IncomingEvent;
            const tabId = ev.tabId;

            if (ev.type === "$update_check") {
              setUpdateCheck(ev);
              if (ev.mode === "auto" && ev.status === "available") {
                setPendingUpdate(ev);
              }
              return;
            }

            if (ev.type === "$tab_opened" && tabId) {
              const delayRestoredFocus = Boolean(ev.active && ev.restoringSession);
              if (delayRestoredFocus) {
                pendingRestoredFocusRef.current.add(tabId);
              }
              setTabs((prev) =>
                prev.some((t) => t.id === tabId)
                  ? prev.map((t) =>
                      t.id === tabId
                        ? {
                            ...t,
                            workspaceDir: ev.workspaceDir,
                            busy: ev.busy ?? t.busy,
                          }
                        : t,
                    )
                  : [
                      ...prev,
                      {
                        id: tabId,
                        workspaceDir: ev.workspaceDir,
                        busy: ev.busy,
                      },
                    ],
              );
              if (ev.busy !== undefined) {
                deliverToTab(tabId, { t: "set_busy", busy: ev.busy });
              }
              // Focus the tab the backend marked active (user-opened, or the
              // restored focused tab); otherwise keep focus, but make sure
              // *some* tab is active during a multi-tab restore.
              setActiveTabId((prev) =>
                ev.active || !prev ? (delayRestoredFocus && prev ? prev : tabId) : prev,
              );
              return;
            }
            if (ev.type === "$tab_closed" && tabId) {
              setTabs((prev) => prev.filter((t) => t.id !== tabId));
              setActiveTabId((prev) => {
                if (prev !== tabId) return prev;
                const remaining = tabsRef.current.filter((t) => t.id !== tabId);
                return remaining[0]?.id ?? "";
              });
              setRuntimeSnapshots((prev) => {
                if (!(tabId in prev)) return prev;
                const next = { ...prev };
                delete next[tabId];
                return next;
              });
              dispatchersRef.current.delete(tabId);
              pendingEventsRef.current.delete(tabId);
              runtimeControlsRef.current.delete(tabId);
              rpcSendQueuesRef.current.delete(tabId);
              return;
            }

            if (ev.type === "$settings" && tabId) {
              setTabs((prev) =>
                prev.map((t) => (t.id === tabId ? { ...t, workspaceDir: ev.workspaceDir } : t)),
              );
            }

            if (ev.type === "$sessions") {
              setSidebarSessions(ev.items);
            }

            if (ev.type === "$session_import_sources") {
              setSidebarImportSources(ev.apps);
              setSidebarImportCandidates(ev.candidates ?? []);
            }

            if (
              ev.type === "$sessions" ||
              ev.type === "$archived_sessions" ||
              ev.type === "$session_import_sources"
            ) {
              const ids = new Set([
                ...(tabId ? [tabId] : []),
                ...tabsRef.current.map((t) => t.id),
                ...dispatchersRef.current.keys(),
              ]);
              for (const id of ids) {
                deliverToTab(id, { t: "incoming", event: ev });
              }
              return;
            }

            if (ev.type === "$jobs") {
              for (const id of dispatchersRef.current.keys()) {
                deliverToTab(id, { t: "incoming", event: ev });
              }
              return;
            }

            const target = tabId;
            if (target) {
              const busy = tabBusyFromIncomingEvent(ev);
              if (busy !== null) {
                setTabs((prev) => prev.map((t) => (t.id === target ? { ...t, busy } : t)));
              }
              if (ev.type === "$mention_results") {
                deliverToTab(target, {
                  t: "mention_results",
                  results: {
                    nonce: ev.nonce,
                    query: ev.query,
                    results: ev.results,
                  },
                });
                return;
              }
              if (ev.type === "$mention_preview") {
                deliverToTab(target, {
                  t: "mention_preview",
                  preview: {
                    nonce: ev.nonce,
                    path: ev.path,
                    head: ev.head,
                    totalLines: ev.totalLines,
                  },
                });
                return;
              }
              const delivered = deliverToTab(target, { t: "incoming", event: ev });
              if (
                ev.type === "$session_loaded" &&
                pendingRestoredFocusRef.current.has(target) &&
                delivered
              ) {
                pendingRestoredFocusRef.current.delete(target);
                setActiveTabId(target);
              }
            }
          } catch {
            console.error("bad rpc:event line", e.payload.data);
          }
        }),
        listen<{ data: string }>("rpc:stderr", (e) => {
          startupStderrRef.current = [...startupStderrRef.current, e.payload.data].slice(-12);
          setStartupFailure((prev) =>
            prev
              ? coerceStartupFailure(
                  prev.details[0] ?? t("app.startupFailedUnknown"),
                  startupStderrRef.current,
                )
              : prev,
          );
          console.warn("[jupiter stderr]", e.payload.data);
        }),
        listen<{ code: number | null }>("rpc:exit", (e) => {
          if (dispatchersRef.current.size === 0) {
            setStartupFailure(
              coerceStartupFailure(
                new Error(`jupiter exited (code ${e.payload.code ?? "?"})`),
                startupStderrRef.current,
              ),
            );
          }
          for (const dispatch of dispatchersRef.current.values()) {
            dispatch({ t: "rpc_exit", code: e.payload.code });
          }
        }),
      ]);
      if (cancelled) {
        for (const u of subs) u();
        return;
      }
      cleanups.push(...subs);
      try {
        await invoke("rpc_spawn");
        // WebView reload (DevTools F5, host respawn) keeps the Node child
        // alive but loses every $tab_opened / $settings / $needs_setup that
        // already fired. Ask the desktop server to re-emit them.
        if (!cancelled) {
          await invoke("rpc_send", {
            line: JSON.stringify({ cmd: "desktop_resync" }),
          });
        }
      } catch (err) {
        if (!cancelled) {
          setStartupFailure(coerceStartupFailure(err, startupStderrRef.current));
          console.error("rpc_spawn failed", err);
        }
      }
    };
    void setup();
    return () => {
      cancelled = true;
      for (const c of cleanups) c();
    };
  }, [deliverToTab, startupRetryNonce]);

  // Tell the backend which tab is focused so a restart can reopen on it (#1244).
  useEffect(() => {
    if (!activeTabId) return;
    invoke("rpc_send", {
      line: JSON.stringify({ cmd: "tab_activate", tabId: activeTabId }),
    }).catch(() => {});
  }, [activeTabId]);

  const openTab = useCallback(() => {
    invoke("rpc_send", { line: JSON.stringify({ cmd: "tab_open" }) }).catch((err) =>
      console.error("tab_open failed", err),
    );
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      if (tabs.length <= 1) return;
      invoke("rpc_send", {
        line: JSON.stringify({ cmd: "tab_close", tabId: id }),
      }).catch((err) => console.error("tab_close failed", err));
    },
    [tabs.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const shortcut = matchDesktopShortcut(e);
      const tabIndex = shortcut ? tabIndexFromShortcutAction(shortcut) : null;
      if (shortcut === "new-tab") {
        e.preventDefault();
        openTab();
      } else if (shortcut === "close-tab" && activeTabId && tabs.length > 1) {
        e.preventDefault();
        closeTab(activeTabId);
      } else if (shortcut === "switch-next-tab" || shortcut === "switch-prev-tab") {
        if (tabs.length <= 1) return;
        e.preventDefault();
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        const next =
          shortcut === "switch-prev-tab"
            ? (idx - 1 + tabs.length) % tabs.length
            : (idx + 1) % tabs.length;
        const target = tabs[next];
        if (target) setActiveTabId(target.id);
      } else if (shortcut === "previous-tab" || shortcut === "next-tab") {
        if (tabs.length <= 1) return;
        e.preventDefault();
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        const next =
          shortcut === "previous-tab"
            ? (idx - 1 + tabs.length) % tabs.length
            : (idx + 1) % tabs.length;
        const target = tabs[next];
        if (target) setActiveTabId(target.id);
      } else if (tabIndex !== null) {
        const target = tabs[tabIndex];
        if (!target) return;
        e.preventDefault();
        setActiveTabId(target.id);
      } else if (shortcut === "toggle-right-sidebar") {
        e.preventDefault();
        onToggleCtx();
      } else if (shortcut === "toggle-left-sidebar") {
        e.preventDefault();
        onToggleSide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openTab, closeTab, activeTabId, tabs, onToggleCtx, onToggleSide]);

  const onSetTheme = useCallback((nextTheme: Theme) => {
    setTheme(nextTheme);
    setThemeStyle(defaultStyleForTheme(nextTheme));
  }, []);

  const onSetThemeStyle = useCallback((nextStyle: ThemeStyle) => {
    setThemeStyle(nextStyle);
    setTheme(themeForStyle(nextStyle));
  }, []);

  const onToggleTheme = useCallback(() => {
    onSetTheme(theme === THEME.DARK ? THEME.LIGHT : THEME.DARK);
  }, [onSetTheme, theme]);

  const onToggleCurrency = useCallback(() => {
    setCurrency((c) => {
      const next = c === "CNY" ? "USD" : "CNY";
      localStorage.setItem("jupiter.currency", next);
      window.dispatchEvent(new CustomEvent("jupiter:currency", { detail: next }));
      return next;
    });
  }, []);

  const activeTabMeta = tabs.find((tab) => tab.id === activeTabId);
  const activeRuntimeSnapshot = activeTabId ? runtimeSnapshots[activeTabId] : undefined;
  const activeContextInfoOpen = activeRuntimeSnapshot?.contextInfoOpen ?? false;
  const activeBusy = Boolean(activeRuntimeSnapshot?.busy || activeTabMeta?.busy);
  const activeWorkspaceDir = activeRuntimeSnapshot?.workspaceDir ?? activeTabMeta?.workspaceDir;
  const activeRecentWorkspaces = activeRuntimeSnapshot?.recentWorkspaces ?? [];
  const displayTabs = useMemo(
    () =>
      tabs.map((tab) => {
        const snapshot = runtimeSnapshots[tab.id];
        const workspaceDir = snapshot?.workspaceDir ?? tab.workspaceDir;
        const busy = snapshot?.busy ?? tab.busy;
        if (workspaceDir === tab.workspaceDir && busy === tab.busy) return tab;
        return { ...tab, workspaceDir, busy };
      }),
    [runtimeSnapshots, tabs],
  );
  const sidebarSessionActivity = useMemo(() => {
    const activity: Record<string, { busy: boolean }> = {};
    for (const snapshot of Object.values(runtimeSnapshots)) {
      if (!snapshot.currentSession || !snapshot.busy) continue;
      activity[snapshot.currentSession] = { busy: true };
    }
    return activity;
  }, [runtimeSnapshots]);
  const shellThreadMaxWidth = getThreadMaxWidth({
    viewportWidth,
    visibleSide: sideCollapsed ? 0 : sideWidth,
    visibleCtx: getVisibleContextWidth({
      ctxCollapsed,
      contextInfoOpen: activeContextInfoOpen,
      ctxWidth,
    }),
  });

  if (startupFailure && tabs.length === 0) {
    return <StartupFailure details={startupFailure.details} onRetry={retryStartup} />;
  }

  return (
    <>
      {tabs.length > 0 ? (
        <div
          className="app"
          data-theme={theme}
          data-theme-style={themeStyle}
          data-side-collapsed={sideCollapsed}
          data-ctx-collapsed={ctxCollapsed}
          data-bottom-collapsed={bottomCollapsed}
          data-context-info-open={activeContextInfoOpen}
          style={{
            ["--side-width" as string]: sideCollapsed ? "0px" : `${sideWidth}px`,
            ["--ctx-width" as string]:
              ctxCollapsed && !activeContextInfoOpen ? "0px" : `${ctxWidth}px`,
            ["--bottom-height" as string]: bottomCollapsed ? "0px" : `${bottomHeight}px`,
            ["--thread-max-width" as string]: `${shellThreadMaxWidth}px`,
            ["--composer-max-width" as string]: `${shellThreadMaxWidth}px`,
          }}
        >
          <Sidebar
            sessions={sidebarSessions}
            sessionActivity={sidebarSessionActivity}
            importSources={sidebarImportSources}
            importCandidates={sidebarImportCandidates}
            activeName={activeRuntimeSnapshot?.currentSession}
            workspaceDir={activeWorkspaceDir}
            recentWorkspaces={activeRecentWorkspaces}
            onNewChat={(workspaceDir) => {
              runtimeControlsRef.current.get(activeTabId)?.clearAbortDraft();
              sendRpcToTab(activeTabId, {
                cmd: "new_chat",
                workspaceDir,
                openInNewTab: activeBusy,
              });
            }}
            onLoadSession={(name) => {
              runtimeControlsRef.current.get(activeTabId)?.clearAbortDraft();
              sendRpcToTab(activeTabId, {
                cmd: "session_load",
                name,
                openInNewTab: activeBusy,
              });
            }}
            onDeleteSession={(name) => sendRpcToTab(activeTabId, { cmd: "session_delete", name })}
            onRenameSession={(name, title) =>
              sendRpcToTab(activeTabId, { cmd: "session_rename", name, title })
            }
            onPatchSessionMeta={(name, patch) =>
              sendRpcToTab(activeTabId, { cmd: "session_patch_meta", name, patch })
            }
            onMarkSessionRead={(name) =>
              sendRpcToTab(activeTabId, { cmd: "session_mark_read", name })
            }
            onMarkSessionUnread={(name) =>
              sendRpcToTab(activeTabId, { cmd: "session_mark_unread", name })
            }
            onArchiveSession={(name) => sendRpcToTab(activeTabId, { cmd: "session_archive", name })}
            onArchiveSessions={(names) =>
              sendRpcToTab(activeTabId, { cmd: "session_archive_many", names })
            }
            onRefreshImportSources={() => sendRpcToTab(activeTabId, { cmd: "session_import_scan" })}
            onImportDetectedSessions={(items: ExternalSessionSelection[]) =>
              sendRpcToTab(activeTabId, {
                cmd: "session_import_bulk",
                items,
              })
            }
            onImportSession={({ source, path, name }) =>
              sendRpcToTab(activeTabId, {
                cmd: "session_import",
                source,
                path,
                ...(name ? { name } : {}),
              })
            }
            onOpenSettings={() => runtimeControlsRef.current.get(activeTabId)?.openSettingsCard()}
            onOpenSettingsPage={(page) =>
              runtimeControlsRef.current.get(activeTabId)?.openSettingsPage(page)
            }
            onOpenCommands={() => runtimeControlsRef.current.get(activeTabId)?.openCommandPalette()}
            onRemoveWorkspace={(workspace) => {
              const nextRecent = activeRecentWorkspaces.filter((p) => p !== workspace);
              sendRpcToTab(activeTabId, { cmd: "settings_save", recentWorkspaces: nextRecent });
            }}
          />

          {!sideCollapsed ? (
            <div
              className="resize-handle"
              data-side="left"
              data-dragging={undefined}
              onMouseDown={onSideResizeDown}
            />
          ) : null}

          {tabs.map((t) => (
            <TabRuntime
              key={t.id}
              tabId={t.id}
              active={t.id === activeTabId}
              currency={currency}
              registerDispatch={registerDispatch}
              sendRpcToTab={sendRpcToTab}
              onRuntimeSnapshot={onRuntimeSnapshot}
              registerRuntimeControls={registerRuntimeControls}
              onNewTab={openTab}
              onCloseTab={() => closeTab(t.id)}
              canCloseTab={tabs.length > 1}
              theme={theme}
              themeStyle={themeStyle}
              onSetTheme={onSetTheme}
              onSetThemeStyle={onSetThemeStyle}
              onToggleTheme={onToggleTheme}
              fontScale={fontScale}
              onSetFontScale={setFontScale}
              fontFamily={fontFamily}
              onSetFontFamily={setFontFamily}
              customFontFamily={customFontFamily}
              onSetCustomFontFamily={setCustomFontFamily}
              sideCollapsed={sideCollapsed}
              ctxCollapsed={ctxCollapsed}
              bottomCollapsed={bottomCollapsed}
              sideWidth={sideWidth}
              ctxWidth={ctxWidth}
              onCtxResizeDown={onCtxResizeDown}
              onBottomResizeDown={onBottomResizeDown}
              onToggleSide={onToggleSide}
              onToggleCtx={onToggleCtx}
              onToggleBottom={onToggleBottom}
              onToggleCurrency={onToggleCurrency}
              tabsList={displayTabs}
              activeTabId={activeTabId}
              setActiveTabId={setActiveTabId}
              updateCheck={updateCheck}
              onCheckUpdates={checkForUpdates}
              onOpenUpdateRelease={openUpdateRelease}
            />
          ))}
        </div>
      ) : null}
      {tabs.length > 0 && splashOn ? <Splash onDone={() => setSplashOn(false)} /> : null}
      {pendingUpdate ? (
        <UpdateOverlay
          update={pendingUpdate}
          onOpenRelease={openUpdateRelease}
          onSkip={skipPendingUpdate}
          onDisablePrompts={disableUpdatePrompts}
          onDismiss={() => setPendingUpdate(null)}
        />
      ) : null}
    </>
  );
}
