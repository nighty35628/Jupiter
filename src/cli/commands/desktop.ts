import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, statSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { stdin } from "node:process";
import { createInterface } from "node:readline";
import { toApprovalPrompt } from "@jupiter/core-utils";
import {
  type FileWithStats,
  listDirectory,
  listFilesWithStatsAsync,
  parseAtQuery,
  rankPickerCandidates,
} from "../../at-mentions.js";
import { pickPrimaryBalance } from "../../client.js";
import { prepareAutoGitRollbackForEditBlocks } from "../../code/auto-git-rollback.js";
import { formatAllBlockDiffs } from "../../code/diff-preview.js";
import {
  type ApplyResult,
  type EditBlock,
  type EditSnapshot,
  applyEditBlocks,
  restoreSnapshots,
  snapshotBeforeEdits,
} from "../../code/edit-blocks.js";
import { codeSystemPrompt } from "../../code/prompt.js";
import { applyPlanMode, buildCodeToolset } from "../../code/setup.js";
import {
  DEFAULT_MODEL,
  type DesktopCloseBehavior,
  type DesktopOpenTab,
  type EditMode,
  type LibraryRetrievalMode,
  bridgeEndpointEnv,
  clearApiKey,
  isPlausibleKey,
  isReasoningEffort,
  loadApiKey,
  loadBaiduApiKey,
  loadBraveApiKey,
  loadDesktopCloseBehavior,
  loadDesktopOpenTabs,
  loadEditMode,
  loadEditor,
  loadEndpoint,
  loadEngineeringLifecycleMode,
  loadExaApiKey,
  loadFeishuConfig,
  loadLibraryRetrievalMode,
  loadMaxIterPerTurn,
  loadMemoryConfirmWrites,
  loadMemoryGlobalEnabled,
  loadMetasoApiKey,
  loadModel,
  loadOllamaApiKey,
  loadPerplexityApiKey,
  loadProcessCardsDefaultOpen,
  loadPromptHistory,
  loadQQConfig,
  loadReasoningEffort,
  loadRecentWorkspaces,
  loadResolvedSkillPaths,
  loadShowSystemEvents,
  loadSkillPackSources,
  loadSubagentModels,
  loadTavilyApiKey,
  loadWorkspaceDir,
  normalizeMcpConfig,
  pushRecentWorkspace,
  readConfig,
  webSearchEndpoint as readWebSearchEndpoint,
  webSearchEngine as readWebSearchEngine,
  saveApiKey,
  saveBaseUrl,
  saveDesktopCloseBehavior,
  saveDesktopOpenTabs,
  saveEditMode,
  saveEditor,
  saveFeishuConfig,
  saveLibraryRetrievalMode,
  saveMemoryConfirmWrites,
  saveMemoryGlobalEnabled,
  saveModel,
  saveProcessCardsDefaultOpen,
  savePromptHistory,
  saveReasoningEffort,
  saveShowSystemEvents,
  saveSkillPackSources,
  saveSubagentModels,
  saveWorkspaceDir,
  writeConfig,
} from "../../config.js";
import {
  addMcpSpecSetting,
  removeMcpSpecSetting,
  setMcpSpecDisabled,
} from "../../config/mcp-settings.js";
import {
  addSkillPathSetting,
  createSkillSetting,
  removeSkillPathSetting,
  setSkillSubagentModel,
} from "../../config/skill-settings.js";
import { Eventizer } from "../../core/eventize.js";
import type { Event as KernelEvent } from "../../core/events.js";
import {
  type CheckpointVerdict,
  type ChoiceVerdict,
  type ConfirmationChoice,
  type PlanVerdict,
  type RevisionVerdict,
  pauseGate,
} from "../../core/pause-gate.js";
import { autoResolveVerdict } from "../../core/pause-policy.js";
import { detectBrowserAutomation } from "../../desktop/browser-automation.js";
import {
  feishuRemoteCommandBypassesBusy,
  feishuRemoteDesktopHelpText,
  parseFeishuRemoteDesktopCommand,
} from "../../desktop/feishu-remote-commands.js";
import {
  type LibrarySource,
  addLibrarySourceForWorkspace,
  extractLibraryFileContentForWorkspace,
  listLibrarySourcesForWorkspace,
  removeLibrarySourceForWorkspace,
  updateLibrarySourceContentForWorkspace,
} from "../../desktop/library-store.js";
import { augmentProcessPath } from "../../desktop/login-shell-path.js";
import {
  type MemoryEntryDetail,
  type MemoryEntryInfo,
  type MemoryWriteRequest,
  collectMemoryEntriesForWorkspace,
  deleteMemoryEntryForWorkspace,
  readMemoryEntryDetail,
  saveStructuredMemoryForWorkspace,
} from "../../desktop/memory-browser.js";
import { classifyDesktopNaturalCommandIntent } from "../../desktop/natural-command-intent.js";
import { buildOneShotPlanPrompt } from "../../desktop/one-shot-plan.js";
import { classifyDesktopQQIngress } from "../../desktop/qq-ingress.js";
import {
  parseQQRemoteDesktopCommand,
  qqRemoteCommandBypassesBusy,
  qqRemoteDesktopHelpText,
} from "../../desktop/qq-remote-commands.js";
import {
  loadDesktopQQState,
  saveDesktopQQSettings,
  setDesktopQQEnabled,
} from "../../desktop/qq-settings.js";
import {
  clearQQTurnRouting,
  createQQTurnRoutingState,
  hasQQPendingInteraction,
  markQQTurnFinished,
  markQQTurnStarted,
  setQQPendingInteraction,
  shouldRouteQQForTab,
  takeQQPendingInteraction,
} from "../../desktop/qq-turn-routing.js";
import {
  type StorageCleanupResult,
  type StorageScan,
  cleanupJupiterStorage,
  scanJupiterStorage,
} from "../../desktop/storage-manager.js";
import { loadDotenv } from "../../env.js";
import { FeishuChannel } from "../../feishu/channel.js";
import { type ResolvedHook, formatHookOutcomeMessage, loadHooks, runHooks } from "../../hooks.js";
import { t } from "../../i18n/index.js";
import {
  CacheFirstLoop,
  DeepSeekClient,
  ImmutablePrefix,
  type LoopAbortOptions,
} from "../../index.js";
import { parseMcpSpec, specToRaw } from "../../mcp/spec.js";
import { isProjectMemoryPath } from "../../memory/project.js";
import {
  clearArchivedSessions,
  deleteArchivedSession,
  deleteSession,
  isInternalSessionName,
  listArchivedSessions,
  listSessions,
  loadSessionMessages,
  loadSessionMeta,
  markSessionRead,
  markSessionUnread,
  migrateLegacyArchivedSessions,
  moveSessionToArchive,
  patchSessionMeta,
  patchSessionWorkspaceIfMissing,
  restoreArchivedSession,
  sessionIsUnread,
  sessionPath,
  timestampSuffix,
} from "../../memory/session.js";
import { QQChannel } from "../../qq/channel.js";
import {
  type ExternalSessionSource,
  discoverExternalSessionApps,
  discoverExternalSessionCandidates,
  importExternalSession,
  importExternalSessions,
} from "../../session-import.js";
import { SkillStore, skillDisplayDescription } from "../../skills.js";
import { countTokensBounded } from "../../tokenizer.js";
import type { ChoiceOption } from "../../tools/choice.js";
import type { SubagentEvent, SubagentSink } from "../../tools/subagent.js";
import { webFetch, webSearch } from "../../tools/web.js";
import type { ChatMessage } from "../../types.js";
import { VERSION } from "../../version.js";
import {
  type EditHistoryEntry,
  entryStatus,
  formatEditResults,
  formatUndoRows,
  isEntryFullyUndone,
} from "../ui/edit-history.js";
import { buildEditToolBlocks, isReviewGatedEditTool } from "../ui/edit-tool-gate.js";
import { parseSlash, resolveSlashAlias } from "../ui/slash/commands.js";
import { handleSlash } from "../ui/slash/dispatch.js";
import type { CodeUndoResult } from "../ui/undo-context.js";
import { type McpRuntime, createMcpRuntime } from "./mcp-runtime.js";

export interface DesktopOptions {
  model: string;
  budgetUsd?: number;
  /** Root directory the agent's filesystem tools operate inside. Defaults to cwd. */
  dir?: string;
}

export function desktopUserAbortLoopOptions(): LoopAbortOptions | undefined {
  // User-facing Abort stops generation; it must not erase a prompt that remains visible in chat.
  return undefined;
}

type InMessage = { tabId?: string } & (
  | {
      cmd: "user_input";
      text: string;
      clientId?: string;
      displayText?: string;
      planOneShot?: boolean;
    }
  | { cmd: "abort" }
  | { cmd: "confirm_response"; id: number; response: ConfirmationChoice }
  | { cmd: "choice_response"; id: number; response: ChoiceVerdict }
  | { cmd: "plan_response"; id: number; response: PlanVerdict }
  | { cmd: "checkpoint_response"; id: number; response: CheckpointVerdict }
  | { cmd: "revision_response"; id: number; response: RevisionVerdict }
  | { cmd: "session_list" }
  | { cmd: "session_list_archived" }
  | { cmd: "session_delete"; name: string }
  | { cmd: "session_archive"; name: string }
  | { cmd: "session_archive_many"; names: string[] }
  | { cmd: "session_restore_archived"; name: string }
  | { cmd: "session_delete_archived"; name: string }
  | { cmd: "session_clear_archived" }
  | { cmd: "session_load"; name: string; openInNewTab?: boolean }
  | { cmd: "session_rename"; name: string; title: string }
  | {
      cmd: "session_patch_meta";
      name: string;
      patch: {
        archivedAt?: number | null;
        pinnedAt?: number | null;
        lastReadAt?: number | null;
        lastAssistantCompletedAt?: number | null;
        manualUnread?: boolean | null;
      };
    }
  | { cmd: "session_mark_read"; name: string }
  | { cmd: "session_mark_unread"; name: string }
  | {
      cmd: "session_import";
      source: ExternalSessionSource;
      path: string;
      name?: string;
    }
  | { cmd: "session_import_scan" }
  | {
      cmd: "session_import_bulk";
      sources?: ExternalSessionSource[];
      items?: Array<{ source: ExternalSessionSource; path: string }>;
    }
  | { cmd: "memory_read"; path: string }
  | { cmd: "memory_refresh" }
  | { cmd: "memory_delete"; path: string }
  | ({ cmd: "memory_save" } & MemoryWriteRequest)
  | { cmd: "source_search"; query: string; nonce: number; topK?: number }
  | { cmd: "source_ingest"; url: string; nonce: number; title?: string }
  | { cmd: "library_list" }
  | { cmd: "library_add"; source: Omit<LibrarySource, "id" | "addedAt" | "updatedAt"> }
  | { cmd: "library_remove"; id: string }
  | { cmd: "library_refresh"; id: string }
  | { cmd: "storage_scan" }
  | { cmd: "storage_cleanup"; itemIds: string[] }
  | { cmd: "new_chat"; workspaceDir?: string; openInNewTab?: boolean }
  | { cmd: "setup_save_key"; key: string }
  | { cmd: "settings_sign_out" }
  | { cmd: "settings_get" }
  | {
      cmd: "settings_save";
      reasoningEffort?: import("../../config.js").ReasoningEffort;
      editMode?: EditMode;
      budgetUsd?: number | null;
      baseUrl?: string;
      workspaceDir?: string;
      recentWorkspaces?: string[];
      model?: string;
      editor?: string;
      desktopCloseBehavior?: DesktopCloseBehavior;
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
      webSearchEndpoint?: string | null;
      metasoApiKey?: string | null;
      baiduApiKey?: string | null;
      tavilyApiKey?: string | null;
      perplexityApiKey?: string | null;
      exaApiKey?: string | null;
      ollamaApiKey?: string | null;
      braveApiKey?: string | null;
      subagentModels?: Record<string, "flash" | "pro">;
      skillPackSources?: ReturnType<typeof loadSkillPackSources>;
      contextTokens?: Record<string, number>;
      libraryRetrievalMode?: LibraryRetrievalMode;
      showSystemEvents?: boolean;
      processCardsDefaultOpen?: boolean;
      memoryConfirmWrites?: boolean;
      memoryGlobalEnabled?: boolean;
      promptHistory?: string[];
    }
  | { cmd: "qq_status_get" }
  | { cmd: "qq_connect" }
  | { cmd: "qq_disconnect" }
  | {
      cmd: "qq_config_save";
      appId?: string;
      appSecret?: string;
      sandbox: boolean;
    }
  | { cmd: "feishu_connect" }
  | { cmd: "feishu_disconnect" }
  | { cmd: "feishu_status_get" }
  | {
      cmd: "feishu_config_save";
      appId?: string;
      appSecret?: string;
      requireMentionInGroup?: boolean;
    }
  | { cmd: "mention_query"; query: string; nonce: number }
  | { cmd: "mention_preview"; path: string; nonce: number }
  | { cmd: "mention_picked"; path: string }
  | { cmd: "tab_open"; workspaceDir?: string }
  | { cmd: "tab_close" }
  | { cmd: "tab_activate"; tabId: string }
  | { cmd: "mcp_specs_get" }
  | { cmd: "mcp_specs_add"; spec: string }
  | { cmd: "mcp_specs_remove"; spec: string }
  | { cmd: "mcp_specs_enable"; name: string }
  | { cmd: "mcp_specs_disable"; name: string }
  | { cmd: "mcp_specs_reconnect" }
  | { cmd: "skills_get" }
  | { cmd: "skill_path_add"; path: string }
  | { cmd: "skill_path_remove"; path: string }
  | { cmd: "skill_create"; name: string; scope: "project" | "global" }
  | { cmd: "skill_model_set"; name: string; model: "flash" | "pro" | null }
  | { cmd: "skill_run"; name: string; args?: string }
  | { cmd: "jobs_list" }
  | { cmd: "jobs_stop"; jobId: number }
  | { cmd: "jobs_stop_all" }
  | { cmd: "compact_history" }
  | { cmd: "retry" }
  | { cmd: "rollback_to_turn"; turn: number; role: "user" | "assistant" }
  | { cmd: "slash"; text: string; clientId?: string }
  | { cmd: "btw"; text: string; clientId?: string }
  | { cmd: "desktop_resync" }
);

interface NeedsSetupEvent {
  type: "$needs_setup";
  reason: "no_api_key";
}

interface SettingsEvent {
  type: "$settings";
  reasoningEffort: import("../../config.js").ReasoningEffort;
  editMode: EditMode;
  budgetUsd: number | null;
  baseUrl?: string;
  apiKeyPrefix?: string;
  workspaceDir: string;
  recentWorkspaces: string[];
  model: string;
  editor?: string;
  desktopCloseBehavior?: DesktopCloseBehavior;
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
  browserAutomation?: ReturnType<typeof detectBrowserAutomation>;
  skillPackSources?: ReturnType<typeof loadSkillPackSources>;
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
  contextTokens?: Record<string, number>;
  libraryRetrievalMode?: LibraryRetrievalMode;
  showSystemEvents?: boolean;
  processCardsDefaultOpen?: boolean;
  memoryConfirmWrites?: boolean;
  memoryGlobalEnabled?: boolean;
  promptHistory?: string[];
  version: string;
}

interface QQSettingsEvent {
  type: "$qq_settings";
  appId?: string;
  appSecret?: string;
  sandbox: boolean;
  enabled: boolean;
  configured: boolean;
  runtimeState: "disconnected" | "connecting" | "connected" | "failed";
  lastError?: string;
  appIdPreview?: string;
  access: string;
}

interface FeishuSettingsEvent {
  type: "$feishu_settings";
  appId?: string;
  appSecret?: string;
  enabled: boolean;
  configured: boolean;
  requireMentionInGroup: boolean;
  runtimeState: "disconnected" | "connecting" | "connected" | "failed";
  lastError?: string;
  appIdPreview?: string;
}

interface BalanceInfoItem {
  currency: string;
  total: number;
  granted?: number;
  toppedUp?: number;
}

interface BalanceEvent {
  type: "$balance";
  currency: string;
  total: number;
  isAvailable: boolean;
  balanceInfos: BalanceInfoItem[];
}

interface PlanRequiredEvent {
  type: "$plan_required";
  id: number;
  plan: string;
  steps?: unknown[];
  summary?: string;
}

type SessionListItem = {
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

interface SessionsEvent {
  type: "$sessions";
  items: SessionListItem[];
}

interface ArchivedSessionsEvent {
  type: "$archived_sessions";
  items: SessionListItem[];
}

interface SessionImportSourcesEvent {
  type: "$session_import_sources";
  apps: ReturnType<typeof discoverExternalSessionApps>;
  candidates: ReturnType<typeof discoverExternalSessionCandidates>;
}

interface SessionImportResultEvent {
  type: "$session_import_result";
  imported: number;
  skipped: number;
  failed: number;
}

interface MentionResultsEvent {
  type: "$mention_results";
  nonce: number;
  query: string;
  results: string[];
}

interface MentionPreviewEvent {
  type: "$mention_preview";
  nonce: number;
  path: string;
  head: string;
  totalLines: number;
}

interface SourceSearchResultsEvent {
  type: "$source_search_results";
  nonce: number;
  query: string;
  results: Array<{
    kind: "web";
    title: string;
    url: string;
    snippet: string;
  }>;
  error?: string;
}

interface SourceIngestResultEvent {
  type: "$source_ingest_result";
  nonce: number;
  url: string;
  title?: string;
  text?: string;
  truncated?: boolean;
  fetchedAt?: number;
  error?: string;
}

interface LibrarySourcesEvent {
  type: "$library_sources";
  workspaceDir: string;
  sources: LibrarySource[];
}

type StorageScanEvent = StorageScan;
type StorageCleanupEvent = StorageCleanupResult;

interface TabOpenedEvent {
  type: "$tab_opened";
  workspaceDir: string;
  /** True when the frontend should focus this tab (user-opened, or the restored focused tab). */
  active?: boolean;
  /** True when this tab has an in-flight agent turn. */
  busy?: boolean;
  /** Session being restored into this newly opened tab. */
  restoringSession?: string;
}

interface TabClosedEvent {
  type: "$tab_closed";
}

type LoadedSegment =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      callId: string;
      name: string;
      args: string;
      result?: string;
      ok?: boolean;
    };

type LoadedMessage =
  | { kind: "user"; text: string }
  | {
      kind: "assistant";
      turn: number;
      segments: LoadedSegment[];
      pending: false;
    };

interface SessionLoadedEvent {
  type: "$session_loaded";
  name: string;
  /** True when this snapshot belongs to a tab that is still running. */
  busy?: boolean;
  messages: LoadedMessage[];
  carryover: {
    totalCostUsd: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    totalCompletionTokens: number;
  };
}

interface SessionReconciledEvent extends Omit<SessionLoadedEvent, "type"> {
  type: "$session_reconciled";
}

interface SessionEmptyEvent {
  type: "$session_empty";
  name: string;
  sizeBytes: number;
}

interface ConfirmRequiredEvent {
  type: "$confirm_required";
  id: number;
  kind: "run_command" | "run_background";
  command: string;
  prompt?: import("@jupiter/core-utils").ApprovalPrompt;
}

interface PathAccessRequiredEvent {
  type: "$path_access_required";
  id: number;
  path: string;
  intent: "read" | "write";
  toolName: string;
  sandboxRoot: string;
  allowPrefix: string;
  prompt?: import("@jupiter/core-utils").ApprovalPrompt;
}

interface ChoiceRequiredEvent {
  type: "$choice_required";
  id: number;
  question: string;
  options: ChoiceOption[];
  allowCustom: boolean;
}

interface PlanStepLite {
  id: string;
  title: string;
  action: string;
  risk?: "low" | "med" | "high";
}

interface CheckpointRequiredEvent {
  type: "$checkpoint_required";
  id: number;
  stepId: string;
  title?: string;
  result: string;
  notes?: string;
  completed: number;
  total: number;
}

interface RevisionRequiredEvent {
  type: "$revision_required";
  id: number;
  reason: string;
  remainingSteps: PlanStepLite[];
  summary?: string;
}

interface StepCompletedEvent {
  type: "$step_completed";
  stepId: string;
  title?: string;
  result: string;
  notes?: string;
}

interface PlanClearedEvent {
  type: "$plan_cleared";
}

type McpSpecStatus = "configured" | "handshake" | "connected" | "failed" | "disabled";

interface McpSpecInfo {
  raw: string;
  name: string | null;
  transport: "stdio" | "sse" | "streamable-http";
  summary: string;
  parseError?: string;
  status: McpSpecStatus;
  statusReason?: string;
  toolCount?: number;
}

interface McpSpecsEvent {
  type: "$mcp_specs";
  specs: McpSpecInfo[];
  bridged: boolean;
}

interface CtxBreakdownEvent {
  type: "$ctx_breakdown";
  reservedTokens: number;
  /** Current log token count (real-time) — sent after /compact to refresh the meter. */
  logTokens?: number;
}

interface MemoryEvent {
  type: "$memory";
  entries: MemoryEntryInfo[];
}

interface MemoryDetailEvent {
  type: "$memory_detail";
  detail: MemoryEntryDetail;
}

interface SkillInfo {
  name: string;
  description: string;
  scope: "project" | "custom" | "global" | "builtin";
  path: string;
  runAs: "inline" | "subagent";
  model?: string;
}

interface SkillRootInfo {
  dir: string;
  scope: "project" | "custom" | "global" | "builtin";
  status: "ok" | "missing" | "not-directory" | "unreadable";
  priority: number;
}

interface SkillsEvent {
  type: "$skills";
  items: SkillInfo[];
  roots: SkillRootInfo[];
}

interface JobInfoPayload {
  id: number;
  tabId: string;
  sessionLabel: string;
  command: string;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  outputTail: string;
  spawnError?: string;
}

interface JobsEvent {
  type: "$jobs";
  items: JobInfoPayload[];
}

const desktopQqRuntimeSnapshot: {
  runtimeState: "disconnected" | "connecting" | "connected" | "failed";
  lastError?: string;
} = {
  runtimeState: "disconnected",
};

interface RetryResultEvent {
  type: "$retry_result";
  text: string;
}

interface BtwResultEvent {
  type: "$btw_result";
  question: string;
  answer: string;
  clientId?: string;
}

type DesktopSubagentEvent = {
  type: "$subagent_event";
  kind: "start" | "progress" | "end" | "phase" | "stream-progress";
  runId: string;
  parentSession?: string;
  sessionName?: string;
  task: string;
  skillName?: string;
  model?: string;
  iter?: number;
  elapsedMs?: number;
  summary?: string;
  error?: string;
  turns?: number;
  costUsd?: number;
  phase?: "exploring" | "summarising";
  outputChars?: number;
  reasoningChars?: number;
  toolReadChars?: number;
};

type CompactResultEvent = {
  type: "$compact_result";
  folded: boolean;
  beforeMessages: number;
  afterMessages: number;
  summaryChars: number;
  reason?: string;
  totalTokens?: number;
  headTokens?: number;
  tailTokens?: number;
  tailBudget?: number;
};

/** Direct fd write — bypasses Node's stream layer (and its piped-output
 *  block buffering) so every JSON line reaches Rust the moment it's
 *  produced, not whenever the next 8 KB flushes. */
type EmittableEvent =
  | KernelEvent
  | { type: "$ready" }
  | { type: "$error"; message: string }
  | { type: "$turn_complete" }
  | ConfirmRequiredEvent
  | PathAccessRequiredEvent
  | ChoiceRequiredEvent
  | PlanRequiredEvent
  | CheckpointRequiredEvent
  | RevisionRequiredEvent
  | StepCompletedEvent
  | PlanClearedEvent
  | SessionsEvent
  | ArchivedSessionsEvent
  | SessionImportSourcesEvent
  | SessionImportResultEvent
  | SessionLoadedEvent
  | SessionReconciledEvent
  | SessionEmptyEvent
  | NeedsSetupEvent
  | SettingsEvent
  | QQSettingsEvent
  | FeishuSettingsEvent
  | BalanceEvent
  | MentionResultsEvent
  | MentionPreviewEvent
  | SourceSearchResultsEvent
  | SourceIngestResultEvent
  | LibrarySourcesEvent
  | StorageScanEvent
  | StorageCleanupEvent
  | RetryResultEvent
  | BtwResultEvent
  | TabOpenedEvent
  | TabClosedEvent
  | McpSpecsEvent
  | DesktopSubagentEvent
  | CompactResultEvent
  | SkillsEvent
  | CtxBreakdownEvent
  | MemoryEvent
  | MemoryDetailEvent
  | JobsEvent;

const STDOUT_BACKPRESSURE_WAIT = new Int32Array(new SharedArrayBuffer(4));

type SyncWriter = (fd: number, buffer: Buffer, offset: number, length: number) => number;

const SESSION_TITLE_MAX_CHARS = 200;

/** Trim + cap a user-provided session title; empty string means "clear summary". Exported for tests. */
export function normalizeSessionTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, SESSION_TITLE_MAX_CHARS);
}

/** Return all MCP specs as raw strings, reading both legacy `cfg.mcp` and canonical `cfg.mcpServers`. */
export function getAllMcpSpecs(cfg: ReturnType<typeof readConfig>): string[] {
  return normalizeMcpConfig(cfg).map(specToRaw);
}

/** Drain `buffer` to `fd` across partial writes; retry EAGAIN after a 5 ms park. Exported for tests. */
export function writeAllSync(
  fd: number,
  buffer: Buffer,
  opts: {
    write?: SyncWriter;
    wait?: () => void;
  } = {},
): void {
  const write = opts.write ?? writeSync;
  const wait = opts.wait ?? (() => Atomics.wait(STDOUT_BACKPRESSURE_WAIT, 0, 0, 5));
  let offset = 0;
  while (offset < buffer.length) {
    let written: number;
    try {
      written = write(fd, buffer, offset, buffer.length - offset);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EAGAIN") {
        wait();
        continue;
      }
      throw err;
    }
    if (written <= 0) throw new Error("stdout write returned 0 bytes");
    offset += written;
  }
}

function emit(ev: EmittableEvent, tabId?: string): void {
  const payload = tabId ? { ...ev, tabId } : ev;
  writeAllSync(1, Buffer.from(`${JSON.stringify(payload)}\n`, "utf8"));
}

function tailLines(s: string, n: number): string {
  if (!s) return "";
  const lines = s.split(/\r?\n/);
  return lines.slice(-n).join("\n");
}

const LOADED_RECENT_MESSAGE_WINDOW = 120;
const LOADED_MIN_ELIDE_CHARS = 4096;
const LOADED_ELIDED_PREFIX = "[elided — older than the last ";

function elideLoadedField(value: string): string {
  if (value.length <= LOADED_MIN_ELIDE_CHARS) return value;
  if (value.startsWith(LOADED_ELIDED_PREFIX)) return value;
  return `${LOADED_ELIDED_PREFIX}${LOADED_RECENT_MESSAGE_WINDOW} messages; ${value.length.toLocaleString()} chars dropped to save memory. Full content is on disk in the session log.]`;
}

function elideLoadedMessages(messages: LoadedMessage[]): LoadedMessage[] {
  if (messages.length < LOADED_RECENT_MESSAGE_WINDOW) return messages;
  const cutoff = messages.length - LOADED_RECENT_MESSAGE_WINDOW;
  return messages.map((msg, i) => {
    if (i >= cutoff || msg.kind !== "assistant") return msg;
    return {
      ...msg,
      segments: msg.segments.map((segment) => {
        switch (segment.kind) {
          case "reasoning":
          case "text":
            return { ...segment, text: elideLoadedField(segment.text) };
          case "tool":
            return {
              ...segment,
              args: elideLoadedField(segment.args),
              ...(segment.result !== undefined ? { result: elideLoadedField(segment.result) } : {}),
            };
          default:
            return segment;
        }
      }),
    };
  });
}

export function buildLoadedMessages(records: ChatMessage[]): LoadedMessage[] {
  const out: LoadedMessage[] = [];
  let userTurn = 0;
  let orphanAssistantTurn = 0;
  let pendingAssistantIdx = -1;
  for (const rec of records) {
    if (rec.role === "system") continue;
    if (rec.role === "user") {
      userTurn++;
      out.push({ kind: "user", text: rec.content ?? "" });
      pendingAssistantIdx = -1;
      continue;
    }
    if (rec.role === "assistant") {
      const turn = userTurn > 0 ? userTurn : ++orphanAssistantTurn;
      const segments: LoadedSegment[] = [];
      if (rec.reasoning_content) segments.push({ kind: "reasoning", text: rec.reasoning_content });
      if (rec.content) segments.push({ kind: "text", text: rec.content });
      if (rec.tool_calls) {
        for (let i = 0; i < rec.tool_calls.length; i++) {
          const tc = rec.tool_calls[i];
          if (!tc) continue;
          segments.push({
            kind: "tool",
            callId: tc.id ?? `tc-r-${turn}-${i}`,
            name: tc.function?.name ?? "",
            args: tc.function?.arguments ?? "",
          });
        }
      }
      const pendingAssistant = out[pendingAssistantIdx];
      if (
        userTurn > 0 &&
        pendingAssistant?.kind === "assistant" &&
        pendingAssistant.turn === turn
      ) {
        pendingAssistant.segments.push(...segments);
      } else {
        out.push({ kind: "assistant", turn, segments, pending: false });
        pendingAssistantIdx = out.length - 1;
      }
      continue;
    }
    if (rec.role === "tool") {
      if (pendingAssistantIdx < 0) continue;
      const host = out[pendingAssistantIdx];
      if (host?.kind !== "assistant") continue;
      const callId = rec.tool_call_id;
      if (!callId) continue;
      const seg = host.segments.find((s) => s.kind === "tool" && s.callId === callId);
      if (seg && seg.kind === "tool") {
        seg.result = rec.content ?? "";
        seg.ok = !/error|failed/i.test(seg.result.slice(0, 200));
      }
    }
  }
  return elideLoadedMessages(out);
}

function maskApiKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 7) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 6)}…${key.slice(-3)}`;
}

function collectWebSearchApiKeyPrefixes(): {
  metaso?: string;
  baidu?: string;
  tavily?: string;
  perplexity?: string;
  exa?: string;
  ollama?: string;
  brave?: string;
} {
  return {
    metaso: maskApiKey(loadMetasoApiKey()),
    baidu: maskApiKey(loadBaiduApiKey()),
    tavily: maskApiKey(loadTavilyApiKey()),
    perplexity: maskApiKey(loadPerplexityApiKey()),
    exa: maskApiKey(loadExaApiKey()),
    ollama: maskApiKey(loadOllamaApiKey()),
    brave: maskApiKey(loadBraveApiKey()),
  };
}

function emitSettings(tab: Tab): void {
  const ep = loadEndpoint();
  const editMode = loadDesktopEditMode();
  if (tab.toolset) applyPlanMode(tab.toolset.tools, editMode);
  const recent = loadRecentWorkspaces().filter((p) => p !== tab.rootDir);
  emit(
    {
      type: "$settings",
      reasoningEffort: loadReasoningEffort(),
      editMode,
      budgetUsd: tab.runtime?.loop.budgetUsd ?? null,
      baseUrl: ep.baseUrl,
      apiKeyPrefix: ep.apiKey ? `${ep.apiKey.slice(0, 6)}…${ep.apiKey.slice(-3)}` : undefined,
      workspaceDir: tab.rootDir,
      recentWorkspaces: recent,
      model: tab.currentModel,
      editor: loadEditor(),
      desktopCloseBehavior: loadDesktopCloseBehavior(),
      webSearchEngine: readWebSearchEngine(),
      webSearchEndpoint: readConfig().webSearchEndpoint,
      browserAutomation: detectBrowserAutomation(),
      skillPackSources: loadSkillPackSources(),
      webSearchApiKeys: collectWebSearchApiKeyPrefixes(),
      subagentModels: loadSubagentModels(),
      contextTokens: readConfig().contextTokens,
      libraryRetrievalMode: loadLibraryRetrievalMode(),
      showSystemEvents: loadShowSystemEvents(),
      processCardsDefaultOpen: loadProcessCardsDefaultOpen(),
      memoryConfirmWrites: loadMemoryConfirmWrites(),
      memoryGlobalEnabled: loadMemoryGlobalEnabled(),
      promptHistory: loadPromptHistory(),
      version: VERSION,
    },
    tab.id,
  );
}

function loadDesktopEditMode(): Exclude<EditMode, "plan"> {
  const editMode = loadEditMode();
  return editMode === "plan" ? "review" : editMode;
}

function emitQQSettings(tab: Tab): void {
  const base = loadDesktopQQState();
  emit(
    {
      type: "$qq_settings",
      ...base,
      runtimeState: desktopQqRuntimeSnapshot.runtimeState,
      lastError: desktopQqRuntimeSnapshot.lastError,
    },
    tab.id,
  );
}

async function emitBalance(tab: Tab): Promise<void> {
  if (!tab.runtime) return;
  const bal = await tab.runtime.loop.client.getBalance().catch(() => null);
  if (!bal) return;
  const primary = pickPrimaryBalance(bal.balance_infos);
  if (!primary) return;
  const balanceInfos = bal.balance_infos.map((info) => ({
    currency: info.currency,
    total: Number(info.total_balance),
    granted: info.granted_balance ? Number(info.granted_balance) : undefined,
    toppedUp: info.topped_up_balance ? Number(info.topped_up_balance) : undefined,
  }));
  emit(
    {
      type: "$balance",
      currency: primary.currency,
      total: Number(primary.total_balance),
      isAvailable: bal.is_available,
      balanceInfos,
    },
    tab.id,
  );
}

function toSessionListItem(s: ReturnType<typeof listSessions>[number], tab: Tab): SessionListItem {
  return {
    name: s.name,
    path: s.path,
    messageCount: s.messageCount,
    mtime: s.mtime.toISOString(),
    summary: s.meta.summary,
    workspace: repairRetiredSessionWorkspace(s.name, s.meta.workspace, tab.rootDir),
    archivedAt: s.meta.archivedAt,
    pinnedAt: s.meta.pinnedAt,
    unread: sessionIsUnread(s.meta),
    workspaceStatus: s.workspaceStatus,
  };
}

function emitSessions(tab: Tab): void {
  try {
    migrateLegacyArchivedSessions();
    const items = listSessions()
      .filter((s) => !isInternalSessionName(s.name))
      .map((s) => toSessionListItem(s, tab));
    emit({ type: "$sessions", items }, tab.id);
  } catch (err) {
    emit(
      {
        type: "$error",
        message: `session_list failed: ${(err as Error).message}`,
      },
      tab.id,
    );
  }
}

function emitArchivedSessions(tab: Tab): void {
  try {
    const items = listArchivedSessions()
      .filter((s) => !isInternalSessionName(s.name))
      .map((s) => toSessionListItem(s, tab));
    emit({ type: "$archived_sessions", items }, tab.id);
  } catch (err) {
    emit(
      {
        type: "$error",
        message: `session_list_archived failed: ${(err as Error).message}`,
      },
      tab.id,
    );
  }
}

function loadSessionIntoTab(
  tab: Tab,
  name: string,
  actions: {
    abortTurn: (tab: Tab) => void;
    cancelPendingGates: (tab: Tab) => void;
    persistOpenTabs: () => void;
  },
): void {
  const records = loadSessionMessages(name);
  const backfilledWorkspace = patchSessionWorkspaceIfMissing(name, tab.rootDir);
  const meta = loadSessionMeta(name);
  // Only set switching flag when there's a live turn to abort —
  // otherwise the flag stays true and suppresses the first turn's events (#1217).
  if (tab.aborter) tab.switching = true;
  actions.abortTurn(tab);
  actions.cancelPendingGates(tab);
  tab.currentSession = name;
  tab.editHistory = [];
  tab.nextEditHistoryId = 1;
  tab.currentTurnEditEntry = null;
  actions.persistOpenTabs();
  if (tab.runtime) tab.runtime = buildRuntimeFor(tab);
  const loadedMessages = buildLoadedMessages(records);
  if (loadedMessages.length === 0) {
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(sessionPath(name)).size;
    } catch {
      /* file may not exist */
    }
    process.stderr.write(
      `session_load: "${name}" returned 0 messages (file size=${sizeBytes}B) — empty or unreadable jsonl\n`,
    );
    emit({ type: "$session_empty", name, sizeBytes }, tab.id);
  }
  emit(
    {
      type: "$session_loaded",
      name,
      busy: Boolean(tab.aborter),
      messages: loadedMessages,
      carryover: {
        totalCostUsd: meta.totalCostUsd ?? 0,
        cacheHitTokens: meta.cacheHitTokens ?? 0,
        cacheMissTokens: meta.cacheMissTokens ?? 0,
        totalCompletionTokens: meta.totalCompletionTokens ?? 0,
      },
    },
    tab.id,
  );
  emitCtxBreakdown(tab);
  if (backfilledWorkspace) emitSessions(tab);
}

function currentSessionSnapshot(
  tab: Tab,
  type: "$session_loaded" | "$session_reconciled",
): SessionLoadedEvent | SessionReconciledEvent {
  const meta = loadSessionMeta(tab.currentSession);
  return {
    type,
    name: tab.currentSession,
    busy: Boolean(tab.aborter),
    messages: buildLoadedMessages(loadSessionMessages(tab.currentSession)),
    carryover: {
      totalCostUsd: meta.totalCostUsd ?? 0,
      cacheHitTokens: meta.cacheHitTokens ?? 0,
      cacheMissTokens: meta.cacheMissTokens ?? 0,
      totalCompletionTokens: meta.totalCompletionTokens ?? 0,
    },
  };
}

function emitCurrentSessionLoaded(tab: Tab): void {
  emit(currentSessionSnapshot(tab, "$session_loaded"), tab.id);
}

function emitCurrentSessionReconciled(tab: Tab): void {
  emit(currentSessionSnapshot(tab, "$session_reconciled"), tab.id);
}

function emptySessionLoadedEvent(name: string): SessionLoadedEvent {
  return {
    type: "$session_loaded",
    name,
    busy: false,
    messages: [],
    carryover: {
      totalCostUsd: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      totalCompletionTokens: 0,
    },
  };
}

function summarizeMcpSpec(raw: string): McpSpecInfo {
  try {
    const parsed = parseMcpSpec(raw);
    if (parsed.transport === "stdio") {
      const argv = [parsed.command, ...parsed.args].join(" ");
      return {
        raw,
        name: parsed.name,
        transport: "stdio",
        summary: `stdio · ${argv}`,
        status: "configured",
      };
    }
    return {
      raw,
      name: parsed.name,
      transport: parsed.transport,
      summary: `${parsed.transport} · ${parsed.url}`,
      status: "configured",
    };
  } catch (err) {
    return {
      raw,
      name: null,
      transport: "stdio",
      summary: raw,
      parseError: (err as Error).message,
      status: "failed",
      statusReason: (err as Error).message,
    };
  }
}

function emitMcpSpecs(tab: Tab): void {
  const cfg = readConfig();
  const allSpecs = normalizeMcpConfig(cfg);
  const specs = allSpecs.map((normalized) => {
    const raw = specToRaw(normalized);
    const base = summarizeMcpSpec(raw);
    if (normalized.disabled) {
      return { ...base, status: "disabled" as const };
    }
    const live = tab.mcpStatuses.get(raw);
    if (!live) return base;
    return {
      ...base,
      status: live.kind,
      statusReason: live.reason,
      toolCount: live.toolCount,
    };
  });
  const bridged = specs.length > 0 && specs.every((s) => s.status === "connected");
  emit({ type: "$mcp_specs", specs, bridged }, tab.id);
}

function emitMemory(tab: Tab): void {
  try {
    const entries = collectMemoryEntriesForWorkspace(tab.rootDir);
    emit({ type: "$memory", entries }, tab.id);
  } catch (err) {
    emit(
      {
        type: "$error",
        message: `memory_get failed: ${(err as Error).message}`,
      },
      tab.id,
    );
  }
}

function emitLibrary(tab: Tab): void {
  try {
    emit(
      {
        type: "$library_sources",
        workspaceDir: tab.rootDir,
        sources: listLibrarySourcesForWorkspace(tab.rootDir),
      },
      tab.id,
    );
  } catch (err) {
    emit(
      {
        type: "$error",
        message: `library_list failed: ${(err as Error).message}`,
      },
      tab.id,
    );
  }
}

function emitStorageScan(tab: Tab): void {
  try {
    emit(
      scanJupiterStorage({
        workspaceDir: tab.rootDir,
        recentWorkspaces: loadRecentWorkspaces(),
      }),
      tab.id,
    );
  } catch (err) {
    emit(
      {
        type: "$error",
        message: `storage_scan failed: ${(err as Error).message}`,
      },
      tab.id,
    );
  }
}

function countTokensForMeter(text: string): number {
  try {
    return countTokensBounded(text);
  } catch {
    return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length * 0.3));
  }
}

// reserved = system prompt + tool specs, constant for the tab's lifetime once
// the loop is built. logTokens is refreshed during turns so Desktop doesn't
// show a fake zero while the streaming call is still waiting on usage metadata.
function emitCtxBreakdown(tab: Tab): void {
  if (!tab.runtime) return;
  const sys = countTokensForMeter(tab.runtime.loop.prefix.system);
  const tools = countTokensForMeter(JSON.stringify(tab.runtime.loop.prefix.toolSpecs));
  let logTokens = 0;
  try {
    logTokens = tab.runtime.loop.getCurrentLogTokens();
  } catch {
    for (const msg of tab.runtime.loop.log.toFullHistory()) {
      logTokens += countTokensForMeter(typeof msg.content === "string" ? msg.content : "");
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        logTokens += countTokensForMeter(JSON.stringify(msg.tool_calls));
      }
    }
  }
  emit({ type: "$ctx_breakdown", reservedTokens: sys + tools, logTokens }, tab.id);
}

function emitCompactResult(tab: Tab, result: Omit<CompactResultEvent, "type">): void {
  emit(
    {
      type: "$compact_result",
      folded: result.folded,
      beforeMessages: result.beforeMessages,
      afterMessages: result.afterMessages,
      summaryChars: result.summaryChars,
      reason: result.reason,
      totalTokens: result.totalTokens,
      headTokens: result.headTokens,
      tailTokens: result.tailTokens,
      tailBudget: result.tailBudget,
    },
    tab.id,
  );
}

function emitSkills(tab: Tab): void {
  try {
    const store = new SkillStore({
      projectRoot: tab.rootDir,
      customSkillPaths: loadResolvedSkillPaths(tab.rootDir),
      subagentModels: loadSubagentModels(),
    });
    const items = store.list().map((s) => ({
      name: s.name,
      description: skillDisplayDescription(s),
      scope: s.scope,
      path: s.path,
      runAs: s.runAs,
      model: s.model,
    }));
    emit({ type: "$skills", items, roots: store.roots() }, tab.id);
  } catch (err) {
    emit(
      {
        type: "$error",
        message: `skills_get failed: ${(err as Error).message}`,
      },
      tab.id,
    );
  }
}

interface RuntimeState {
  loop: CacheFirstLoop;
  eventizer: Eventizer;
  ctx: {
    model: string;
    prefixHash: string;
    reasoningEffort: import("../../config.js").ReasoningEffort;
  };
}

type SymbolEntry = { name: string; path: string; line: number; kind: string };

function recordDesktopEdit(
  tab: Tab,
  source: string,
  blocks: readonly EditBlock[],
  results: readonly ApplyResult[],
  snaps: readonly EditSnapshot[],
): void {
  if (snaps.length === 0) return;
  let entry = tab.currentTurnEditEntry;
  if (!entry) {
    entry = {
      id: tab.nextEditHistoryId++,
      at: Date.now(),
      source,
      blocks: [],
      results: [],
      snapshots: [],
      undoneFiles: new Set<string>(),
    };
    tab.currentTurnEditEntry = entry;
    tab.editHistory.push(entry);
  }
  entry.blocks.push(...blocks);
  entry.results.push(...results);
  const seen = new Set(entry.snapshots.map((s) => s.path));
  for (const snap of snaps) {
    if (!seen.has(snap.path)) entry.snapshots.push(snap);
  }
}

function resultsTouchProjectMemory(
  rootDir: string,
  results: readonly ApplyResult[],
  paths: readonly string[] = [],
): boolean {
  const changed = results
    .filter((r) => r.status === "applied" || r.status === "created")
    .map((r) => r.path);
  return [...changed, ...paths].some((path) => isProjectMemoryPath(rootDir, path));
}

function desktopCodeUndo(tab: Tab, args: readonly string[] = []): CodeUndoResult {
  const revert = (entry: EditHistoryEntry, paths: readonly string[]): CodeUndoResult => {
    const subset = entry.snapshots.filter((s) => paths.includes(s.path));
    if (subset.length === 0) {
      return {
        info: `batch #${entry.id}: nothing to undo (already restored or path not in batch)`,
      };
    }
    const results = restoreSnapshots(subset, tab.rootDir);
    for (const snap of subset) entry.undoneFiles.add(snap.path);
    if (tab.currentTurnEditEntry === entry && isEntryFullyUndone(entry)) {
      tab.currentTurnEditEntry = null;
    }
    const when = new Date(entry.at).toISOString().replace("T", " ").slice(11, 19);
    const scope = subset.length === 1 ? subset[0]!.path : `${subset.length} file(s)`;
    const header = `▸ undo: reverted ${scope} from batch #${entry.id} (${when})`;
    const revertedPaths = results
      .filter((r) => r.status === "applied" || r.status === "created")
      .map((r) => r.path);
    if (resultsTouchProjectMemory(tab.rootDir, results, paths)) emitMemory(tab);
    return {
      info: [header, ...formatUndoRows(results)].join("\n"),
      contextEvent:
        revertedPaths.length > 0
          ? { batchId: entry.id, source: entry.source, paths: revertedPaths }
          : undefined,
    };
  };

  const idArg = args[0];
  const pathArg = args[1];
  if (!idArg) {
    for (let i = tab.editHistory.length - 1; i >= 0; i--) {
      const entry = tab.editHistory[i]!;
      if (isEntryFullyUndone(entry)) continue;
      const remaining = entry.snapshots
        .map((s) => s.path)
        .filter((path) => !entry.undoneFiles.has(path));
      return revert(entry, remaining);
    }
    return { info: "nothing to undo — every batch in the session history is already undone" };
  }

  const id = Number.parseInt(idArg, 10);
  if (!Number.isFinite(id)) {
    return {
      info: "usage: /undo [id] [path]   (omit id for newest; id from /history; path from /show <id>)",
    };
  }
  const entry = tab.editHistory.find((item) => item.id === id);
  if (!entry) return { info: `no edit #${id} — run /history to see valid ids` };

  if (!pathArg) {
    const remaining = entry.snapshots
      .map((s) => s.path)
      .filter((path) => !entry.undoneFiles.has(path));
    if (remaining.length === 0) return { info: `batch #${id} is already fully undone` };
    return revert(entry, remaining);
  }

  const snap = entry.snapshots.find((item) => item.path === pathArg);
  if (!snap) {
    const files = [...new Set(entry.blocks.map((block) => block.path))];
    return {
      info: `batch #${id} doesn't include "${pathArg}" — files in this batch: ${files.join(", ")}`,
    };
  }
  if (entry.undoneFiles.has(pathArg)) {
    return { info: `${pathArg} in batch #${id} is already undone` };
  }
  return revert(entry, [pathArg]);
}

function hasUndoableDesktopEdits(tab: Tab): boolean {
  return tab.editHistory.some((entry) => !isEntryFullyUndone(entry));
}

function desktopRewindLatestConversation(tab: Tab): boolean {
  if (!tab.runtime) return false;
  const ok = tab.runtime.loop.rollbackLatestTurn();
  if (!ok) return false;
  emitCurrentSessionLoaded(tab);
  emitCtxBreakdown(tab);
  return true;
}

function desktopCodeHistory(tab: Tab): string {
  if (tab.editHistory.length === 0) return "no edits recorded this session yet";
  const lines = ["Edit history (oldest first):"];
  for (const entry of tab.editHistory) {
    const when = new Date(entry.at).toISOString().replace("T", " ").slice(11, 19);
    const files = new Set(entry.blocks.map((block) => block.path));
    const fileList = [...files].join(", ");
    const fileSummary = fileList.length > 60 ? `${fileList.slice(0, 60)}…` : fileList;
    lines.push(
      `  #${String(entry.id).padStart(3)}  ${when}  ${entryStatus(entry).padEnd(7)}  ${entry.source.padEnd(12)} ${files.size} file · ${entry.blocks.length} block   ${fileSummary}`,
    );
  }
  lines.push("");
  lines.push("/show <id> [path]   → inspect edit diff");
  lines.push("/undo [id] [path]   → revert newest batch, or a specific file");
  return lines.join("\n");
}

function desktopCodeShowEdit(tab: Tab, args: readonly string[] = []): string {
  if (tab.editHistory.length === 0) return "no edits recorded this session — /history is empty";
  const idArg = args[0];
  const pathArg = args[1];
  let entry: EditHistoryEntry | undefined;
  if (!idArg) {
    entry =
      [...tab.editHistory].reverse().find((item) => !isEntryFullyUndone(item)) ??
      tab.editHistory[tab.editHistory.length - 1];
  } else {
    const id = Number.parseInt(idArg, 10);
    if (!Number.isFinite(id)) {
      return "usage: /show [id] [path]   (omit id for newest; path from file summary)";
    }
    entry = tab.editHistory.find((item) => item.id === id);
    if (!entry) return `edit #${id} not found — run /history`;
  }
  if (!entry) return "edit history lookup failed";

  if (pathArg) {
    const fileBlocks = entry.blocks.filter((block) => block.path === pathArg);
    if (fileBlocks.length === 0) {
      const files = [...new Set(entry.blocks.map((block) => block.path))];
      return `batch #${entry.id} doesn't include "${pathArg}" — files in this batch: ${files.join(", ")}`;
    }
    const when = new Date(entry.at).toISOString().replace("T", " ").slice(11, 19);
    const state = entry.undoneFiles.has(pathArg) ? "UNDONE" : "applied";
    const header = `▸ edit #${entry.id} · ${when} · ${pathArg} · ${state} · ${fileBlocks.length} block(s)`;
    const diff = formatAllBlockDiffs(fileBlocks, { maxLines: 60, contextLines: 2 });
    const footer = entry.undoneFiles.has(pathArg)
      ? "already reverted"
      : `/undo ${entry.id} ${pathArg}  → revert just this file`;
    return [header, ...diff, "", footer].join("\n");
  }

  const when = new Date(entry.at).toISOString().replace("T", " ").slice(11, 19);
  const files = [...new Set(entry.blocks.map((block) => block.path))];
  const header = `▸ edit #${entry.id} · ${when} · ${entry.source} · ${entryStatus(entry)} · ${files.length} file(s)`;
  const countLines = (value: string) =>
    value.length === 0 ? 0 : (value.match(/\n/g)?.length ?? 0) + 1;
  const fileLines = files.map((path) => {
    const fileBlocks = entry!.blocks.filter((block) => block.path === path);
    let removed = 0;
    let added = 0;
    for (const block of fileBlocks) {
      removed += countLines(block.search);
      added += countLines(block.replace);
    }
    const state = entry!.undoneFiles.has(path) ? "UNDONE" : "applied";
    return `  ${state.padEnd(7)}  -${String(removed).padStart(3)}/+${String(added).padStart(3)}   ${path}  (${fileBlocks.length} block${fileBlocks.length === 1 ? "" : "s"})`;
  });
  return [
    header,
    ...fileLines,
    "",
    `/show ${entry.id} <path>   → full diff of one file`,
    `/undo ${entry.id} <path>   → revert just that file   ·   /undo ${entry.id} → revert whole batch`,
  ].join("\n");
}

function desktopEditToolResult(
  blocks: readonly EditBlock[],
  results: readonly ApplyResult[],
): string {
  const diff = blocks.flatMap((block) => desktopUnifiedBlockDiff(block));
  return diff.length > 0
    ? `${formatEditResults([...results])}\n${diff.join("\n")}`
    : formatEditResults([...results]);
}

function desktopUnifiedBlockDiff(block: EditBlock): string[] {
  const oldLines = block.search === "" ? [] : block.search.split(/\r?\n/);
  const newLines = block.replace.split(/\r?\n/);
  return [
    `# ${block.path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `- ${line}`),
    ...newLines.map((line) => `+ ${line}`),
  ];
}

interface Tab {
  readonly id: string;
  rootDir: string;
  currentSession: string;
  currentModel: string;
  budgetUsd: number | undefined;
  /** null while the tab is bootstrapping — see `initTabToolset`. UI gates input on `$ready`, which only fires once this is set. */
  toolset: Awaited<ReturnType<typeof buildCodeToolset>> | null;
  /** Empty while bootstrapping; populated together with `toolset`. */
  system: string;
  runtime: RuntimeState | null;
  aborter: AbortController | null;
  fileIndex: FileWithStats[] | null;
  fileIndexBuilding: Promise<FileWithStats[]> | null;
  fileIndexBuiltAt: number;
  symbolIndex: SymbolEntry[] | null;
  symbolBuilding: Promise<SymbolEntry[]> | null;
  recentMentions: string[];
  /** Pause-gate ids waiting on this tab — abort uses these to free stranded plan_checkpoint / plan_revision / shell-confirm callers. */
  pendingGateIds: Set<number>;
  /** Step ids already marked complete in the in-flight plan — also tells UI when a plan is "active". */
  completedStepIds: Set<string>;
  /** Total steps in the in-flight plan (0 = no active plan / steps not provided). */
  planTotalSteps: number;
  /** True while a one-shot /plan request is waiting for its first approved plan. */
  oneShotPlanActive: boolean;
  /** Tool registry plan gate before this one-shot /plan request temporarily enabled it. */
  oneShotPlanPreviousPlanMode: boolean | null;
  /** Plan gate ids created by the one-shot /plan guard. */
  oneShotPlanGateIds: Set<number>;
  mcpRuntime: McpRuntime | null;
  mcpStatuses: Map<string, { kind: McpSpecStatus; reason?: string; toolCount?: number }>;
  subagentSink: SubagentSink;
  subagentParentSessions: Map<string, string>;
  editHistory: EditHistoryEntry[];
  nextEditHistoryId: number;
  currentTurnEditEntry: EditHistoryEntry | null;
  /** True while a session switch is in progress — prevents stale events from the old turn. */
  switching: boolean;
  hooks: ResolvedHook[];
}

let tabCounter = 0;
function nextTabId(): string {
  tabCounter++;
  return `t${tabCounter}`;
}

function isRetiredNoWorkspacePath(path: string | undefined): boolean {
  if (!path) return false;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) === "no-workspace" && parts.includes(".jupiter");
}

function repairRetiredSessionWorkspace(
  name: string,
  workspace: unknown,
  fallbackRoot: string,
): string | undefined {
  if (typeof workspace !== "string") return undefined;
  if (!isRetiredNoWorkspacePath(workspace)) return workspace;
  const repaired = resolve(fallbackRoot);
  try {
    patchSessionMeta(name, { workspace: repaired });
  } catch {
    // Session metadata repair is best-effort; loading can still continue.
  }
  return repaired;
}

function mintSessionFor(rootDir: string): string {
  const name = `desktop-${timestampSuffix()}-${tabCounter}`;
  try {
    patchSessionMeta(name, { workspace: rootDir });
  } catch {
    // session meta is for filtering only — failure shouldn't block chat
  }
  return name;
}

function emitDesktopSubagentEvent(tab: Tab, ev: SubagentEvent): void {
  if (ev.kind === "inner") return;
  const parentSession =
    ev.kind === "start"
      ? tab.currentSession
      : (tab.subagentParentSessions.get(ev.runId) ?? tab.currentSession);
  if (ev.kind === "start") tab.subagentParentSessions.set(ev.runId, parentSession);
  emit(
    {
      type: "$subagent_event",
      kind: ev.kind,
      runId: ev.runId,
      parentSession,
      sessionName: ev.sessionName,
      task: ev.task,
      skillName: ev.skillName,
      model: ev.model,
      iter: ev.iter,
      elapsedMs: ev.elapsedMs,
      summary: ev.summary,
      error: ev.error,
      turns: ev.turns,
      costUsd: ev.costUsd,
      phase: ev.phase,
      outputChars: ev.outputChars,
      reasoningChars: ev.reasoningChars,
      toolReadChars: ev.toolReadChars,
    },
    tab.id,
  );
  if (ev.kind === "end") tab.subagentParentSessions.delete(ev.runId);
}

function buildRuntimeFor(tab: Tab): RuntimeState {
  if (!tab.toolset) throw new Error("buildRuntimeFor called before initTabToolset finished");
  const toolset = tab.toolset;
  applyPlanMode(toolset.tools, loadDesktopEditMode());
  const ep = loadEndpoint();
  const client = new DeepSeekClient({ apiKey: ep.apiKey, baseUrl: ep.baseUrl });
  const prefix = new ImmutablePrefix({
    system: tab.system,
    toolSpecs: toolset.tools.specs(),
  });
  const reasoningEffort = loadReasoningEffort();
  const loop = new CacheFirstLoop({
    client,
    prefix,
    tools: toolset.tools,
    model: tab.currentModel,
    budgetUsd: tab.budgetUsd,
    session: tab.currentSession,
    reasoningEffort,
    maxIterPerTurn: loadMaxIterPerTurn(),
    hooks: tab.hooks,
    hookCwd: tab.rootDir,
  });
  const eventizer = new Eventizer();
  const ctx = {
    model: tab.currentModel,
    prefixHash: prefix.fingerprint,
    reasoningEffort,
  };
  return { loop, eventizer, ctx };
}

function installDesktopEditInterceptor(tab: Tab): void {
  if (!tab.toolset) return;
  tab.toolset.tools.addToolInterceptor("desktop-edit-history", (name, args) => {
    if (!isReviewGatedEditTool(name)) return null;
    const blocks = buildEditToolBlocks(name, args, tab.rootDir);
    if (!blocks || blocks.length === 0) return null;
    const guard = prepareAutoGitRollbackForEditBlocks(tab.rootDir, blocks, {});
    if (guard) return guard;
    const snaps = snapshotBeforeEdits(blocks, tab.rootDir);
    const results = applyEditBlocks(blocks, tab.rootDir);
    const anyApplied = results.some((r) => r.status === "applied" || r.status === "created");
    if (anyApplied) {
      recordDesktopEdit(tab, "auto", blocks, results, snaps);
      if (resultsTouchProjectMemory(tab.rootDir, results)) emitMemory(tab);
    }
    return desktopEditToolResult(blocks, results);
  });
}

const TS_EXPORT_RE =
  /^export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+\*?\s*(\w+)/;

/** TTL on the in-memory file index — without this, files deleted / renamed since the last @ popup still show up as candidates. 10s balances "fresh enough for typical edit-then-mention flows" against "don't re-scan 5000 files on every keystroke". */
const FILE_INDEX_TTL_MS = 10_000;

async function getFileIndexFor(tab: Tab): Promise<FileWithStats[]> {
  const fresh = tab.fileIndex && Date.now() - tab.fileIndexBuiltAt < FILE_INDEX_TTL_MS;
  if (fresh) return tab.fileIndex as FileWithStats[];
  if (tab.fileIndexBuilding) return tab.fileIndexBuilding;
  tab.fileIndexBuilding = listFilesWithStatsAsync(tab.rootDir, {
    maxResults: 5000,
  })
    .then((res) => {
      tab.fileIndex = res;
      tab.fileIndexBuiltAt = Date.now();
      tab.fileIndexBuilding = null;
      return res;
    })
    .catch((err) => {
      tab.fileIndexBuilding = null;
      throw err;
    });
  return tab.fileIndexBuilding;
}

async function getSymbolIndexFor(tab: Tab): Promise<SymbolEntry[]> {
  if (tab.symbolIndex) return tab.symbolIndex;
  if (tab.symbolBuilding) return tab.symbolBuilding;
  tab.symbolBuilding = (async () => {
    const files = await getFileIndexFor(tab);
    const sourceExts = /\.(?:ts|tsx|js|jsx|mts|cts)$/;
    const candidates = files.filter((f) => sourceExts.test(f.path)).slice(0, 1500);
    const out: SymbolEntry[] = [];
    const PARALLEL = 16;
    for (let i = 0; i < candidates.length; i += PARALLEL) {
      const batch = candidates.slice(i, i + PARALLEL);
      await Promise.all(
        batch.map(async (entry) => {
          const abs = isAbsolute(entry.path) ? entry.path : join(tab.rootDir, entry.path);
          try {
            const text = await readFile(abs, "utf8");
            const lines = text.split(/\r?\n/);
            for (let li = 0; li < lines.length; li++) {
              const line = lines[li]!;
              if (!line.startsWith("export ")) continue;
              const m = TS_EXPORT_RE.exec(line);
              if (m)
                out.push({
                  kind: m[1]!,
                  name: m[2]!,
                  path: entry.path,
                  line: li + 1,
                });
            }
          } catch {
            // unreadable / binary — skip
          }
        }),
      );
    }
    tab.symbolIndex = out;
    tab.symbolBuilding = null;
    return out;
  })().catch((err) => {
    tab.symbolBuilding = null;
    throw err;
  });
  return tab.symbolBuilding;
}

function rankSymbols(syms: readonly SymbolEntry[], q: string, limit: number): string[] {
  const needle = q.toLowerCase();
  const scored: { entry: SymbolEntry; score: number }[] = [];
  for (const s of syms) {
    const lower = s.name.toLowerCase();
    let score: number;
    if (lower === needle) score = 0;
    else if (lower.startsWith(needle)) score = 100;
    else if (lower.includes(needle)) score = 500 + lower.indexOf(needle);
    else continue;
    scored.push({ entry: s, score });
  }
  scored.sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, limit).map((s) => `${s.entry.path}:${s.entry.line}`);
}

function pushMentionRecent(tab: Tab, path: string): void {
  const MAX = 20;
  const idx = tab.recentMentions.indexOf(path);
  if (idx >= 0) tab.recentMentions.splice(idx, 1);
  tab.recentMentions.unshift(path);
  if (tab.recentMentions.length > MAX) tab.recentMentions.length = MAX;
}

/** The desktop sidecar is a long-running daemon — Tauri spawns this Node process once per app launch and pipes JSON over stdin/stdout. Without these handlers, any orphaned promise rejection (e.g. from an aborted turn whose cleanup races a session-switch — #1074) crashes the process with exit code 1, which the Tauri host surfaces as "jupiter exited (code 1)" and a full reconnect cycle. Log loudly so we can find the underlying bug, but don't take the daemon down. */
export function installDesktopCrashGuards(
  stderr: { write: (s: string) => unknown } = process.stderr,
): void {
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    stderr.write(`[desktop] unhandledRejection: ${err.stack ?? err.message}\n`);
  });
  process.on("uncaughtException", (err) => {
    stderr.write(`[desktop] uncaughtException: ${err.stack ?? err.message}\n`);
  });
}

export async function desktopCommand(opts: DesktopOptions): Promise<void> {
  function defaultDesktopRoot(): string {
    const configured = opts.dir ?? loadWorkspaceDir();
    const candidate = configured ? resolve(configured) : resolve(process.cwd());
    return isRetiredNoWorkspacePath(candidate) ? resolve(process.cwd()) : candidate;
  }

  function resolveDesktopRoot(input?: string): string {
    const candidate = resolve(input ?? defaultDesktopRoot());
    return isRetiredNoWorkspacePath(candidate) ? defaultDesktopRoot() : candidate;
  }

  loadDotenv();
  // Tauri spawns the bundled Node from the GUI process, which never runs the
  // user's shell init (`.bashrc` / `.zshrc` / profile). Probe the login shell
  // once so nvm / asdf / fnm / volta / mise PATH entries reach `run_command`
  // children too (#1252). No-op on Windows — system PATH already covers GUI apps.
  const augmented = augmentProcessPath();
  if (augmented.added.length > 0) {
    process.stderr.write(
      `[desktop] augmented PATH with ${augmented.added.length} login-shell entries\n`,
    );
  }
  installDesktopCrashGuards();

  const tabs = new Map<string, Tab>();
  const tabContext = new AsyncLocalStorage<string>();
  // Frontend-reported focused tab — persisted so a restart reopens on it (#1244).
  let lastActiveTabId = "";

  function activeRunningTab(): Tab | undefined {
    const id = tabContext.getStore();
    return id ? tabs.get(id) : undefined;
  }

  let first: Tab;

  const qqRuntime = {
    channel: null as QQChannel | null,
    runtimeState: "disconnected" as "disconnected" | "connecting" | "connected" | "failed",
    lastError: undefined as string | undefined,
    routing: createQQTurnRoutingState(),
  };

  const feishuRuntime = {
    channel: null as FeishuChannel | null,
    runtimeState: "disconnected" as "disconnected" | "connecting" | "connected" | "failed",
    lastError: undefined as string | undefined,
    routing: createQQTurnRoutingState(),
  };

  function currentQqSettings(): QQSettingsEvent {
    const base = loadDesktopQQState();
    return {
      type: "$qq_settings",
      ...base,
      runtimeState: qqRuntime.runtimeState,
      lastError: qqRuntime.lastError,
    };
  }

  function currentFeishuSettings(): FeishuSettingsEvent {
    const config = loadFeishuConfig();
    return {
      type: "$feishu_settings",
      appId: config.appId,
      appSecret: config.appSecret,
      enabled: config.enabled === true,
      configured: Boolean(config.appId && config.appSecret),
      requireMentionInGroup: config.requireMentionInGroup,
      runtimeState: feishuRuntime.runtimeState,
      lastError: feishuRuntime.lastError,
      appIdPreview: config.appId
        ? config.appId.length > 8
          ? `${config.appId.slice(0, 8)}...`
          : config.appId
        : undefined,
    };
  }

  function activeDesktopTab(): Tab | undefined {
    return (lastActiveTabId ? tabs.get(lastActiveTabId) : undefined) ?? first;
  }

  function broadcastQQSettings(): void {
    for (const tab of tabs.values()) emit(currentQqSettings(), tab.id);
  }

  function broadcastFeishuSettings(): void {
    for (const tab of tabs.values()) emit(currentFeishuSettings(), tab.id);
  }

  function emitFeishuSettings(tab: Tab): void {
    emit(currentFeishuSettings(), tab.id);
  }

  function setQQRuntimeState(
    runtimeState: "disconnected" | "connecting" | "connected" | "failed",
    lastError?: string,
  ): void {
    qqRuntime.runtimeState = runtimeState;
    qqRuntime.lastError = lastError;
    desktopQqRuntimeSnapshot.runtimeState = runtimeState;
    desktopQqRuntimeSnapshot.lastError = lastError;
    broadcastQQSettings();
  }

  function setFeishuRuntimeState(
    runtimeState: "disconnected" | "connecting" | "connected" | "failed",
    lastError?: string,
  ): void {
    feishuRuntime.runtimeState = runtimeState;
    feishuRuntime.lastError = lastError;
    broadcastFeishuSettings();
  }

  function sendQQInfo(message: string, tabOverride?: Tab): void {
    const tab = tabOverride ?? activeDesktopTab();
    if (tab) {
      emitStatus(tab, message);
    }
    void qqRuntime.channel?.sendResponse(message).catch((err) => {
      const active = activeDesktopTab();
      if (active) {
        emit(
          {
            type: "$error",
            message: `qq send failed: ${(err as Error).message}`,
          },
          active.id,
        );
      }
    });
  }

  function sendFeishuInfo(message: string, tabOverride?: Tab): void {
    const tab = tabOverride ?? activeDesktopTab();
    if (tab) {
      emitStatus(tab, message);
    }
    void feishuRuntime.channel?.sendResponse(message).catch((err) => {
      const active = activeDesktopTab();
      if (active) {
        emit(
          {
            type: "$error",
            message: `feishu send failed: ${(err as Error).message}`,
          },
          active.id,
        );
      }
    });
  }

  function emitStatus(tab: Tab, text: string): void {
    emit(
      {
        type: "status",
        id: Date.now(),
        ts: new Date().toISOString(),
        turn: 0,
        text,
      },
      tab.id,
    );
  }

  function finishDesktopCommand(tab: Tab): void {
    emit({ type: "$turn_complete" }, tab.id);
  }

  function emitQQNotice(message: string, tabOverride?: Tab): void {
    const tab = tabOverride ?? activeDesktopTab();
    if (tab) {
      emit(
        {
          type: "warning",
          id: Date.now(),
          ts: new Date().toISOString(),
          turn: 0,
          text: message,
          severity: "high",
        },
        tab.id,
      );
    }
  }

  function emitFeishuNotice(message: string, tabOverride?: Tab): void {
    const tab = tabOverride ?? activeDesktopTab();
    if (tab) {
      emit(
        {
          type: "warning",
          id: Date.now(),
          ts: new Date().toISOString(),
          turn: 0,
          text: message,
          severity: "high",
        },
        tab.id,
      );
    }
  }

  function startNewChatInTab(tab: Tab): void {
    if (tab.aborter) tab.switching = true;
    abortTurn(tab);
    cancelPendingGates(tab);
    tab.currentSession = mintSessionFor(tab.rootDir);
    tab.editHistory = [];
    tab.nextEditHistoryId = 1;
    tab.currentTurnEditEntry = null;
    persistOpenTabs();
    if (tab.runtime) tab.runtime = buildRuntimeFor(tab);
    emit(emptySessionLoadedEvent(tab.currentSession), tab.id);
    emitCtxBreakdown(tab);
    emitSessions(tab);
  }

  function buildSkillPayload(tab: Tab, name: string, args?: string): string | null {
    const store = new SkillStore({
      projectRoot: tab.rootDir,
      customSkillPaths: loadResolvedSkillPaths(tab.rootDir),
    });
    const found = store.read(name);
    if (!found) return null;
    const extra = args?.trim() ?? "";
    const header = `# Skill: ${found.name}${found.description ? `\n> ${found.description}` : ""}`;
    const argsLine = extra ? `\n\nArguments: ${extra}` : "";
    return `${header}\n\n${found.body}${argsLine}`;
  }

  function availableSkillNamesForTab(tab: Tab): string[] {
    const store = new SkillStore({
      projectRoot: tab.rootDir,
      customSkillPaths: loadResolvedSkillPaths(tab.rootDir),
      subagentModels: loadSubagentModels(),
    });
    return store.list().map((s) => s.name);
  }

  function runBtwOnTab(
    tab: Tab,
    question: string,
    clientId?: string,
    hooks?: {
      onAnswer?: (answer: string) => void;
      onError?: (message: string) => void;
    },
  ): void {
    if (!tab.runtime) return;
    void (async () => {
      try {
        const reply = await tab.runtime!.loop.client.chat({
          model: tab.currentModel,
          messages: [
            {
              role: "system",
              content:
                "You are answering a side question that is unrelated to the current coding conversation. Answer concisely (1-3 sentences) in plain prose. Do not call tools, do not ask clarifying questions, and do not reference any prior turns.",
            },
            { role: "user", content: question },
          ],
        });
        const answer =
          (typeof reply.content === "string" ? reply.content.trim() : "") || "(no answer)";
        emit(
          {
            type: "$btw_result",
            question,
            answer,
            ...(clientId ? { clientId } : {}),
          },
          tab.id,
        );
        hooks?.onAnswer?.(answer);
      } catch (err) {
        const message = `/btw failed: ${(err as Error).message}`;
        emit({ type: "$error", message }, tab.id);
        hooks?.onError?.(message);
      }
    })();
  }

  function handleDesktopSlash(tab: Tab, text: string, clientId?: string): void {
    const parsed = parseSlash(text);
    if (!parsed) {
      emitStatus(tab, `Not a slash command: ${text}`);
      finishDesktopCommand(tab);
      return;
    }
    if (!tab.runtime) {
      emit(
        {
          type: "$error",
          message: "Not configured yet — paste your DeepSeek API key first.",
        },
        tab.id,
      );
      finishDesktopCommand(tab);
      return;
    }

    const canonical = resolveSlashAlias(parsed.cmd);
    if (
      (canonical === "undo" || canonical === "rewind") &&
      parsed.args.length === 0 &&
      !hasUndoableDesktopEdits(tab)
    ) {
      if (desktopRewindLatestConversation(tab)) {
        emitStatus(tab, "已回退最新对话");
      } else {
        emit({ type: "$error", message: "无法回滚到当前" }, tab.id);
      }
      finishDesktopCommand(tab);
      return;
    }

    const result = handleSlash(parsed.cmd, parsed.args, tab.runtime.loop, {
      mcpSpecs: getAllMcpSpecs(readConfig()),
      codeRoot: tab.rootDir,
      memoryRoot: tab.rootDir,
      codeUndo: (args) => desktopCodeUndo(tab, args),
      codeHistory: () => desktopCodeHistory(tab),
      codeShowEdit: (args) => desktopCodeShowEdit(tab, args),
      codeApply: () => "nothing pending to apply.",
      codeDiscard: () => "nothing pending to discard.",
      planMode: false,
      editMode: loadDesktopEditMode(),
      setEditMode: (mode) => {
        const desktopMode = mode === "plan" ? "review" : mode;
        saveEditMode(desktopMode);
        if (tab.toolset) applyPlanMode(tab.toolset.tools, desktopMode);
        emitSettings(tab);
      },
      jobs: tab.toolset?.jobs,
      pendingEditCount: 0,
      postInfo: (message) => emitStatus(tab, message),
      reloadHooks: () => {
        tab.hooks = loadHooks({ projectRoot: tab.rootDir });
        return tab.hooks.length;
      },
      reloadMcp: tab.mcpRuntime
        ? async () => {
            const reload = await tab.mcpRuntime!.reloadFromConfig(tab.runtime!.loop);
            emitMcpSpecs(tab);
            return reload;
          }
        : undefined,
      qq: {
        connect: async () => {
          await startDesktopQQ(true);
          return "QQ connected";
        },
        disconnect: async () => {
          await stopDesktopQQ(true);
          return "QQ disconnected";
        },
        status: () => currentQqSettings().runtimeState,
      },
      sessionId: tab.currentSession,
    });

    if (result.clear) {
      startNewChatInTab(tab);
    }
    if (result.info) {
      emitStatus(tab, result.info);
    }
    if (result.ctxBreakdown) {
      emitCtxBreakdown(tab);
    }
    if (result.exit) {
      void gracefulShutdown();
      return;
    }
    if (result.openModelPicker) {
      emitStatus(tab, "Open Settings → Models to change model from the desktop UI.");
    }
    if (result.openSessionsPicker) {
      emitSessions(tab);
      emitStatus(tab, "Use the left sidebar session list to open saved sessions.");
    }
    if (result.openWorkspacePicker) {
      emitStatus(tab, "Use the workspace picker in the title bar to switch workspace.");
    }
    if (result.openMcpHub) {
      emitMcpSpecs(tab);
      emitStatus(tab, "Open Settings → MCP to manage MCP servers from the desktop UI.");
    }
    if (result.openArgPickerFor) {
      emitStatus(tab, `Type /${result.openArgPickerFor} with an argument to run it.`);
    }

    if (canonical === "model" && parsed.args[0]) {
      tab.currentModel = parsed.args[0];
      emitSettings(tab);
    } else if (canonical === "effort" || canonical === "budget") {
      emitSettings(tab);
    }

    if (result.resubmit) {
      void runTurn(tab, result.resubmit, false, clientId);
    } else {
      finishDesktopCommand(tab);
    }
  }

  function handleQQRemoteDesktopCommand(tab: Tab, text: string): boolean {
    const cmd = parseQQRemoteDesktopCommand(text, availableSkillNamesForTab(tab));
    if (!cmd) return false;
    if (tab.aborter && !qqRemoteCommandBypassesBusy(cmd)) {
      void qqRuntime.channel
        ?.sendResponse("Session is busy. Wait for the current turn or reply to the pending prompt.")
        .catch(() => undefined);
      return true;
    }
    switch (cmd.kind) {
      case "help":
        sendQQInfo(qqRemoteDesktopHelpText(availableSkillNamesForTab(tab)), tab);
        return true;
      case "abort":
        abortTurn(tab, { discardCurrentTurn: true });
        cancelPendingGates(tab);
        sendQQInfo("Stopped the current desktop conversation.", tab);
        return true;
      case "new":
        startNewChatInTab(tab);
        sendQQInfo("Started a new desktop conversation in the current tab.", tab);
        return true;
      case "compact":
        if (!tab.runtime) {
          sendQQInfo("Desktop is not configured yet.", tab);
          return true;
        }
        void tab.runtime.loop
          .manualCompactHistory()
          .then((result) => {
            if (result.folded) emitCurrentSessionLoaded(tab);
            emitCompactResult(tab, result);
            emitCtxBreakdown(tab);
            sendQQInfo("Compacted the current desktop conversation history.", tab);
          })
          .catch((err: Error) => {
            emit({ type: "$error", message: `/compact failed: ${err.message}` }, tab.id);
            void qqRuntime.channel
              ?.sendResponse(`/compact failed: ${err.message}`)
              .catch(() => undefined);
          });
        return true;
      case "retry": {
        if (!tab.runtime) {
          sendQQInfo("Desktop is not configured yet.", tab);
          return true;
        }
        const prev = tab.runtime.loop.retryLastUser();
        if (!prev) {
          sendQQInfo(
            "There is no previous local user message to retry in this desktop conversation.",
            tab,
          );
          return true;
        }
        void runTurn(tab, prev, true);
        return true;
      }
      case "model": {
        if (!cmd.value) {
          sendQQInfo(
            `Current model: ${tab.currentModel}. Use /model flash, /model pro, /model deepseek-v4-flash, or /model deepseek-v4-pro.`,
            tab,
          );
          return true;
        }
        const next = normalizeQQRemoteModel(cmd.value);
        if (!next) {
          sendQQInfo(
            "Unsupported desktop model. Use /model flash, /model pro, /model deepseek-v4-flash, or /model deepseek-v4-pro.",
            tab,
          );
          return true;
        }
        applyDesktopModel(tab, next);
        sendQQInfo(`Switched desktop model to ${next}.`, tab);
        return true;
      }
      case "effort":
        if (!cmd.value) {
          sendQQInfo(
            `Current reasoning effort: ${loadReasoningEffort()}. Use /effort low, /effort medium, /effort high, or /effort max.`,
            tab,
          );
          return true;
        }
        saveReasoningEffort(cmd.value);
        tab.runtime?.loop.configure({ reasoningEffort: cmd.value });
        emitSettings(tab);
        sendQQInfo(`Switched desktop reasoning effort to ${cmd.value}.`, tab);
        return true;
      case "plan":
        if (!cmd.value) {
          sendQQInfo(
            `Current plan mode: ${loadEditMode()}. Use /plan review, /plan auto, or /plan yolo.`,
            tab,
          );
          return true;
        }
        saveEditMode(cmd.value);
        if (tab.toolset) applyPlanMode(tab.toolset.tools, cmd.value);
        emitSettings(tab);
        sendQQInfo(`Switched desktop plan mode to ${cmd.value}.`, tab);
        return true;
      case "btw":
        if (!tab.runtime) {
          sendQQInfo("Desktop is not configured yet.", tab);
          return true;
        }
        runBtwOnTab(tab, cmd.text, undefined, {
          onAnswer: (answer) =>
            void qqRuntime.channel?.sendResponse(`≫ btw\n${answer}`).catch(() => undefined),
          onError: (message) =>
            void qqRuntime.channel?.sendResponse(message).catch(() => undefined),
        });
        return true;
      case "skill": {
        if (!tab.runtime) {
          sendQQInfo("Desktop is not configured yet.", tab);
          return true;
        }
        const payload = buildSkillPayload(tab, cmd.name, cmd.args);
        if (!payload) {
          emit({ type: "$error", message: `skill not found: ${cmd.name}` }, tab.id);
          void qqRuntime.channel
            ?.sendResponse(`skill not found: ${cmd.name}`)
            .catch(() => undefined);
          return true;
        }
        void runTurn(tab, payload, true);
        return true;
      }
      default:
        return false;
    }
  }

  function normalizeQQRemoteModel(value: string): string | null {
    const lower = value.trim().toLowerCase();
    if (!lower) return null;
    if (lower === "flash") return "deepseek-v4-flash";
    if (lower === "pro") return "deepseek-v4-pro";
    if (lower === "deepseek-v4-flash" || lower === "deepseek-v4-pro") return lower;
    return null;
  }

  function applyDesktopModel(tab: Tab, next: string): void {
    tab.currentModel = next;
    saveModel(next);
    if (tab.toolset) {
      tab.system = codeSystemPrompt(tab.rootDir, {
        hasSemanticSearch: tab.toolset.semantic.enabled,
        engineeringLifecycleMode: loadEngineeringLifecycleMode(),
        libraryRetrievalMode: loadLibraryRetrievalMode(),
        modelId: tab.currentModel,
      });
      if (tab.runtime) tab.runtime = buildRuntimeFor(tab);
    }
    emitSettings(tab);
  }

  function parseIndexedChoice(text: string): number {
    const rawIndex = text.match(/^(\d+)/)?.[1];
    return rawIndex ? Number.parseInt(rawIndex, 10) - 1 : -1;
  }

  function parseRunPermissionChoice(text: string): "run_once" | "always_allow" | "deny" {
    const lower = text.toLowerCase();
    if (lower.includes("1") || lower.includes("run")) return "run_once";
    if (lower.includes("2") || lower.includes("always")) return "always_allow";
    return "deny";
  }

  function parsePlanChoice(text: string): "approve" | "refine" | "cancel" {
    const lower = text.toLowerCase();
    if (lower.includes("1") || lower.includes("approve")) return "approve";
    if (lower.includes("2") || lower.includes("refine")) return "refine";
    return "cancel";
  }

  function parseCheckpointChoice(text: string): "continue" | "revise" | "stop" {
    const lower = text.toLowerCase();
    if (lower.includes("1") || lower.includes("continue")) return "continue";
    if (lower.includes("2") || lower.includes("revise")) return "revise";
    return "stop";
  }

  function parseRevisionChoice(text: string): "accept" | "reject" | "cancel" {
    const lower = text.toLowerCase();
    if (lower.includes("1") || lower.includes("accept")) return "accept";
    if (lower.includes("2") || lower.includes("reject")) return "reject";
    return "cancel";
  }

  function stripFollowupPrefix(text: string): string {
    return text
      .replace(
        /^(?:\d+\s*|approve\s*|refine\s*|cancel\s*|continue\s*|revise\s*|stop\s*|accept\s*|reject\s*|run\s*|always\s*|deny\s*)/iu,
        "",
      )
      .trim();
  }

  function handleRemotePauseReply(
    routing: ReturnType<typeof createQQTurnRoutingState>,
    tab: Tab,
    text: string,
  ): boolean {
    const pending = takeQQPendingInteraction(routing, tab.id);
    if (!pending) return false;
    const followup = stripFollowupPrefix(text);
    const interaction = pending;
    const gateId = pending.gateId;

    switch (interaction.kind) {
      case "run_command":
      case "run_background":
      case "path_access":
        pauseGate.resolve(gateId, parseRunPermissionChoice(text));
        return true;
      case "plan_proposed": {
        const payload = (interaction.payload as { plan?: string }) ?? {};
        const choice = parsePlanChoice(text);
        if (choice === "cancel") {
          pauseGate.cancel(gateId);
        } else {
          pauseGate.resolve(gateId, {
            type: choice === "approve" ? "approve" : "refine",
            feedback: followup,
            override: {
              plan: payload.plan ?? "",
              mode: choice === "approve" ? "approve" : "refine",
            },
          });
        }
        return true;
      }
      case "plan_checkpoint": {
        const payload = (interaction.payload as { stepId?: string; title?: string }) ?? {};
        const choice = parseCheckpointChoice(text);
        if (choice === "revise") {
          pauseGate.resolve(gateId, {
            type: "revise",
            feedback: followup,
            checkpoint: { stepId: payload.stepId ?? "", title: payload.title },
          });
        } else {
          pauseGate.resolve(gateId, { type: choice });
        }
        return true;
      }
      case "plan_revision":
        pauseGate.resolve(gateId, parseRevisionChoice(text));
        return true;
      case "choice": {
        const payload =
          (interaction.payload as {
            options?: ChoiceOption[];
            allowCustom?: boolean;
          }) ?? {};
        const options = payload.options ?? [];
        const pickedIndex = parseIndexedChoice(text);
        if (pickedIndex >= 0 && pickedIndex < options.length) {
          const selected = options[pickedIndex];
          if (selected) pauseGate.resolve(gateId, { type: "pick", optionId: selected.id });
          return true;
        }
        for (const option of options) {
          if (text.toLowerCase().includes(option.title.toLowerCase())) {
            pauseGate.resolve(gateId, { type: "pick", optionId: option.id });
            return true;
          }
        }
        pauseGate.resolve(
          gateId,
          payload.allowCustom ? { type: "text", text } : { type: "cancel" },
        );
        return true;
      }
      default:
        return false;
    }
  }

  function handleQQPauseReply(tab: Tab, text: string): boolean {
    return handleRemotePauseReply(qqRuntime.routing, tab, text);
  }

  function handleFeishuPauseReply(tab: Tab, text: string): boolean {
    return handleRemotePauseReply(feishuRuntime.routing, tab, text);
  }

  function formatRemotePauseRequest(
    tab: Tab,
    kind: string,
    payload: Record<string, unknown>,
  ): string {
    switch (kind) {
      case "run_command":
      case "run_background": {
        const p = payload as { command: string };
        return `Need confirmation\n\nCommand: \`${p.command}\`\n\nReply with:\n1. Run once\n2. Always allow\n3. Deny`;
      }
      case "path_access": {
        const p = payload as {
          path: string;
          intent: "read" | "write";
          toolName: string;
        };
        const intentText = p.intent === "read" ? "Read" : "Write";
        return `Need file access confirmation\n\nAction: ${intentText}\nPath: ${p.path}\nTool: ${p.toolName}\n\nReply with:\n1. Run once\n2. Always allow\n3. Deny`;
      }
      case "plan_proposed": {
        const p = payload as { plan: string };
        return `Plan confirmation\n\n${p.plan}\n\nReply with:\n1. Approve\n2. Refine\n3. Cancel`;
      }
      case "plan_checkpoint": {
        const p = payload as { title?: string; result: string };
        return `Step complete (${tab.completedStepIds.size}/${tab.planTotalSteps})\n\n${
          p.title ? `Step: ${p.title}\n` : ""
        }Result: ${p.result}\n\nReply with:\n1. Continue\n2. Revise\n3. Stop`;
      }
      case "plan_revision": {
        const p = payload as { reason: string };
        return `Plan revision proposed\n\n${p.reason}\n\nReply with:\n1. Accept\n2. Reject\n3. Cancel`;
      }
      case "choice": {
        const p = payload as {
          question: string;
          options: ChoiceOption[];
          allowCustom: boolean;
        };
        const optionsList = p.options.map((opt, idx) => `${idx + 1}. ${opt.title}`).join("\n");
        return `Please choose\n\n${p.question}\n\nOptions:\n${optionsList}${
          p.allowCustom ? "\n\n(You can also reply with custom text.)" : ""
        }`;
      }
    }
    return "";
  }

  function handleQQPauseRequest(tab: Tab, kind: string, payload: Record<string, unknown>): void {
    if (!qqRuntime.channel || !shouldRouteQQForTab(qqRuntime.routing, tab.id)) return;
    const qqMessage = formatRemotePauseRequest(tab, kind, payload);
    if (qqMessage) {
      void qqRuntime.channel.sendResponse(qqMessage).catch((err) => {
        emit(
          {
            type: "$error",
            message: `qq send failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      });
    }
  }

  function handleFeishuPauseRequest(
    tab: Tab,
    kind: string,
    payload: Record<string, unknown>,
  ): void {
    if (!feishuRuntime.channel || !shouldRouteQQForTab(feishuRuntime.routing, tab.id)) return;
    const message = formatRemotePauseRequest(tab, kind, payload);
    if (message) {
      void feishuRuntime.channel.sendResponse(message).catch((err) => {
        emit(
          {
            type: "$error",
            message: `feishu send failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      });
    }
  }

  function stripRemoteChannelPrefix(text: string): string {
    return text.replace(/^\[(?:Feishu|QQ)]\s*/i, "").trim();
  }

  function remoteSessionCandidates(tab: Tab): SessionListItem[] {
    migrateLegacyArchivedSessions();
    return listSessions()
      .filter((s) => !isInternalSessionName(s.name))
      .map((s) => toSessionListItem(s, tab))
      .filter((s) => !s.archivedAt);
  }

  function formatRemoteSessionList(tab: Tab, limit = 10): string {
    const items = remoteSessionCandidates(tab).slice(0, limit);
    if (items.length === 0) return "No saved desktop sessions.";
    const rows = items.map((item, index) => {
      const title = item.summary?.trim() || item.name;
      const marker = item.name === tab.currentSession ? "*" : " ";
      const workspace = item.workspace ? ` · ${item.workspace}` : "";
      return `${index + 1}. ${marker} ${title}\n   ${item.name}${workspace}`;
    });
    return ["Desktop sessions:", ...rows, "", "Use /session switch <number|session-name>."].join(
      "\n",
    );
  }

  function resolveRemoteSessionTarget(tab: Tab, target: string): SessionListItem | null {
    const items = remoteSessionCandidates(tab);
    const index = Number.parseInt(target, 10);
    if (Number.isInteger(index) && String(index) === target.trim() && index >= 1) {
      return items[index - 1] ?? null;
    }
    return (
      items.find((item) => item.name === target) ??
      items.find((item) => item.summary?.trim() === target.trim()) ??
      null
    );
  }

  function remoteWorkspaceCandidates(tab: Tab): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (path: string | undefined) => {
      if (!path) return;
      const resolved = resolveDesktopRoot(path);
      if (seen.has(resolved)) return;
      seen.add(resolved);
      out.push(resolved);
    };
    add(tab.rootDir);
    for (const path of loadRecentWorkspaces()) add(path);
    for (const openTab of tabs.values()) add(openTab.rootDir);
    return out;
  }

  function formatRemoteWorkspaceList(tab: Tab, limit = 10): string {
    const items = remoteWorkspaceCandidates(tab).slice(0, limit);
    if (items.length === 0) return "No known workspaces.";
    const rows = items.map((path, index) => {
      const marker = resolve(path) === resolve(tab.rootDir) ? "*" : " ";
      return `${index + 1}. ${marker} ${path}`;
    });
    return ["Desktop workspaces:", ...rows, "", "Use /workspace switch <number|path>."].join("\n");
  }

  function resolveRemoteWorkspaceTarget(tab: Tab, target: string): string | null {
    const items = remoteWorkspaceCandidates(tab);
    const index = Number.parseInt(target, 10);
    if (Number.isInteger(index) && String(index) === target.trim() && index >= 1) {
      return items[index - 1] ?? null;
    }
    return target.trim() || null;
  }

  function handleFeishuRemoteDesktopCommand(tab: Tab, text: string): boolean {
    const cmd = parseFeishuRemoteDesktopCommand(text);
    if (!cmd) return false;
    if (tab.aborter && !feishuRemoteCommandBypassesBusy(cmd)) {
      sendFeishuInfo("Session is busy. Wait for the current turn before switching context.", tab);
      return true;
    }

    switch (cmd.kind) {
      case "help":
        sendFeishuInfo(feishuRemoteDesktopHelpText(), tab);
        return true;
      case "status":
        sendFeishuInfo(
          [
            `Feishu: ${feishuRuntime.runtimeState}`,
            `Workspace: ${tab.rootDir}`,
            `Session: ${tab.currentSession || "(none)"}`,
            `Model: ${tab.currentModel}`,
            `Busy: ${tab.aborter ? "yes" : "no"}`,
          ].join("\n"),
          tab,
        );
        return true;
      case "session_list":
        sendFeishuInfo(formatRemoteSessionList(tab), tab);
        return true;
      case "session_switch": {
        const hit = resolveRemoteSessionTarget(tab, cmd.target);
        if (!hit) {
          sendFeishuInfo(
            `Session not found: ${cmd.target}\n\n${formatRemoteSessionList(tab)}`,
            tab,
          );
          return true;
        }
        const workspace = repairRetiredSessionWorkspace(
          hit.name,
          loadSessionMeta(hit.name).workspace,
          defaultDesktopRoot(),
        );
        const targetWorkspace =
          typeof workspace === "string" ? resolveDesktopRoot(workspace) : tab.rootDir;
        const load = () =>
          loadSessionIntoTab(tab, hit.name, {
            abortTurn,
            cancelPendingGates,
            persistOpenTabs,
          });
        if (resolve(targetWorkspace) !== resolve(tab.rootDir)) {
          void switchWorkspace(tab, targetWorkspace).then(() => {
            load();
            sendFeishuInfo(`Switched to session: ${hit.summary || hit.name}`, tab);
          });
        } else {
          load();
          sendFeishuInfo(`Switched to session: ${hit.summary || hit.name}`, tab);
        }
        return true;
      }
      case "session_new":
        startNewChatInTab(tab);
        sendFeishuInfo("Started a new desktop session in the current workspace.", tab);
        return true;
      case "workspace_list":
        sendFeishuInfo(formatRemoteWorkspaceList(tab), tab);
        return true;
      case "workspace_switch": {
        const target = resolveRemoteWorkspaceTarget(tab, cmd.target);
        if (!target) {
          sendFeishuInfo(`Workspace not found: ${cmd.target}`, tab);
          return true;
        }
        void switchWorkspace(tab, target).then(() => {
          sendFeishuInfo(`Switched workspace to: ${resolveDesktopRoot(target)}`, tab);
        });
        return true;
      }
      default:
        return false;
    }
  }

  async function startDesktopQQ(shouldPersistEnabled = true): Promise<void> {
    const current = loadQQConfig();
    if (!(current.appId && current.appSecret)) {
      throw new Error("QQ App ID and App Secret are required.");
    }
    if (qqRuntime.channel) {
      qqRuntime.channel.refreshAccessConfig();
      setQQRuntimeState("connected");
      return;
    }
    setQQRuntimeState("connecting");
    const channel = new QQChannel({
      onSubmitMessage: (text) => {
        const tab = activeDesktopTab();
        if (!tab) return;
        const trimmed = text.trim();
        if (!trimmed) return;
        if (handleQQRemoteDesktopCommand(tab, trimmed)) return;
        const decision = classifyDesktopQQIngress({
          hasPendingInteraction: hasQQPendingInteraction(qqRuntime.routing, tab.id),
          isBusy: !!tab.aborter,
        });
        if (decision === "pause_reply") {
          handleQQPauseReply(tab, trimmed);
          return;
        }
        if (decision === "busy") {
          void channel
            .sendResponse(
              "Session is busy. Wait for the current turn or reply to the pending prompt.",
            )
            .catch(() => undefined);
          return;
        }
        emit(
          {
            type: "user.message",
            id: Date.now(),
            ts: new Date().toISOString(),
            turn: 0,
            text: trimmed,
          },
          tab.id,
        );
        void runTurn(tab, trimmed, true);
      },
      onError: (message) => {
        const tab = activeDesktopTab();
        setQQRuntimeState("failed", message);
        if (tab) emit({ type: "$error", message: `QQ: ${message}` }, tab.id);
      },
      onInfo: (message) => emitQQNotice(`QQ: ${message}`),
    });
    try {
      await channel.start();
      qqRuntime.channel = channel;
      if (shouldPersistEnabled) setDesktopQQEnabled(true);
      setQQRuntimeState("connected");
    } catch (err) {
      await channel.stop().catch(() => undefined);
      qqRuntime.channel = null;
      if (shouldPersistEnabled) setDesktopQQEnabled(false);
      setQQRuntimeState("failed", (err as Error).message);
      throw err;
    }
  }

  async function stopDesktopQQ(shouldDisable = true): Promise<void> {
    const channel = qqRuntime.channel;
    qqRuntime.channel = null;
    clearQQTurnRouting(qqRuntime.routing);
    if (channel) {
      try {
        await channel.stop();
      } catch (err) {
        setQQRuntimeState("failed", (err as Error).message);
        throw err;
      }
    }
    if (shouldDisable) setDesktopQQEnabled(false);
    setQQRuntimeState("disconnected");
  }

  async function startDesktopFeishu(shouldPersistEnabled = true): Promise<void> {
    const current = loadFeishuConfig();
    if (!(current.appId && current.appSecret)) {
      throw new Error("Feishu App ID and App Secret are required.");
    }
    if (feishuRuntime.channel) {
      setFeishuRuntimeState("connected");
      return;
    }
    setFeishuRuntimeState("connecting");
    const channel = new FeishuChannel({
      config: current,
      onSubmitMessage: (text) => {
        const tab = activeDesktopTab();
        if (!tab) return;
        const trimmed = text.trim();
        if (!trimmed) return;
        const remoteText = stripRemoteChannelPrefix(trimmed);
        if (handleFeishuRemoteDesktopCommand(tab, remoteText)) return;
        const decision = classifyDesktopQQIngress({
          hasPendingInteraction: hasQQPendingInteraction(feishuRuntime.routing, tab.id),
          isBusy: !!tab.aborter,
        });
        if (decision === "pause_reply") {
          handleFeishuPauseReply(tab, remoteText);
          return;
        }
        if (decision === "busy") {
          void channel
            .sendResponse(
              "Session is busy. Wait for the current turn or reply to the pending prompt.",
            )
            .catch(() => undefined);
          return;
        }
        emit(
          {
            type: "user.message",
            id: Date.now(),
            ts: new Date().toISOString(),
            turn: 0,
            text: trimmed,
          },
          tab.id,
        );
        void runTurn(tab, trimmed, false, undefined, { fromFeishu: true });
      },
      onError: (message) => {
        const tab = activeDesktopTab();
        setFeishuRuntimeState("failed", message);
        if (tab) emit({ type: "$error", message: `Feishu: ${message}` }, tab.id);
      },
      onInfo: (message) => emitFeishuNotice(`Feishu: ${message}`),
    });
    try {
      await channel.start();
      feishuRuntime.channel = channel;
      if (shouldPersistEnabled) saveFeishuConfig({ ...current, enabled: true });
      setFeishuRuntimeState("connected");
    } catch (err) {
      await channel.stop().catch(() => undefined);
      feishuRuntime.channel = null;
      if (shouldPersistEnabled) saveFeishuConfig({ ...current, enabled: false });
      setFeishuRuntimeState("failed", (err as Error).message);
      throw err;
    }
  }

  async function stopDesktopFeishu(shouldDisable = true): Promise<void> {
    const channel = feishuRuntime.channel;
    feishuRuntime.channel = null;
    clearQQTurnRouting(feishuRuntime.routing);
    if (channel) {
      try {
        await channel.stop();
      } catch (err) {
        setFeishuRuntimeState("failed", (err as Error).message);
        throw err;
      }
    }
    if (shouldDisable) {
      const current = loadFeishuConfig();
      saveFeishuConfig({ ...current, enabled: false });
    }
    setFeishuRuntimeState("disconnected");
  }

  /** Synchronous tab construction — no I/O. All cheap, disk-only events (`$settings`, `$sessions`, `$memory`, `$skills`, `$mcp_specs`) can fire against this immediately. The heavy bits (`buildCodeToolset`, MCP probes, runtime construction) happen in `initTabToolset` so the UI shell paints without waiting for them. */
  function createTabSkeleton(initialDir?: string): Tab {
    const dir = resolveDesktopRoot(initialDir);
    pushRecentWorkspace(dir);
    const model = opts.model || loadModel() || DEFAULT_MODEL;
    const tab: Tab = {
      id: nextTabId(),
      rootDir: dir,
      currentSession: "",
      currentModel: model,
      budgetUsd: opts.budgetUsd,
      toolset: null,
      system: "",
      runtime: null,
      aborter: null,
      fileIndex: null,
      fileIndexBuilding: null,
      fileIndexBuiltAt: 0,
      symbolIndex: null,
      symbolBuilding: null,
      recentMentions: [],
      pendingGateIds: new Set<number>(),
      completedStepIds: new Set<string>(),
      planTotalSteps: 0,
      oneShotPlanActive: false,
      oneShotPlanPreviousPlanMode: null,
      oneShotPlanGateIds: new Set<number>(),
      mcpRuntime: null,
      mcpStatuses: new Map(),
      subagentSink: { current: null },
      subagentParentSessions: new Map(),
      editHistory: [],
      nextEditHistoryId: 1,
      currentTurnEditEntry: null,
      switching: false,
      hooks: loadHooks({ projectRoot: dir }),
    };
    tab.subagentSink.current = (ev) => emitDesktopSubagentEvent(tab, ev);
    tab.currentSession = mintSessionFor(dir);
    tabs.set(tab.id, tab);
    return tab;
  }

  /** Builds the toolset / system prompt / runtime / MCP bridge for a freshly-created skeleton. Reads `tab.currentModel` at call time so model changes during the wait are honored. */
  async function initTabToolset(tab: Tab): Promise<void> {
    const toolset = await buildCodeToolset({
      rootDir: tab.rootDir,
      onSkillInstalled: () => emitSkills(tab),
      onJobsChanged: () => emitJobs(),
      subagentSink: tab.subagentSink,
    });
    tab.toolset = toolset;
    installDesktopEditInterceptor(tab);
    tab.system = codeSystemPrompt(tab.rootDir, {
      hasSemanticSearch: toolset.semantic.enabled,
      engineeringLifecycleMode: loadEngineeringLifecycleMode(),
      libraryRetrievalMode: loadLibraryRetrievalMode(),
      modelId: tab.currentModel,
    });
    if (loadApiKey()) {
      bridgeEndpointEnv();
      tab.runtime = buildRuntimeFor(tab);
      void bridgeTabMcp(tab);
    }
  }

  function bridgeTabMcp(tab: Tab): Promise<void> {
    if (!tab.runtime || !tab.toolset) return Promise.resolve();
    if (tab.mcpRuntime) {
      // Already constructed — reload so new/removed specs settle without restart.
      return tab.mcpRuntime
        .reloadFromConfig(tab.runtime.loop)
        .then(() => emitMcpSpecs(tab))
        .catch((err) => {
          emit(
            {
              type: "$error",
              message: `mcp reload failed: ${(err as Error).message}`,
            },
            tab.id,
          );
        });
    }
    const allSpecs = getAllMcpSpecs(readConfig());
    const requested = allSpecs.length;
    if (requested === 0) return Promise.resolve();
    const runtime = createMcpRuntime({
      getTools: () => {
        if (!tab.toolset) throw new Error("toolset gone");
        return tab.toolset.tools;
      },
      getMcpPrefix: () => undefined,
      getRequestedCount: () => requested,
      getWorkspaceDir: () => tab.rootDir,
      progressSink: { current: null },
    });
    tab.mcpRuntime = runtime;
    runtime.setLifecycleSink((notice) => {
      if (notice.kind === "slow") return; // not surfaced in the desktop panel
      const specs = getAllMcpSpecs(readConfig());
      const target = specs.find((raw) => {
        try {
          return parseMcpSpec(raw).name === notice.name;
        } catch {
          return false;
        }
      });
      if (!target) return;
      if (notice.kind === "handshake") {
        tab.mcpStatuses.set(target, { kind: "handshake" });
      } else if (notice.kind === "connected") {
        tab.mcpStatuses.set(target, {
          kind: "connected",
          toolCount: notice.tools,
        });
      } else if (notice.kind === "failed") {
        tab.mcpStatuses.set(target, { kind: "failed", reason: notice.reason });
      } else if (notice.kind === "disabled") {
        tab.mcpStatuses.set(target, { kind: "disabled" });
      }
      emitMcpSpecs(tab);
    });
    return runtime
      .reloadFromConfig(tab.runtime.loop)
      .then(() => undefined)
      .catch((err) => {
        emit(
          {
            type: "$error",
            message: `mcp bridge failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      });
  }

  /** Snapshot of every open tab — workspace dir, loaded session and focus, in tab order. Persisted after open/close/switch so a restart restores the full tab set and each conversation (issues #933, #1244). */
  function persistOpenTabs(): void {
    try {
      saveDesktopOpenTabs(
        Array.from(tabs.values()).map((t) => ({
          dir: t.rootDir,
          session: t.currentSession || undefined,
          active: t.id === lastActiveTabId,
        })),
      );
    } catch {
      // best-effort — disk / perms shouldn't break tab management
    }
  }

  async function closeTab(tab: Tab): Promise<void> {
    abortTurn(tab);
    try {
      await tab.toolset?.jobs.shutdown();
    } catch {
      // shutdown errors aren't actionable here
    }
    if (tab.mcpRuntime) {
      try {
        await tab.mcpRuntime.closeAll();
      } catch {
        // MCP shutdown errors aren't actionable here either
      }
    }
    tabs.delete(tab.id);
    if (first && first.id === tab.id) {
      const next = tabs.values().next().value;
      if (next) first = next;
    }
    persistOpenTabs();
    emit({ type: "$tab_closed" }, tab.id);
  }

  async function runTurn(
    tab: Tab,
    text: string,
    fromQQ = false,
    clientId?: string,
    opts: { displayText?: string; planOneShot?: boolean; fromFeishu?: boolean } = {},
  ): Promise<void> {
    if (!tab.runtime) return;
    const rt = tab.runtime;
    const modelText = opts.planOneShot ? buildOneShotPlanPrompt(text) : text;
    tab.currentTurnEditEntry = null;
    tab.aborter = new AbortController();
    if (opts.planOneShot) beginOneShotPlanGuard(tab);
    const fromFeishu = opts.fromFeishu === true;
    if (fromQQ) markQQTurnStarted(qqRuntime.routing, tab.id);
    if (fromFeishu) markQQTurnStarted(feishuRuntime.routing, tab.id);
    if (fromQQ && qqRuntime.channel && shouldRouteQQForTab(qqRuntime.routing, tab.id)) {
      void qqRuntime.channel.sendTurnReceipt().catch((err) => {
        emit(
          {
            type: "$error",
            message: `qq turn receipt failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      });
    }
    if (fromFeishu && feishuRuntime.channel && shouldRouteQQForTab(feishuRuntime.routing, tab.id)) {
      void feishuRuntime.channel.sendTurnReceipt().catch((err) => {
        emit(
          {
            type: "$error",
            message: `feishu turn receipt failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      });
    }
    let lastAssistantText = "";
    if (tab.currentSession) {
      const existing = loadSessionMeta(tab.currentSession).summary;
      if (!existing || !existing.trim()) {
        const summary = text.replace(/\s+/g, " ").trim().slice(0, 60);
        if (summary) {
          try {
            patchSessionMeta(tab.currentSession, { summary });
          } catch {
            // meta is for display only — failure shouldn't block the turn
          }
        }
      }
    }
    if (tab.hooks.some((h) => h.event === "UserPromptSubmit")) {
      const report = await runHooks({
        hooks: tab.hooks,
        payload: { event: "UserPromptSubmit", cwd: tab.rootDir, prompt: text },
      });
      for (const o of report.outcomes) {
        if (o.decision === "pass") continue;
        emit({ type: "$error", message: formatHookOutcomeMessage(o) }, tab.id);
      }
      if (report.blocked) {
        tab.aborter = null;
        emit({ type: "$turn_complete" }, tab.id);
        if (fromQQ) markQQTurnFinished(qqRuntime.routing, tab.id);
        if (fromFeishu) markQQTurnFinished(feishuRuntime.routing, tab.id);
        return;
      }
    }
    await tabContext.run(tab.id, async () => {
      try {
        let emittedTurnContext = false;
        for await (const ev of rt.loop.step(modelText)) {
          if (!emittedTurnContext) {
            emittedTurnContext = true;
            emitCtxBreakdown(tab);
          }
          if (ev.role === "assistant_final" && ev.content) {
            lastAssistantText = ev.content;
          }
          for (const kev of rt.eventizer.consume(ev, rt.ctx)) {
            emit(
              kev.type === "user.message" && clientId
                ? { ...kev, text: opts.displayText ?? text, clientId }
                : kev,
              tab.id,
            );
          }
          if (ev.role === "assistant_final" || ev.role === "tool") {
            emitCtxBreakdown(tab);
          }
          // Memory tools mutate disk state behind the loop's back — the UI
          // panel won't know until we re-emit. Without this the right-hand
          // panel only updates on tab reopen.
          if (ev.role === "tool" && (ev.toolName === "remember" || ev.toolName === "forget")) {
            emitMemory(tab);
          }
          if (tab.aborter?.signal.aborted) break;
        }
      } catch (err) {
        emit({ type: "$error", message: (err as Error).message }, tab.id);
      } finally {
        if (opts.planOneShot) restoreOneShotPlanGuard(tab);
        tab.aborter = null;
        // If a session switch happened while this turn was running,
        // suppress stale events to avoid UI state corruption (#1217).
        if (!tab.switching) {
          if (
            fromQQ &&
            lastAssistantText &&
            qqRuntime.channel &&
            shouldRouteQQForTab(qqRuntime.routing, tab.id)
          ) {
            await qqRuntime.channel.sendResponse(lastAssistantText).catch((err) => {
              emit(
                {
                  type: "$error",
                  message: `qq send failed: ${(err as Error).message}`,
                },
                tab.id,
              );
            });
          }
          if (
            fromFeishu &&
            lastAssistantText &&
            feishuRuntime.channel &&
            shouldRouteQQForTab(feishuRuntime.routing, tab.id)
          ) {
            await feishuRuntime.channel.sendResponse(lastAssistantText).catch((err) => {
              emit(
                {
                  type: "$error",
                  message: `feishu send failed: ${(err as Error).message}`,
                },
                tab.id,
              );
            });
          }
          patchSessionMeta(tab.currentSession, {
            lastAssistantCompletedAt: Date.now(),
          });
          emitCurrentSessionReconciled(tab);
          emit({ type: "$turn_complete" }, tab.id);
          if (tab.planTotalSteps > 0 && tab.completedStepIds.size >= tab.planTotalSteps) {
            tab.completedStepIds.clear();
            tab.planTotalSteps = 0;
            emit({ type: "$plan_cleared" }, tab.id);
          }
          emitSessions(tab);
          void emitBalance(tab);
          if (tab.hooks.some((h) => h.event === "Stop")) {
            const stopReport = await runHooks({
              hooks: tab.hooks,
              payload: {
                event: "Stop",
                cwd: tab.rootDir,
                lastAssistantText,
                last_assistant_message: lastAssistantText,
                turn: rt.loop.stats.summary().turns,
              },
            });
            for (const o of stopReport.outcomes) {
              if (o.decision === "pass") continue;
              emit({ type: "$error", message: formatHookOutcomeMessage(o) }, tab.id);
            }
          }
        }
        if (fromQQ) markQQTurnFinished(qqRuntime.routing, tab.id);
        if (fromFeishu) markQQTurnFinished(feishuRuntime.routing, tab.id);
        tab.switching = false;
      }
    });
  }

  async function switchWorkspace(tab: Tab, nextDir: string): Promise<void> {
    const target = resolveDesktopRoot(nextDir);
    if (target === tab.rootDir) {
      emitSettings(tab);
      return;
    }
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      emit({ type: "$error", message: `Workspace not found: ${target}` }, tab.id);
      emitSettings(tab);
      return;
    }
    abortTurn(tab);
    try {
      await tab.toolset?.jobs.shutdown();
    } catch {
      // shutdown errors aren't actionable here
    }
    tab.rootDir = target;
    saveWorkspaceDir(target);
    pushRecentWorkspace(target);
    tab.fileIndex = null;
    tab.fileIndexBuilding = null;
    tab.fileIndexBuiltAt = 0;
    tab.symbolIndex = null;
    tab.symbolBuilding = null;
    tab.recentMentions.length = 0;
    tab.subagentParentSessions.clear();
    tab.editHistory = [];
    tab.nextEditHistoryId = 1;
    tab.currentTurnEditEntry = null;
    tab.hooks = loadHooks({ projectRoot: target });
    tab.currentSession = mintSessionFor(target);
    tab.toolset = await buildCodeToolset({
      rootDir: target,
      onSkillInstalled: () => emitSkills(tab),
      onJobsChanged: () => emitJobs(),
      subagentSink: tab.subagentSink,
    });
    installDesktopEditInterceptor(tab);
    tab.system = codeSystemPrompt(target, {
      hasSemanticSearch: tab.toolset.semantic.enabled,
      engineeringLifecycleMode: loadEngineeringLifecycleMode(),
      libraryRetrievalMode: loadLibraryRetrievalMode(),
      modelId: tab.currentModel,
    });
    if (tab.runtime) tab.runtime = buildRuntimeFor(tab);
    emitSessions(tab);
    emitSettings(tab);
    emitSkills(tab);
    persistOpenTabs();
  }

  function forgetGate(id: number): Tab | undefined {
    for (const t of tabs.values()) {
      if (t.pendingGateIds.delete(id)) return t;
    }
    return undefined;
  }

  function beginOneShotPlanGuard(tab: Tab): void {
    const tools = tab.toolset?.tools;
    if (!tools) return;
    if (tab.oneShotPlanPreviousPlanMode === null) {
      tab.oneShotPlanPreviousPlanMode = tools.planMode;
    }
    tab.oneShotPlanActive = true;
    tools.setPlanMode(true);
  }

  function restoreOneShotPlanGuard(tab: Tab): void {
    const tools = tab.toolset?.tools;
    if (tools) {
      if (tab.oneShotPlanPreviousPlanMode !== null) {
        tools.setPlanMode(tab.oneShotPlanPreviousPlanMode);
      } else {
        applyPlanMode(tools, loadDesktopEditMode());
      }
    }
    tab.oneShotPlanActive = false;
    tab.oneShotPlanPreviousPlanMode = null;
    tab.oneShotPlanGateIds.clear();
  }

  function abortTurn(tab: Tab, opts: LoopAbortOptions = {}): void {
    tab.aborter?.abort();
    tab.runtime?.loop.abort(opts);
    restoreOneShotPlanGuard(tab);
  }

  function tabSessionLabel(tab: Tab): string {
    if (tab.currentSession) {
      try {
        const summary = loadSessionMeta(tab.currentSession).summary?.trim();
        if (summary) return summary;
      } catch {
        // session file unreadable — fall through to workspace basename
      }
    }
    return tab.rootDir.split(/[\\/]/).filter(Boolean).pop() ?? tab.rootDir;
  }

  function emitJobs(): void {
    const items: JobInfoPayload[] = [];
    for (const t of tabs.values()) {
      const reg = t.toolset?.jobs;
      if (!reg) continue;
      const label = tabSessionLabel(t);
      for (const j of reg.list()) {
        items.push({
          id: j.id,
          tabId: t.id,
          sessionLabel: label,
          command: j.command,
          pid: j.pid,
          running: j.running,
          exitCode: j.exitCode,
          startedAt: j.startedAt,
          outputTail: tailLines(j.output, 8),
          spawnError: j.spawnError,
        });
      }
    }
    items.sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      return b.startedAt - a.startedAt;
    });
    emit({ type: "$jobs", items });
  }

  async function stopJob(jobId: number): Promise<boolean> {
    for (const t of tabs.values()) {
      const reg = t.toolset?.jobs;
      if (!reg) continue;
      const hit = reg.list().find((j) => j.id === jobId);
      if (!hit) continue;
      await reg.stop(jobId);
      return true;
    }
    return false;
  }

  async function stopAllJobs(): Promise<void> {
    const ops: Promise<unknown>[] = [];
    for (const t of tabs.values()) {
      const reg = t.toolset?.jobs;
      if (!reg) continue;
      for (const j of reg.list()) {
        if (j.running) ops.push(reg.stop(j.id));
      }
    }
    await Promise.allSettled(ops);
  }

  function cancelPendingGates(tab: Tab): void {
    const hadActivePlan = tab.planTotalSteps > 0 || tab.completedStepIds.size > 0;
    const ids = [...tab.pendingGateIds];
    tab.pendingGateIds.clear();
    restoreOneShotPlanGuard(tab);
    for (const id of ids) pauseGate.cancel(id);
    if (hadActivePlan) {
      tab.completedStepIds.clear();
      tab.planTotalSteps = 0;
      emit({ type: "$plan_cleared" }, tab.id);
    }
  }

  // `first` is the fallback tab for legacy tabId-less RPC messages. We
  // assign it lazily below so saved-tabs restore (issue #933) can choose
  // the boot dir before construction, and rotate `first` to the next
  // surviving tab when its source closes.
  let shuttingDown = false;
  async function gracefulShutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    await stopDesktopQQ(false).catch(() => undefined);
    await stopDesktopFeishu(false).catch(() => undefined);
    await Promise.allSettled(
      [...tabs.values()].map((t) => t.toolset?.jobs.shutdown(1500) ?? Promise.resolve()),
    );
    process.exit(0);
  }
  process.on("SIGTERM", () => {
    void gracefulShutdown();
  });
  process.on("SIGINT", () => {
    void gracefulShutdown();
  });

  pauseGate.on((req) => {
    const tab = activeRunningTab();
    const tabId = tab?.id;
    if (tab) tab.pendingGateIds.add(req.id);
    // Shared auto-resolve policy (e.g. plan_checkpoint in auto/yolo) — must
    // still run BEFORE we emit any UI event, otherwise the surface flickers
    // a card that we'd immediately tear down.
    const auto = autoResolveVerdict(req, loadEditMode());
    if (auto !== null) {
      // plan_checkpoint specifically needs the step-completed signal to flow
      // through so the rail progress ticks. Emit it before resolving.
      if (req.kind === "plan_checkpoint") {
        const payload = req.payload as {
          stepId: string;
          title?: string;
          result: string;
          notes?: string;
        };
        if (tab) tab.completedStepIds.add(payload.stepId);
        emit(
          {
            type: "$step_completed",
            stepId: payload.stepId,
            title: payload.title,
            result: payload.result,
            notes: payload.notes,
          },
          tabId,
        );
      }
      if (tab) tab.pendingGateIds.delete(req.id);
      pauseGate.resolve(req.id, auto);
      return;
    }
    if (req.kind === "run_command" || req.kind === "run_background") {
      const payload = req.payload as {
        command?: string;
        cwd?: string;
        timeoutSec?: number;
        waitSec?: number;
      };
      if (tab) {
        setQQPendingInteraction(qqRuntime.routing, tab.id, req.id, req.kind, payload);
        setQQPendingInteraction(feishuRuntime.routing, tab.id, req.id, req.kind, payload);
      }
      emit(
        {
          type: "$confirm_required",
          id: req.id,
          kind: req.kind,
          command: payload.command ?? "",
          prompt: toApprovalPrompt({
            id: req.id,
            kind: req.kind,
            payload,
          }),
        },
        tabId,
      );
      if (tab) {
        handleQQPauseRequest(tab, req.kind, payload as Record<string, unknown>);
        handleFeishuPauseRequest(tab, req.kind, payload as Record<string, unknown>);
      }
      return;
    }
    if (req.kind === "path_access") {
      const payload = req.payload as {
        path: string;
        intent: "read" | "write";
        toolName: string;
        sandboxRoot: string;
        allowPrefix: string;
      };
      if (tab) {
        setQQPendingInteraction(qqRuntime.routing, tab.id, req.id, req.kind, payload);
        setQQPendingInteraction(feishuRuntime.routing, tab.id, req.id, req.kind, payload);
      }
      emit(
        {
          type: "$path_access_required",
          id: req.id,
          path: payload.path,
          intent: payload.intent,
          toolName: payload.toolName,
          sandboxRoot: payload.sandboxRoot,
          allowPrefix: payload.allowPrefix,
          prompt: toApprovalPrompt({
            id: req.id,
            kind: req.kind,
            payload,
          }),
        },
        tabId,
      );
      if (tab) {
        handleQQPauseRequest(tab, req.kind, payload as Record<string, unknown>);
        handleFeishuPauseRequest(tab, req.kind, payload as Record<string, unknown>);
      }
      return;
    }
    if (req.kind === "choice") {
      const payload = req.payload as {
        question: string;
        options: ChoiceOption[];
        allowCustom: boolean;
      };
      if (tab) {
        setQQPendingInteraction(qqRuntime.routing, tab.id, req.id, req.kind, payload);
        setQQPendingInteraction(feishuRuntime.routing, tab.id, req.id, req.kind, payload);
      }
      emit(
        {
          type: "$choice_required",
          id: req.id,
          question: payload.question,
          options: payload.options,
          allowCustom: payload.allowCustom,
        },
        tabId,
      );
      if (tab) {
        handleQQPauseRequest(tab, req.kind, payload as Record<string, unknown>);
        handleFeishuPauseRequest(tab, req.kind, payload as Record<string, unknown>);
      }
      return;
    }
    if (req.kind === "plan_proposed") {
      const payload = req.payload as {
        plan: string;
        steps?: PlanStepLite[];
        summary?: string;
      };
      if (tab) {
        tab.completedStepIds.clear();
        tab.planTotalSteps = payload.steps?.length ?? 0;
        if (tab.oneShotPlanActive) tab.oneShotPlanGateIds.add(req.id);
        setQQPendingInteraction(qqRuntime.routing, tab.id, req.id, req.kind, payload);
        setQQPendingInteraction(feishuRuntime.routing, tab.id, req.id, req.kind, payload);
      }
      emit(
        {
          type: "$plan_required",
          id: req.id,
          plan: payload.plan,
          steps: payload.steps,
          summary: payload.summary,
        },
        tabId,
      );
      if (tab) {
        handleQQPauseRequest(tab, req.kind, payload as Record<string, unknown>);
        handleFeishuPauseRequest(tab, req.kind, payload as Record<string, unknown>);
      }
      return;
    }
    if (req.kind === "plan_checkpoint") {
      const payload = req.payload as {
        stepId: string;
        title?: string;
        result: string;
        notes?: string;
      };
      if (tab) {
        tab.completedStepIds.add(payload.stepId);
        setQQPendingInteraction(qqRuntime.routing, tab.id, req.id, req.kind, payload);
        setQQPendingInteraction(feishuRuntime.routing, tab.id, req.id, req.kind, payload);
      }
      emit(
        {
          type: "$step_completed",
          stepId: payload.stepId,
          title: payload.title,
          result: payload.result,
          notes: payload.notes,
        },
        tabId,
      );
      emit(
        {
          type: "$checkpoint_required",
          id: req.id,
          stepId: payload.stepId,
          title: payload.title,
          result: payload.result,
          notes: payload.notes,
          completed: tab?.completedStepIds.size ?? 0,
          total: tab?.planTotalSteps ?? 0,
        },
        tabId,
      );
      if (tab) {
        handleQQPauseRequest(tab, req.kind, payload as Record<string, unknown>);
        handleFeishuPauseRequest(tab, req.kind, payload as Record<string, unknown>);
      }
      return;
    }
    if (req.kind === "plan_revision") {
      const payload = req.payload as {
        reason: string;
        remainingSteps: PlanStepLite[];
        summary?: string;
      };
      if (tab) {
        setQQPendingInteraction(qqRuntime.routing, tab.id, req.id, req.kind, payload);
        setQQPendingInteraction(feishuRuntime.routing, tab.id, req.id, req.kind, payload);
      }
      emit(
        {
          type: "$revision_required",
          id: req.id,
          reason: payload.reason,
          remainingSteps: payload.remainingSteps,
          summary: payload.summary,
        },
        tabId,
      );
      if (tab) {
        handleQQPauseRequest(tab, req.kind, payload as Record<string, unknown>);
        handleFeishuPauseRequest(tab, req.kind, payload as Record<string, unknown>);
      }
      return;
    }
    // Unknown PauseKind — `never` makes a new kind without a handler a compile
    // error; the runtime cancel is the last-mile defense so the agent loop
    // doesn't hang waiting on a request no one will resolve.
    const exhaustive: never = req.kind;
    process.stderr.write(
      `[desktop] no handler for pause kind "${String(exhaustive)}" — auto-cancelling gate id=${req.id}\n`,
    );
    if (tab) tab.pendingGateIds.delete(req.id);
    pauseGate.cancel(req.id);
  });

  // Fast-path: emit disk-only events immediately so the UI shell renders
  // before the toolset finishes building. Heavy work (semantic bootstrap,
  // MCP probes, runtime construction) runs in initTabToolset which fires
  // `$ready` when it completes — until then `state.ready` keeps the
  // composer disabled, so users can't send a message before the runtime
  // exists. emitBalance was already fire-and-forget.
  function bootstrapTab(
    initialDir?: string,
    restore?: { session?: string; active?: boolean },
  ): Tab {
    const tab = createTabSkeleton(initialDir);
    // Reopen the conversation the tab had, if its jsonl is still readable.
    let restoredMessages: LoadedMessage[] | undefined;
    if (restore?.session) {
      try {
        if (existsSync(sessionPath(restore.session))) {
          const msgs = buildLoadedMessages(loadSessionMessages(restore.session));
          if (msgs.length > 0) {
            tab.currentSession = restore.session;
            restoredMessages = msgs;
          }
        }
      } catch {
        // unreadable jsonl — fall back to the freshly minted session
      }
    }
    emit(
      {
        type: "$tab_opened",
        workspaceDir: tab.rootDir,
        active: restore?.active,
        busy: Boolean(tab.aborter),
        restoringSession: restore?.session,
      },
      tab.id,
    );
    emitSessions(tab);
    emitSettings(tab);
    emitMcpSpecs(tab);
    emitSkills(tab);
    emitMemory(tab);
    emitLibrary(tab);
    emitQQSettings(tab);
    if (restoredMessages) {
      const meta = loadSessionMeta(tab.currentSession);
      emit(
        {
          type: "$session_loaded",
          name: tab.currentSession,
          busy: Boolean(tab.aborter),
          messages: restoredMessages,
          carryover: {
            totalCostUsd: meta.totalCostUsd ?? 0,
            cacheHitTokens: meta.cacheHitTokens ?? 0,
            cacheMissTokens: meta.cacheMissTokens ?? 0,
            totalCompletionTokens: meta.totalCompletionTokens ?? 0,
          },
        },
        tab.id,
      );
    }
    if (!loadApiKey()) emit({ type: "$needs_setup", reason: "no_api_key" }, tab.id);
    void emitBalance(tab);
    void initTabToolset(tab)
      .then(() => {
        if (loadApiKey()) emit({ type: "$ready" }, tab.id);
        emitCtxBreakdown(tab);
      })
      .catch((err) => {
        emit({ type: "$error", message: `init failed: ${(err as Error).message}` }, tab.id);
      });
    return tab;
  }

  function focusTab(tab: Tab): void {
    lastActiveTabId = tab.id;
    persistOpenTabs();
    emit(
      {
        type: "$tab_opened",
        workspaceDir: tab.rootDir,
        active: true,
        busy: Boolean(tab.aborter),
      },
      tab.id,
    );
  }

  function findOpenSessionTab(session: string, workspaceDir?: string): Tab | undefined {
    const candidates = Array.from(tabs.values()).filter((t) => t.currentSession === session);
    if (candidates.length === 0) return undefined;
    if (!workspaceDir) return candidates[0];
    const targetDir = resolveDesktopRoot(workspaceDir);
    return candidates.find((t) => resolve(t.rootDir) === resolve(targetDir)) ?? candidates[0];
  }

  function focusExistingSessionTab(session: string, workspaceDir?: string): boolean {
    const existing = findOpenSessionTab(session, workspaceDir);
    if (!existing) return false;
    focusTab(existing);
    return true;
  }

  function openSessionInFocusedTab(workspaceDir: string, session: string): Tab {
    const targetDir = resolveDesktopRoot(workspaceDir);
    const existing = findOpenSessionTab(session, targetDir);
    if (existing) {
      focusTab(existing);
      return existing;
    }
    const opened = bootstrapTab(targetDir, { session, active: true });
    lastActiveTabId = opened.id;
    persistOpenTabs();
    return opened;
  }

  function openNewChatInFocusedTab(workspaceDir: string): Tab {
    const opened = bootstrapTab(workspaceDir, { active: true });
    lastActiveTabId = opened.id;
    persistOpenTabs();
    return opened;
  }

  // Restore the full tab set from the previous session — workspace dir,
  // loaded session and focused tab (issues #933, #1244). Missing dirs
  // are silently skipped — a deleted workspace shouldn't break boot.
  const savedTabs = loadDesktopOpenTabs()
    .map((t) => ({ ...t, dir: resolveDesktopRoot(t.dir) }))
    .filter((t) => {
      try {
        return existsSync(t.dir) && statSync(t.dir).isDirectory();
      } catch {
        return false;
      }
    });
  // When launched with --dir, find the matching saved tab so the user's
  // previous session is restored automatically.
  const startupDir = opts.dir;
  const startupTab = startupDir
    ? savedTabs.find((t) => resolve(t.dir) === resolve(startupDir))
    : savedTabs[0];
  first = bootstrapTab(opts.dir ?? savedTabs[0]?.dir, startupTab);
  const restored: Tab[] = [first];
  for (const t of savedTabs.slice(1)) restored.push(bootstrapTab(t.dir, t));
  // Mirror the persisted focus so the next persist round-trips it.
  const activeIdx = savedTabs.findIndex((t) => t.active);
  lastActiveTabId = ((activeIdx >= 0 ? restored[activeIdx] : first) ?? first).id;
  persistOpenTabs();
  const qqConfig = loadQQConfig();
  if (qqConfig.enabled && qqConfig.appId && qqConfig.appSecret) {
    void startDesktopQQ(false).catch(() => undefined);
  } else {
    broadcastQQSettings();
  }
  const feishuConfig = loadFeishuConfig();
  if (feishuConfig.enabled && feishuConfig.appId && feishuConfig.appSecret) {
    void startDesktopFeishu(false).catch(() => undefined);
  } else {
    broadcastFeishuSettings();
  }

  const rl = createInterface({ input: stdin });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: InMessage;
    try {
      msg = JSON.parse(trimmed) as InMessage;
    } catch {
      emit({
        type: "$error",
        message: `bad json on stdin: ${trimmed.slice(0, 80)}`,
      });
      return;
    }

    if (msg.cmd === "tab_open") {
      try {
        // A user-opened tab takes focus.
        const opened = bootstrapTab(msg.workspaceDir, { active: true });
        lastActiveTabId = opened.id;
        persistOpenTabs();
      } catch (err) {
        emit({
          type: "$error",
          message: `tab_open failed: ${(err as Error).message}`,
        });
      }
      return;
    }
    if (msg.cmd === "tab_activate") {
      if (tabs.has(msg.tabId)) {
        lastActiveTabId = msg.tabId;
        persistOpenTabs();
      }
      return;
    }
    if (msg.cmd === "confirm_response") {
      forgetGate(msg.id);
      pauseGate.resolve(msg.id, msg.response);
      return;
    }
    if (msg.cmd === "choice_response") {
      forgetGate(msg.id);
      pauseGate.resolve(msg.id, msg.response);
      return;
    }
    if (msg.cmd === "plan_response") {
      const tab = forgetGate(msg.id);
      if (tab && msg.response.type === "cancel") {
        tab.completedStepIds.clear();
        tab.planTotalSteps = 0;
        emit({ type: "$plan_cleared" }, tab.id);
      }
      pauseGate.resolve(msg.id, msg.response);
      return;
    }
    if (msg.cmd === "checkpoint_response") {
      const tab = forgetGate(msg.id);
      if (tab && msg.response.type === "stop") {
        tab.completedStepIds.clear();
        tab.planTotalSteps = 0;
        emit({ type: "$plan_cleared" }, tab.id);
      }
      pauseGate.resolve(msg.id, msg.response);
      return;
    }
    if (msg.cmd === "revision_response") {
      forgetGate(msg.id);
      pauseGate.resolve(msg.id, msg.response);
      return;
    }
    if (msg.cmd === "setup_save_key") {
      const key = msg.key.trim();
      if (!isPlausibleKey(key)) {
        emit({
          type: "$error",
          message: "Key looks too short — paste the full token (16+ chars, no spaces).",
        });
        return;
      }
      try {
        saveApiKey(key);
        bridgeEndpointEnv();
        for (const tab of tabs.values()) {
          // Skeleton tabs still mid-bootstrap pick up the new key inside
          // initTabToolset's tail when buildCodeToolset settles — don't
          // try to construct a runtime against a null toolset here.
          if (!tab.toolset) {
            emitSettings(tab);
            void emitBalance(tab);
            continue;
          }
          tab.runtime = buildRuntimeFor(tab);
          emit({ type: "$ready" }, tab.id);
          emitSettings(tab);
          void emitBalance(tab);
        }
      } catch (err) {
        emit({
          type: "$error",
          message: `saveApiKey failed: ${(err as Error).message}`,
        });
      }
      return;
    }

    if (msg.cmd === "settings_sign_out") {
      try {
        clearApiKey();
        for (const t of tabs.values()) {
          t.aborter?.abort();
          t.aborter = null;
          t.runtime = null;
          emitSettings(t);
          emit({ type: "$needs_setup", reason: "no_api_key" }, t.id);
          void emitBalance(t);
        }
        const statusTab = msg.tabId ? (tabs.get(msg.tabId) ?? first) : first;
        if (statusTab) emitStatus(statusTab, "Signed out");
      } catch (err) {
        emit({
          type: "$error",
          message: `settings_sign_out failed: ${(err as Error).message}`,
        });
      }
      return;
    }

    if (msg.cmd === "desktop_resync") {
      // WebView reloads (DevTools F5, host-side respawn) leave the Node child
      // alive but the React app starts blank. Re-fire the bootstrap events
      // so it can rehydrate without restarting the agent.
      const hasKey = !!loadApiKey();
      for (const t of tabs.values()) {
        emit(
          {
            type: "$tab_opened",
            workspaceDir: t.rootDir,
            active: t.id === lastActiveTabId,
            busy: Boolean(t.aborter),
          },
          t.id,
        );
        emitSessions(t);
        emitSettings(t);
        emitMcpSpecs(t);
        emitSkills(t);
        emitMemory(t);
        emitLibrary(t);
        emitQQSettings(t);
        if (!hasKey) emit({ type: "$needs_setup", reason: "no_api_key" }, t.id);
        else if (t.toolset) emit({ type: "$ready" }, t.id);
        void emitBalance(t);
        // Re-emit session_loaded so the resumed session's messages and
        // usage stats (cost, tokens, cache%) are restored on the frontend.
        if (t.currentSession) {
          try {
            const msgs = buildLoadedMessages(loadSessionMessages(t.currentSession));
            const meta = loadSessionMeta(t.currentSession);
            emit(
              {
                type: "$session_loaded",
                name: t.currentSession,
                busy: Boolean(t.aborter),
                messages: msgs,
                carryover: {
                  totalCostUsd: meta.totalCostUsd ?? 0,
                  cacheHitTokens: meta.cacheHitTokens ?? 0,
                  cacheMissTokens: meta.cacheMissTokens ?? 0,
                  totalCompletionTokens: meta.totalCompletionTokens ?? 0,
                },
              },
              t.id,
            );
          } catch {
            // unreadable jsonl — skip re-emit
          }
        }
        emitCtxBreakdown(t);
      }
      return;
    }
    if (msg.cmd === "jobs_list") {
      emitJobs();
      return;
    }
    if (msg.cmd === "jobs_stop") {
      void stopJob(msg.jobId).finally(() => emitJobs());
      return;
    }
    if (msg.cmd === "jobs_stop_all") {
      void stopAllJobs().finally(() => emitJobs());
      return;
    }

    const tab = msg.tabId ? tabs.get(msg.tabId) : first;
    if (!tab) {
      // No tabId on the emit ⇒ the renderer's per-tab router drops it
      // silently. Surface to stderr instead so it's at least visible
      // when the desktop is launched from a terminal.
      process.stderr.write(
        `rpc dispatch: unknown tabId=${msg.tabId} for cmd=${msg.cmd} — dropping\n`,
      );
      return;
    }

    if (msg.cmd === "abort") {
      abortTurn(tab, desktopUserAbortLoopOptions());
      cancelPendingGates(tab);
      return;
    }
    if (msg.cmd === "tab_close") {
      void closeTab(tab);
      return;
    }
    if (msg.cmd === "mcp_specs_get") {
      emitMcpSpecs(tab);
      return;
    }
    if (msg.cmd === "mcp_specs_add") {
      try {
        const result = addMcpSpecSetting(msg.spec);
        if (!result.added && result.alreadyPresent) {
          emitMcpSpecs(tab);
          return;
        }
        emitMcpSpecs(tab);
        void bridgeTabMcp(tab);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `mcp_specs_add: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "mcp_specs_remove") {
      try {
        removeMcpSpecSetting(msg.spec);
        tab.mcpStatuses.delete(msg.spec);
        emitMcpSpecs(tab);
        void bridgeTabMcp(tab);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `mcp_specs_remove: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "mcp_specs_enable" || msg.cmd === "mcp_specs_disable") {
      try {
        const result = setMcpSpecDisabled(msg.name, msg.cmd === "mcp_specs_disable");
        if (result.name) {
          for (const raw of getAllMcpSpecs(readConfig())) {
            try {
              if (parseMcpSpec(raw).name === result.name) tab.mcpStatuses.delete(raw);
            } catch {
              /* ignore malformed specs in the status cache */
            }
          }
        }
        emitMcpSpecs(tab);
        void bridgeTabMcp(tab);
      } catch (err) {
        emit({ type: "$error", message: `${msg.cmd}: ${(err as Error).message}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "mcp_specs_reconnect") {
      tab.mcpStatuses.clear();
      emitMcpSpecs(tab);
      void bridgeTabMcp(tab);
      return;
    }
    if (msg.cmd === "skills_get") {
      emitSkills(tab);
      return;
    }
    if (msg.cmd === "skill_path_add") {
      try {
        const result = addSkillPathSetting(msg.path, {
          projectRoot: tab.rootDir,
        });
        if ("error" in result) {
          emit({ type: "$error", message: `skill_path_add: ${result.error}` }, tab.id);
          return;
        }
        emitSkills(tab);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `skill_path_add: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "skill_path_remove") {
      try {
        removeSkillPathSetting(msg.path, { projectRoot: tab.rootDir });
        emitSkills(tab);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `skill_path_remove: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "skill_create") {
      try {
        const result = createSkillSetting(msg.name, {
          scope: msg.scope,
          projectRoot: tab.rootDir,
        });
        if (!result.created) {
          emit({ type: "$error", message: `skill_create: ${result.error}` }, tab.id);
          return;
        }
        emitSkills(tab);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `skill_create: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "skill_model_set") {
      try {
        const result = setSkillSubagentModel(msg.name, msg.model);
        if ("error" in result) {
          emit({ type: "$error", message: `skill_model_set: ${result.error}` }, tab.id);
          return;
        }
        emitSkills(tab);
        emitSettings(tab);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `skill_model_set: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "skill_run") {
      if (!tab.runtime) {
        emit(
          {
            type: "$error",
            message: "Not configured yet — paste your DeepSeek API key first.",
          },
          tab.id,
        );
        finishDesktopCommand(tab);
        return;
      }
      try {
        const payload = buildSkillPayload(tab, msg.name, msg.args);
        if (!payload) {
          emit({ type: "$error", message: `skill not found: ${msg.name}` }, tab.id);
          finishDesktopCommand(tab);
          return;
        }
        void runTurn(tab, payload);
      } catch (err) {
        emit({ type: "$error", message: `skill_run: ${(err as Error).message}` }, tab.id);
        finishDesktopCommand(tab);
      }
      return;
    }
    if (msg.cmd === "session_list") {
      emitSessions(tab);
      emitArchivedSessions(tab);
      return;
    }
    if (msg.cmd === "session_list_archived") {
      emitArchivedSessions(tab);
      return;
    }
    if (msg.cmd === "session_delete") {
      deleteSession(msg.name);
      if (tab.currentSession === msg.name) {
        startNewChatInTab(tab);
      } else {
        emitSessions(tab);
      }
      return;
    }
    if (msg.cmd === "session_archive") {
      const archived = moveSessionToArchive(msg.name);
      if (!archived) {
        emit({ type: "$error", message: `session_archive failed: ${msg.name}` }, tab.id);
        return;
      }
      if (tab.currentSession === msg.name) {
        startNewChatInTab(tab);
      } else {
        emitSessions(tab);
      }
      emitArchivedSessions(tab);
      return;
    }
    if (msg.cmd === "session_archive_many") {
      let archivedCurrent = false;
      for (const name of msg.names) {
        const ok = moveSessionToArchive(name);
        archivedCurrent = archivedCurrent || (ok && tab.currentSession === name);
      }
      if (archivedCurrent) {
        startNewChatInTab(tab);
      } else {
        emitSessions(tab);
      }
      emitArchivedSessions(tab);
      return;
    }
    if (msg.cmd === "session_restore_archived") {
      const restored = restoreArchivedSession(msg.name);
      if (!restored) {
        emit({ type: "$error", message: `session_restore_archived failed: ${msg.name}` }, tab.id);
        return;
      }
      emitSessions(tab);
      emitArchivedSessions(tab);
      return;
    }
    if (msg.cmd === "session_delete_archived") {
      const deleted = deleteArchivedSession(msg.name);
      if (!deleted) {
        emit({ type: "$error", message: `session_delete_archived failed: ${msg.name}` }, tab.id);
        return;
      }
      emitArchivedSessions(tab);
      return;
    }
    if (msg.cmd === "session_clear_archived") {
      clearArchivedSessions();
      emitArchivedSessions(tab);
      return;
    }
    if (msg.cmd === "session_rename") {
      try {
        const trimmed = normalizeSessionTitle(msg.title);
        patchSessionMeta(msg.name, { summary: trimmed || undefined });
        emitSessions(tab);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `session_rename failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "session_patch_meta") {
      try {
        const patch: Parameters<typeof patchSessionMeta>[1] = {};
        if ("archivedAt" in msg.patch) patch.archivedAt = msg.patch.archivedAt ?? undefined;
        if ("pinnedAt" in msg.patch) patch.pinnedAt = msg.patch.pinnedAt ?? undefined;
        if ("lastReadAt" in msg.patch) patch.lastReadAt = msg.patch.lastReadAt ?? undefined;
        if ("lastAssistantCompletedAt" in msg.patch) {
          patch.lastAssistantCompletedAt = msg.patch.lastAssistantCompletedAt ?? undefined;
        }
        if ("manualUnread" in msg.patch) patch.manualUnread = msg.patch.manualUnread ?? undefined;
        patchSessionMeta(msg.name, patch);
        emitSessions(tab);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `session_patch_meta failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "session_mark_read") {
      markSessionRead(msg.name);
      emitSessions(tab);
      return;
    }
    if (msg.cmd === "session_mark_unread") {
      markSessionUnread(msg.name);
      emitSessions(tab);
      return;
    }
    if (msg.cmd === "session_import") {
      try {
        const result = importExternalSession({
          source: msg.source,
          path: msg.path,
          name: msg.name,
          workspace: tab.rootDir,
        });
        emitSessions(tab);
        loadSessionIntoTab(tab, result.name, {
          abortTurn,
          cancelPendingGates,
          persistOpenTabs,
        });
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `session_import failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "session_import_scan") {
      try {
        emit(
          {
            type: "$session_import_sources",
            apps: discoverExternalSessionApps(),
            candidates: discoverExternalSessionCandidates(),
          },
          tab.id,
        );
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `session_import_scan failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "session_import_bulk") {
      try {
        const result = importExternalSessions({
          sources: msg.sources,
          items: msg.items,
          workspace: tab.rootDir,
        });
        emitSessions(tab);
        emit(
          {
            type: "$session_import_result",
            imported: result.imported,
            skipped: result.skipped,
            failed: result.failed,
          },
          tab.id,
        );
        if (result.latestName) {
          loadSessionIntoTab(tab, result.latestName, {
            abortTurn,
            cancelPendingGates,
            persistOpenTabs,
          });
        }
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `session_import_bulk failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "session_load") {
      try {
        const workspace = repairRetiredSessionWorkspace(
          msg.name,
          loadSessionMeta(msg.name).workspace,
          defaultDesktopRoot(),
        );
        const targetWorkspace =
          typeof workspace === "string" ? resolveDesktopRoot(workspace) : tab.rootDir;
        if (focusExistingSessionTab(msg.name, targetWorkspace)) return;
        if (msg.openInNewTab || tab.aborter) {
          openSessionInFocusedTab(targetWorkspace, msg.name);
          return;
        }
        if (resolve(targetWorkspace) !== resolve(tab.rootDir)) {
          void switchWorkspace(tab, targetWorkspace).then(() =>
            loadSessionIntoTab(tab, msg.name, {
              abortTurn,
              cancelPendingGates,
              persistOpenTabs,
            }),
          );
          return;
        }
        loadSessionIntoTab(tab, msg.name, {
          abortTurn,
          cancelPendingGates,
          persistOpenTabs,
        });
      } catch (err) {
        process.stderr.write(`session_load: "${msg.name}" threw — ${(err as Error).message}\n`);
        emit(
          {
            type: "$error",
            message: `session_load failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "memory_read") {
      try {
        const detail = readMemoryEntryDetail({ path: msg.path }, tab.rootDir);
        emit({ type: "$memory_detail", detail }, tab.id);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `memory_read failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "memory_refresh") {
      emitMemory(tab);
      return;
    }
    if (msg.cmd === "memory_delete") {
      try {
        deleteMemoryEntryForWorkspace({ path: msg.path }, tab.rootDir);
        emitMemory(tab);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `memory_delete failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "memory_save") {
      try {
        const detail = saveStructuredMemoryForWorkspace(msg, tab.rootDir);
        emit({ type: "$memory_detail", detail }, tab.id);
        emitMemory(tab);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `memory_save failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "source_search") {
      const query = msg.query.trim();
      if (!query) {
        emit(
          {
            type: "$source_search_results",
            nonce: msg.nonce,
            query: msg.query,
            results: [],
          },
          tab.id,
        );
        return;
      }
      try {
        const engine = readWebSearchEngine();
        const endpoint = readWebSearchEndpoint();
        const results = await webSearch(query, {
          topK: Math.max(1, Math.min(30, msg.topK ?? 6)),
          engine,
          endpoint,
        });
        emit(
          {
            type: "$source_search_results",
            nonce: msg.nonce,
            query,
            results: results
              .filter((result) => result.url.trim().length > 0)
              .map((result) => ({
                kind: "web" as const,
                title: result.title,
                url: result.url,
                snippet: result.snippet,
              })),
          },
          tab.id,
        );
      } catch (err) {
        emit(
          {
            type: "$source_search_results",
            nonce: msg.nonce,
            query,
            results: [],
            error: err instanceof Error ? err.message : String(err),
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "source_ingest") {
      const url = msg.url.trim();
      if (!url) {
        emit(
          {
            type: "$source_ingest_result",
            nonce: msg.nonce,
            url: msg.url,
            title: msg.title,
            fetchedAt: Date.now(),
            error: "Empty URL",
          },
          tab.id,
        );
        return;
      }
      try {
        const page = await webFetch(url, { maxChars: 64_000 });
        emit(
          {
            type: "$source_ingest_result",
            nonce: msg.nonce,
            url: page.url,
            title: page.title || msg.title,
            text: page.text,
            truncated: page.truncated,
            fetchedAt: Date.now(),
          },
          tab.id,
        );
      } catch (err) {
        emit(
          {
            type: "$source_ingest_result",
            nonce: msg.nonce,
            url,
            title: msg.title,
            fetchedAt: Date.now(),
            error: err instanceof Error ? err.message : String(err),
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "library_list") {
      emitLibrary(tab);
      return;
    }
    if (msg.cmd === "storage_scan") {
      emitStorageScan(tab);
      return;
    }
    if (msg.cmd === "storage_cleanup") {
      try {
        const result = cleanupJupiterStorage({
          workspaceDir: tab.rootDir,
          recentWorkspaces: loadRecentWorkspaces(),
          itemIds: Array.isArray(msg.itemIds) ? msg.itemIds : [],
        });
        emit(result, tab.id);
        emitArchivedSessions(tab);
        emitLibrary(tab);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `storage_cleanup failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "library_add") {
      try {
        const needsWebFetch =
          msg.source.kind === "web" && Boolean(msg.source.url) && !msg.source.contentText;
        const needsFileExtract = msg.source.kind === "file" && !msg.source.contentText;
        const input =
          needsWebFetch || needsFileExtract
            ? { ...msg.source, ingestStatus: "pending" as const }
            : msg.source;
        const saved = addLibrarySourceForWorkspace(tab.rootDir, input);
        emitLibrary(tab);
        if (saved.kind === "web" && saved.url && !saved.contentText) {
          try {
            const page = await webFetch(saved.url, { maxChars: 64_000 });
            updateLibrarySourceContentForWorkspace(tab.rootDir, saved.id, {
              contentText: page.text,
              contentFetchedAt: Date.now(),
              contentTruncated: page.truncated,
              contentError: undefined,
              ingestStatus: "done",
            });
          } catch (err) {
            updateLibrarySourceContentForWorkspace(tab.rootDir, saved.id, {
              contentFetchedAt: Date.now(),
              contentError: err instanceof Error ? err.message : String(err),
              ingestStatus: "error",
            });
          }
          emitLibrary(tab);
        } else if (saved.kind === "file" && saved.path && !saved.contentText) {
          extractLibraryFileContentForWorkspace(tab.rootDir, saved.id);
          emitLibrary(tab);
        }
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `library_add failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "library_remove") {
      try {
        removeLibrarySourceForWorkspace(tab.rootDir, msg.id);
        emitLibrary(tab);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `library_remove failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "library_refresh") {
      try {
        const source = listLibrarySourcesForWorkspace(tab.rootDir).find(
          (item) => item.id === msg.id,
        );
        if (source?.kind === "web" && source.url) {
          try {
            updateLibrarySourceContentForWorkspace(tab.rootDir, source.id, {
              ingestStatus: "pending",
              contentError: undefined,
            });
            emitLibrary(tab);
            const page = await webFetch(source.url, { maxChars: 64_000 });
            updateLibrarySourceContentForWorkspace(tab.rootDir, source.id, {
              contentText: page.text,
              contentFetchedAt: Date.now(),
              contentTruncated: page.truncated,
              contentError: undefined,
              ingestStatus: "done",
            });
          } catch (err) {
            updateLibrarySourceContentForWorkspace(tab.rootDir, source.id, {
              contentFetchedAt: Date.now(),
              contentError: err instanceof Error ? err.message : String(err),
              ingestStatus: "error",
            });
          }
        } else if (source?.kind === "file" && source.path) {
          updateLibrarySourceContentForWorkspace(tab.rootDir, source.id, {
            ingestStatus: "pending",
            contentError: undefined,
          });
          emitLibrary(tab);
          extractLibraryFileContentForWorkspace(tab.rootDir, source.id);
        }
        emitLibrary(tab);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `library_refresh failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "new_chat") {
      if (msg.openInNewTab || tab.aborter) {
        openNewChatInFocusedTab(msg.workspaceDir !== undefined ? msg.workspaceDir : tab.rootDir);
        return;
      }
      if (msg.workspaceDir !== undefined && resolveDesktopRoot(msg.workspaceDir) !== tab.rootDir) {
        void switchWorkspace(tab, msg.workspaceDir).then(() => startNewChatInTab(tab));
        return;
      }
      startNewChatInTab(tab);
      return;
    }
    if (msg.cmd === "settings_get") {
      emitSettings(tab);
      return;
    }
    if (msg.cmd === "qq_status_get") {
      emitQQSettings(tab);
      return;
    }
    if (msg.cmd === "settings_save") {
      try {
        if (msg.reasoningEffort !== undefined && isReasoningEffort(msg.reasoningEffort)) {
          saveReasoningEffort(msg.reasoningEffort);
          tab.runtime?.loop.configure({ reasoningEffort: msg.reasoningEffort });
        }
        if (msg.editMode !== undefined) {
          const desktopMode = msg.editMode === "plan" ? "review" : msg.editMode;
          saveEditMode(desktopMode);
          if (tab.toolset) applyPlanMode(tab.toolset.tools, desktopMode);
        }
        if (msg.budgetUsd !== undefined) {
          tab.budgetUsd = msg.budgetUsd ?? undefined;
          tab.runtime?.loop.setBudget(msg.budgetUsd);
        }
        if (msg.baseUrl !== undefined) saveBaseUrl(msg.baseUrl);
        if (msg.workspaceDir !== undefined) {
          void switchWorkspace(tab, msg.workspaceDir);
          return;
        }
        if (msg.recentWorkspaces !== undefined) {
          const cfg = readConfig();
          cfg.recentWorkspaces = msg.recentWorkspaces;
          writeConfig(cfg);
        }
        if (msg.editor !== undefined) saveEditor(msg.editor);
        if (
          msg.desktopCloseBehavior === "closeToTray" ||
          msg.desktopCloseBehavior === "closeToQuit"
        ) {
          saveDesktopCloseBehavior(msg.desktopCloseBehavior);
        }
        if (msg.showSystemEvents !== undefined) saveShowSystemEvents(msg.showSystemEvents);
        if (msg.processCardsDefaultOpen !== undefined) {
          saveProcessCardsDefaultOpen(msg.processCardsDefaultOpen);
        }
        if (msg.memoryConfirmWrites !== undefined) {
          saveMemoryConfirmWrites(msg.memoryConfirmWrites);
        }
        if (msg.memoryGlobalEnabled !== undefined) {
          saveMemoryGlobalEnabled(msg.memoryGlobalEnabled);
        }
        if (
          msg.webSearchEngine !== undefined ||
          msg.webSearchEndpoint !== undefined ||
          msg.metasoApiKey !== undefined ||
          msg.baiduApiKey !== undefined ||
          msg.tavilyApiKey !== undefined ||
          msg.perplexityApiKey !== undefined ||
          msg.exaApiKey !== undefined ||
          msg.ollamaApiKey !== undefined ||
          msg.braveApiKey !== undefined
        ) {
          const cfg = readConfig();
          if (msg.webSearchEngine !== undefined) cfg.webSearchEngine = msg.webSearchEngine;
          if (msg.webSearchEndpoint !== undefined) {
            cfg.webSearchEndpoint = msg.webSearchEndpoint?.trim() || undefined;
          }
          if (msg.metasoApiKey !== undefined) {
            cfg.metasoApiKey = msg.metasoApiKey?.trim() || undefined;
          }
          if (msg.baiduApiKey !== undefined) {
            cfg.baiduApiKey = msg.baiduApiKey?.trim() || undefined;
          }
          if (msg.tavilyApiKey !== undefined) {
            cfg.tavilyApiKey = msg.tavilyApiKey?.trim() || undefined;
          }
          if (msg.perplexityApiKey !== undefined) {
            cfg.perplexityApiKey = msg.perplexityApiKey?.trim() || undefined;
          }
          if (msg.exaApiKey !== undefined) {
            cfg.exaApiKey = msg.exaApiKey?.trim() || undefined;
          }
          if (msg.ollamaApiKey !== undefined) {
            cfg.ollamaApiKey = msg.ollamaApiKey?.trim() || undefined;
          }
          if (msg.braveApiKey !== undefined) {
            cfg.braveApiKey = msg.braveApiKey?.trim() || undefined;
          }
          writeConfig(cfg);
        }
        if (msg.promptHistory !== undefined && msg.promptHistory.length > 0) {
          // Frontend sends [newEntry]; merge against the current persisted list
          // here (on the backend) so concurrent tabs never clobber each other.
          const existing = loadPromptHistory();
          const entry = msg.promptHistory[0]!;
          const merged = [entry, ...existing.filter((e) => e !== entry)].slice(0, 100);
          savePromptHistory(merged);
          emitSettings(tab);
        }
        if (msg.subagentModels !== undefined) {
          saveSubagentModels(msg.subagentModels);
          emitSkills(tab);
        }
        if (msg.skillPackSources !== undefined) {
          saveSkillPackSources(msg.skillPackSources);
        }
        if (msg.contextTokens !== undefined) {
          const cfg = readConfig();
          cfg.contextTokens = msg.contextTokens;
          writeConfig(cfg);
        }
        if (msg.libraryRetrievalMode !== undefined) {
          saveLibraryRetrievalMode(msg.libraryRetrievalMode);
          if (tab.toolset) {
            tab.system = codeSystemPrompt(tab.rootDir, {
              hasSemanticSearch: tab.toolset.semantic.enabled,
              engineeringLifecycleMode: loadEngineeringLifecycleMode(),
              libraryRetrievalMode: loadLibraryRetrievalMode(),
              modelId: tab.currentModel,
            });
            if (tab.runtime) tab.runtime = buildRuntimeFor(tab);
          }
        }
        if (msg.model !== undefined) {
          const next = msg.model.trim();
          if (next) {
            applyDesktopModel(tab, next);
          }
        }
        emitSettings(tab);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `settings_save failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "qq_config_save") {
      try {
        saveDesktopQQSettings(
          {
            appId: msg.appId,
            appSecret: msg.appSecret,
            sandbox: msg.sandbox,
          },
          undefined,
        );
        emitQQSettings(tab);
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `qq_config_save failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "qq_connect") {
      try {
        const current = loadQQConfig();
        emit(
          {
            type: "status",
            id: Date.now(),
            ts: new Date().toISOString(),
            turn: 0,
            text: `QQ connecting (${current.sandbox ? "sandbox" : "production"})`,
          },
          tab.id,
        );
        void startDesktopQQ(true).then(
          () => {
            emit(
              {
                type: "status",
                id: Date.now(),
                ts: new Date().toISOString(),
                turn: 0,
                text: `QQ connected (${current.sandbox ? "sandbox" : "production"})`,
              },
              tab.id,
            );
            emitQQSettings(tab);
          },
          (err) => {
            emit(
              {
                type: "$error",
                message: `qq_connect failed: ${(err as Error).message}`,
              },
              tab.id,
            );
            emitQQSettings(tab);
          },
        );
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `qq_connect failed: ${(err as Error).message}`,
          },
          tab.id,
        );
        emitQQSettings(tab);
      }
      return;
    }
    if (msg.cmd === "qq_disconnect") {
      try {
        void stopDesktopQQ(true).then(
          () => {
            emit(
              {
                type: "status",
                id: Date.now(),
                ts: new Date().toISOString(),
                turn: 0,
                text: "QQ disabled",
              },
              tab.id,
            );
            emitQQSettings(tab);
          },
          (err) => {
            emit(
              {
                type: "$error",
                message: `qq_disconnect failed: ${(err as Error).message}`,
              },
              tab.id,
            );
            emitQQSettings(tab);
          },
        );
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `qq_disconnect failed: ${(err as Error).message}`,
          },
          tab.id,
        );
        emitQQSettings(tab);
      }
      return;
    }
    if (msg.cmd === "feishu_config_save") {
      try {
        const current = loadFeishuConfig();
        saveFeishuConfig({
          ...current,
          appId: msg.appId?.trim() || undefined,
          appSecret: msg.appSecret?.trim() || undefined,
          requireMentionInGroup: msg.requireMentionInGroup ?? current.requireMentionInGroup,
        });
        emitFeishuSettings(tab);
        emitStatus(tab, "Feishu settings saved");
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `feishu_config_save failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "feishu_status_get") {
      emitFeishuSettings(tab);
      return;
    }
    if (msg.cmd === "feishu_connect") {
      try {
        emitStatus(tab, "Feishu connecting");
        void startDesktopFeishu(true).then(
          () => {
            emitStatus(tab, "Feishu connected");
            emitFeishuSettings(tab);
          },
          (err) => {
            emit(
              {
                type: "$error",
                message: `feishu_connect failed: ${(err as Error).message}`,
              },
              tab.id,
            );
            emitFeishuSettings(tab);
          },
        );
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `feishu_connect failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "feishu_disconnect") {
      try {
        void stopDesktopFeishu(true).then(
          () => {
            emitStatus(tab, "Feishu disabled");
            emitFeishuSettings(tab);
          },
          (err) => {
            emit(
              {
                type: "$error",
                message: `feishu_disconnect failed: ${(err as Error).message}`,
              },
              tab.id,
            );
            emitFeishuSettings(tab);
          },
        );
      } catch (err) {
        emit(
          {
            type: "$error",
            message: `feishu_disconnect failed: ${(err as Error).message}`,
          },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "mention_query") {
      const nonce = msg.nonce;
      const query = msg.query;
      const parsed = parseAtQuery(query);
      // Empty query → list workspace root's top-level entries (tree
      // style). Without this, bare `@` floods with all 5000 files; the
      // TUI's @+Tab pattern already shows the tree top.
      const treeWalk = parsed.trailingSlash || query.length === 0;
      if (treeWalk) {
        void listDirectory(tab.rootDir, parsed.dir)
          .then((entries) => {
            const results = entries.map((e) => (e.isDir ? `${e.path}/` : e.path));
            emit({ type: "$mention_results", nonce, query, results }, tab.id);
          })
          .catch((err) => {
            emit(
              {
                type: "$error",
                message: `mention_query (dir) failed: ${(err as Error).message}`,
              },
              tab.id,
            );
            emit({ type: "$mention_results", nonce, query, results: [] }, tab.id);
          });
        return;
      }
      const wantSymbols = query.length >= 2 && !query.includes("/");
      void (async () => {
        try {
          const files = await getFileIndexFor(tab);
          const fileResults = rankPickerCandidates(files, query, {
            limit: wantSymbols ? 19 : 25,
            recentlyUsed: tab.recentMentions,
          });
          let symResults: string[] = [];
          if (wantSymbols) {
            const syms = await getSymbolIndexFor(tab);
            symResults = rankSymbols(syms, query, 6);
          }
          emit(
            {
              type: "$mention_results",
              nonce,
              query,
              results: [...symResults, ...fileResults],
            },
            tab.id,
          );
        } catch (err) {
          emit(
            {
              type: "$error",
              message: `mention_query failed: ${(err as Error).message}`,
            },
            tab.id,
          );
          emit({ type: "$mention_results", nonce, query, results: [] }, tab.id);
        }
      })();
      return;
    }
    if (msg.cmd === "mention_picked") {
      pushMentionRecent(tab, msg.path);
      return;
    }
    if (msg.cmd === "mention_preview") {
      const nonce = msg.nonce;
      const rel = msg.path;
      const abs = isAbsolute(rel) ? rel : join(tab.rootDir, rel);
      const safeAbs = resolve(abs);
      const safeRoot = resolve(tab.rootDir);
      if (!safeAbs.startsWith(safeRoot)) {
        emit(
          {
            type: "$mention_preview",
            nonce,
            path: rel,
            head: "",
            totalLines: 0,
          },
          tab.id,
        );
        return;
      }
      void readFile(safeAbs, "utf8")
        .then((text) => {
          const lines = text.split(/\r?\n/);
          if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
          const head = lines.slice(0, 12).join("\n");
          emit(
            {
              type: "$mention_preview",
              nonce,
              path: rel,
              head,
              totalLines: lines.length,
            },
            tab.id,
          );
        })
        .catch(() => {
          emit(
            {
              type: "$mention_preview",
              nonce,
              path: rel,
              head: "",
              totalLines: 0,
            },
            tab.id,
          );
        });
      return;
    }
    if (msg.cmd === "compact_history") {
      if (!tab.runtime) return;
      void tab.runtime.loop
        .manualCompactHistory()
        .then((result) => {
          if (result.folded) emitCurrentSessionLoaded(tab);
          emitCompactResult(tab, result);
          emitCtxBreakdown(tab);
        })
        .catch((err: Error) => {
          emit({ type: "$error", message: `/compact failed: ${err.message}` }, tab.id);
        });
      return;
    }
    if (msg.cmd === "retry") {
      if (!tab.runtime) return;
      const prev = tab.runtime.loop.retryLastUser();
      if (prev) {
        emit({ type: "$retry_result", text: prev }, tab.id);
      }
      return;
    }
    if (msg.cmd === "rollback_to_turn") {
      if (!tab.runtime) return;
      const ok = tab.runtime.loop.rollbackToTurn({
        turn: msg.turn,
        role: msg.role,
      });
      if (!ok) {
        emit({ type: "$error", message: "无法回滚到当前" }, tab.id);
        return;
      }
      emitCurrentSessionLoaded(tab);
      emitCtxBreakdown(tab);
      return;
    }
    if (msg.cmd === "slash") {
      handleDesktopSlash(tab, msg.text, msg.clientId);
      return;
    }
    if (msg.cmd === "btw") {
      if (!tab.runtime) {
        finishDesktopCommand(tab);
        return;
      }
      const question = msg.text.trim();
      if (!question) {
        finishDesktopCommand(tab);
        return;
      }
      runBtwOnTab(tab, question, msg.clientId);
      return;
    }
    if (msg.cmd === "user_input") {
      if (!tab.runtime) {
        emit(
          {
            type: "$error",
            message: "Not configured yet — paste your DeepSeek API key first.",
          },
          tab.id,
        );
        finishDesktopCommand(tab);
        return;
      }
      if (!msg.planOneShot && !msg.text.trim().startsWith("/")) {
        const intent = await classifyDesktopNaturalCommandIntent(tab.runtime.loop.client, {
          model: tab.runtime.loop.model,
          text: msg.text,
        });
        if (intent.command === "compact_history") {
          emitCurrentSessionLoaded(tab);
          emitStatus(tab, t("handlers.observability.compactStarting"));
          void tab.runtime.loop
            .manualCompactHistory()
            .then((result) => {
              if (result.folded) emitCurrentSessionLoaded(tab);
              emitCompactResult(tab, result);
              emitCtxBreakdown(tab);
            })
            .catch((err: Error) => {
              emit({ type: "$error", message: `/compact failed: ${err.message}` }, tab.id);
            })
            .finally(() => finishDesktopCommand(tab));
          return;
        }
      }
      void runTurn(tab, msg.text, false, msg.clientId, {
        displayText: msg.displayText,
        planOneShot: msg.planOneShot === true,
      });
    }
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      void gracefulShutdown();
      resolve();
    });
  });
}
