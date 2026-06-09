export type ReadyEvent = { type: "$ready" };
export type ProtocolErrorEvent = { type: "$error"; message: string };
export type TurnCompleteEvent = { type: "$turn_complete" };
export type PathAccessRequiredEvent = {
  type: "$path_access_required";
  id: number;
  path: string;
  intent: "read" | "write";
  toolName: string;
  sandboxRoot: string;
  allowPrefix: string;
  prompt?: import("@jupiter/core-utils").ApprovalPrompt;
};

export type ConfirmRequiredEvent = {
  type: "$confirm_required";
  id: number;
  kind: "run_command" | "run_background";
  command: string;
  prompt?: import("@jupiter/core-utils").ApprovalPrompt;
};

export type ConfirmationChoice =
  | { type: "deny"; denyContext?: string }
  | { type: "run_once" }
  | { type: "always_allow"; prefix: string };

export type ChoiceOption = {
  id: string;
  title: string;
  summary?: string;
};

export type ChoiceRequiredEvent = {
  type: "$choice_required";
  id: number;
  question: string;
  options: ChoiceOption[];
  allowCustom: boolean;
};

export type ChoiceVerdict =
  | { type: "pick"; optionId: string }
  | { type: "text"; text: string }
  | { type: "cancel" };

export type PlanRequiredEvent = {
  type: "$plan_required";
  id: number;
  plan: string;
  steps?: unknown[];
  summary?: string;
};

export type PlanVerdict =
  | { type: "approve"; feedback?: string }
  | { type: "refine"; feedback?: string }
  | { type: "cancel"; feedback?: string };

export type PlanStep = {
  id: string;
  title: string;
  action: string;
  risk?: "low" | "med" | "high";
};

export type CheckpointRequiredEvent = {
  type: "$checkpoint_required";
  id: number;
  stepId: string;
  title?: string;
  result: string;
  notes?: string;
  completed: number;
  total: number;
};

export type CheckpointVerdict =
  | { type: "continue" }
  | { type: "revise"; feedback?: string }
  | { type: "stop" };

export type RevisionRequiredEvent = {
  type: "$revision_required";
  id: number;
  reason: string;
  remainingSteps: PlanStep[];
  summary?: string;
};

export type RevisionVerdict = { type: "accepted" } | { type: "rejected" } | { type: "cancelled" };

export type StepCompletedEvent = {
  type: "$step_completed";
  stepId: string;
  title?: string;
  result: string;
  notes?: string;
};

export type PlanClearedEvent = { type: "$plan_cleared" };

export type SessionListItem = {
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

export type SessionsEvent = {
  type: "$sessions";
  items: SessionListItem[];
};

export type ArchivedSessionsEvent = {
  type: "$archived_sessions";
  items: SessionListItem[];
};

export type ExternalSessionSource = "claude" | "codex";

export type ExternalSessionApp = {
  source: ExternalSessionSource;
  label: string;
  root: string;
  available: boolean;
  sessionCount: number;
  latestMtime?: string;
};

export type ExternalSessionCandidate = {
  source: ExternalSessionSource;
  label: string;
  path: string;
  name: string;
  summary?: string;
  workspace?: string;
  messageCount: number;
  mtime: string;
  imported: boolean;
  subagent: boolean;
};

export type ExternalSessionSelection = {
  source: ExternalSessionSource;
  path: string;
};

export type SessionImportSourcesEvent = {
  type: "$session_import_sources";
  apps: ExternalSessionApp[];
  candidates?: ExternalSessionCandidate[];
};

export type SessionImportResultEvent = {
  type: "$session_import_result";
  imported: number;
  skipped: number;
  failed: number;
};

export type MentionResultsEvent = {
  type: "$mention_results";
  nonce: number;
  query: string;
  results: string[];
};

export type MentionPreviewEvent = {
  type: "$mention_preview";
  nonce: number;
  path: string;
  head: string;
  totalLines: number;
};

export type SourceSearchResult = {
  kind: "web";
  title: string;
  url: string;
  snippet: string;
};

export type SourceSearchResultsEvent = {
  type: "$source_search_results";
  nonce: number;
  query: string;
  results: SourceSearchResult[];
  error?: string;
};

export type SourceIngestResultEvent = {
  type: "$source_ingest_result";
  nonce: number;
  url: string;
  title?: string;
  text?: string;
  truncated?: boolean;
  fetchedAt?: number;
  error?: string;
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
  ingestStatus?: "pending" | "done" | "error";
  addedAt: number;
  updatedAt?: number;
};

export type LibrarySourcesEvent = {
  type: "$library_sources";
  workspaceDir: string;
  sources: LibrarySource[];
};

export type TabOpenedEvent = {
  type: "$tab_opened";
  workspaceDir: string;
  /** True when the frontend should focus this tab (user-opened, or the restored focused tab). */
  active?: boolean;
  /** True when the tab has an in-flight agent turn in the backend. */
  busy?: boolean;
  /** Session being restored into a newly opened tab; used to avoid focusing an empty shell before the snapshot arrives. */
  restoringSession?: string;
};

export type TabClosedEvent = {
  type: "$tab_closed";
};

export type McpSpecStatus = "configured" | "handshake" | "connected" | "failed" | "disabled";

export type McpSpecInfo = {
  raw: string;
  name: string | null;
  transport: "stdio" | "sse" | "streamable-http";
  summary: string;
  parseError?: string;
  status: McpSpecStatus;
  statusReason?: string;
  toolCount?: number;
};

export type McpSpecsEvent = {
  type: "$mcp_specs";
  specs: McpSpecInfo[];
  bridged: boolean;
};

export type SubagentRunStatus = "running" | "done" | "failed";

export type SubagentRunInfo = {
  runId: string;
  parentSession?: string;
  sessionName?: string;
  task: string;
  skillName?: string;
  model?: string;
  status: SubagentRunStatus;
  phase?: "exploring" | "summarising";
  iter?: number;
  elapsedMs?: number;
  summary?: string;
  error?: string;
  turns?: number;
  costUsd?: number;
  outputChars?: number;
  reasoningChars?: number;
  toolReadChars?: number;
};

export type SubagentEvent = {
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

export type SkillScope = "project" | "custom" | "global" | "builtin";

export type SkillInfo = {
  name: string;
  description: string;
  scope: SkillScope;
  path: string;
  runAs: "inline" | "subagent";
  model?: string;
};

export type SkillRootInfo = {
  dir: string;
  scope: SkillScope;
  status: "ok" | "missing" | "not-directory" | "unreadable";
  priority: number;
};

export type SkillsEvent = {
  type: "$skills";
  items: SkillInfo[];
  roots?: SkillRootInfo[];
};

export type CtxBreakdownEvent = {
  type: "$ctx_breakdown";
  reservedTokens: number;
  /** Current log token count (real-time) — sent after /compact to refresh the meter. */
  logTokens?: number;
};

export type MemoryEntryInfo = {
  kind: "project_file" | "global_file" | "structured";
  name: string;
  scope: "project" | "global";
  path: string;
  description: string;
  type?: string;
  priority?: "low" | "medium" | "high";
  expires?: "project_end";
};

export type MemoryWriteInput = {
  path?: string;
  name: string;
  scope: "project" | "global";
  type: "user" | "feedback" | "project" | "reference" | (string & {});
  description: string;
  body: string;
  priority?: "low" | "medium" | "high";
  expires?: "project_end";
};

export type MemoryEvent = {
  type: "$memory";
  entries: MemoryEntryInfo[];
};

export type MemoryDetail = MemoryEntryInfo & {
  body: string;
  createdAt?: string;
};

export type MemoryDetailEvent = {
  type: "$memory_detail";
  detail: MemoryDetail;
};

export type RetryResultEvent = { type: "$retry_result"; text: string };

export type BtwResultEvent = {
  type: "$btw_result";
  question: string;
  answer: string;
  clientId?: string;
};

export type JobInfo = {
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
};

export type JobsEvent = {
  type: "$jobs";
  items: JobInfo[];
};

export type LoadedSegment =
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

export type LoadedMessage =
  | { kind: "user"; text: string }
  | {
      kind: "assistant";
      turn: number;
      segments: LoadedSegment[];
      pending: false;
    };

export type SessionLoadedEvent = {
  type: "$session_loaded";
  name: string;
  /** True when this snapshot is rehydrating a session whose turn is still running. */
  busy?: boolean;
  messages: LoadedMessage[];
  carryover: {
    totalCostUsd: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    totalCompletionTokens: number;
  };
};

export type SessionReconciledEvent = Omit<SessionLoadedEvent, "type"> & {
  type: "$session_reconciled";
};

export type SessionEmptyEvent = {
  type: "$session_empty";
  name: string;
  sizeBytes: number;
};

export type NeedsSetupEvent = {
  type: "$needs_setup";
  reason: "no_api_key";
};

export type EditMode = "review" | "auto" | "yolo" | "plan";

export type ReasoningEffort = "low" | "medium" | "high" | "max";

export type WebSearchEngineName =
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

export type BrowserAutomationStatus =
  | {
      state: "available";
      browser: "chrome" | "edge" | "chromium";
      name: string;
      executablePath: string;
    }
  | { state: "unavailable" };

export type SkillPackSourceInfo = {
  id: string;
  name: string;
  url: string;
  trusted: boolean;
};

export type SettingsEvent = {
  type: "$settings";
  reasoningEffort: ReasoningEffort;
  editMode: EditMode;
  budgetUsd: number | null;
  baseUrl?: string;
  apiKeyPrefix?: string;
  workspaceDir: string;
  recentWorkspaces: string[];
  model: string;
  editor?: string;
  desktopCloseBehavior?: "closeToTray" | "closeToQuit";
  webSearchEngine?: WebSearchEngineName;
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
  contextTokens?: Record<string, number>;
  showSystemEvents?: boolean;
  processCardsDefaultOpen?: boolean;
  memoryConfirmWrites?: boolean;
  memoryGlobalEnabled?: boolean;
  /** Desktop prompt-history entries seeded on tab load, most-recent-first (#2051). */
  promptHistory?: string[];
  version: string;
};

export type QQSettingsEvent = {
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
};

export type FeishuSettingsEvent = {
  type: "$feishu_settings";
  appId?: string;
  appSecret?: string;
  enabled: boolean;
  configured: boolean;
  requireMentionInGroup: boolean;
  runtimeState: "disconnected" | "connecting" | "connected" | "failed";
  lastError?: string;
  appIdPreview?: string;
};

export type BalanceInfoItem = {
  currency: string;
  total: number;
  granted?: number;
  toppedUp?: number;
};

export type BalanceEvent = {
  type: "$balance";
  currency: string;
  total: number;
  isAvailable: boolean;
  balanceInfos: BalanceInfoItem[];
};

export type SettingsPatch = {
  reasoningEffort?: ReasoningEffort;
  editMode?: EditMode;
  budgetUsd?: number | null;
  baseUrl?: string;
  workspaceDir?: string;
  recentWorkspaces?: string[];
  model?: string;
  editor?: string;
  desktopCloseBehavior?: "closeToTray" | "closeToQuit";
  webSearchEngine?: WebSearchEngineName;
  webSearchEndpoint?: string | null;
  metasoApiKey?: string | null;
  baiduApiKey?: string | null;
  tavilyApiKey?: string | null;
  perplexityApiKey?: string | null;
  exaApiKey?: string | null;
  ollamaApiKey?: string | null;
  braveApiKey?: string | null;
  subagentModels?: Record<string, "flash" | "pro">;
  skillPackSources?: SkillPackSourceInfo[];
  /** Per-model context-window override (tokens). Keys are model ids; values are the prompt-side token cap. */
  contextTokens?: Record<string, number>;
  showSystemEvents?: boolean;
  processCardsDefaultOpen?: boolean;
  memoryConfirmWrites?: boolean;
  memoryGlobalEnabled?: boolean;
  /** Persisted prompt-history entries to update on each send (#2051). */
  promptHistory?: string[];
};

export type QQConfigPatch = {
  appId?: string;
  appSecret?: string;
  sandbox: boolean;
};

export type FeishuConfigPatch = {
  appId?: string;
  appSecret?: string;
  requireMentionInGroup?: boolean;
};

export type UserMessageEvent = {
  type: "user.message";
  id: number;
  ts: string;
  turn: number;
  text: string;
  clientId?: string;
};

export type ModelTurnStartedEvent = {
  type: "model.turn.started";
  id: number;
  ts: string;
  turn: number;
  model: string;
  reasoningEffort: ReasoningEffort;
  prefixHash: string;
};

export type ModelDeltaEvent = {
  type: "model.delta";
  id: number;
  ts: string;
  turn: number;
  channel: "content" | "reasoning" | "tool_args";
  text: string;
};

export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

export type ModelFinalEvent = {
  type: "model.final";
  id: number;
  ts: string;
  turn: number;
  content: string;
  reasoningContent?: string;
  usage?: Usage;
  costUsd?: number;
};

export type ToolPreparingEvent = {
  type: "tool.preparing";
  id: number;
  ts: string;
  turn: number;
  callId: string;
  name: string;
};

export type ToolIntentEvent = {
  type: "tool.intent";
  id: number;
  ts: string;
  turn: number;
  callId: string;
  name: string;
  args: string;
};

export type ToolResultEvent = {
  type: "tool.result";
  id: number;
  ts: string;
  turn: number;
  callId: string;
  ok: boolean;
  output: string;
};

export type StatusEvent = {
  type: "status";
  id: number;
  ts: string;
  turn: number;
  text: string;
};

export type CompactResultEvent =
  | {
      type: "$compact_result";
      folded: true;
      beforeMessages: number;
      afterMessages: number;
      summaryChars: number;
      reason?: string;
      totalTokens?: number;
      headTokens?: number;
      tailTokens?: number;
      tailBudget?: number;
    }
  | {
      type: "$compact_result";
      folded: false;
      beforeMessages: number;
      afterMessages: number;
      summaryChars: number;
      reason?: string;
      totalTokens?: number;
      headTokens?: number;
      tailTokens?: number;
      tailBudget?: number;
    };

export type WarningEvent = {
  type: "warning";
  id: number;
  ts: string;
  turn: number;
  text: string;
  severity: "low" | "high";
};

export type KernelErrorEvent = {
  type: "error";
  id: number;
  ts: string;
  turn: number;
  message: string;
  recoverable: boolean;
};

export type IncomingEvent = { tabId?: string } & (
  | ReadyEvent
  | ProtocolErrorEvent
  | TurnCompleteEvent
  | ConfirmRequiredEvent
  | PathAccessRequiredEvent
  | ChoiceRequiredEvent
  | PlanRequiredEvent
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
  | CheckpointRequiredEvent
  | RevisionRequiredEvent
  | StepCompletedEvent
  | PlanClearedEvent
  | MentionResultsEvent
  | MentionPreviewEvent
  | SourceSearchResultsEvent
  | SourceIngestResultEvent
  | LibrarySourcesEvent
  | TabOpenedEvent
  | TabClosedEvent
  | McpSpecsEvent
  | SubagentEvent
  | SkillsEvent
  | CtxBreakdownEvent
  | MemoryEvent
  | MemoryDetailEvent
  | JobsEvent
  | UserMessageEvent
  | ModelTurnStartedEvent
  | ModelDeltaEvent
  | ModelFinalEvent
  | ToolPreparingEvent
  | ToolIntentEvent
  | ToolResultEvent
  | CompactResultEvent
  | StatusEvent
  | WarningEvent
  | KernelErrorEvent
  | RetryResultEvent
  | BtwResultEvent
);

export type OutgoingCommand = { tabId?: string } & (
  | { cmd: "user_input"; text: string; clientId?: string; planOneShot?: boolean }
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
  | { cmd: "session_import_bulk"; sources?: ExternalSessionSource[]; items?: ExternalSessionSelection[] }
  | { cmd: "memory_read"; path: string }
  | { cmd: "memory_refresh" }
  | { cmd: "memory_delete"; path: string }
  | ({ cmd: "memory_save" } & MemoryWriteInput)
  | { cmd: "new_chat"; workspaceDir?: string; openInNewTab?: boolean }
  | { cmd: "setup_save_key"; key: string }
  | { cmd: "settings_sign_out" }
  | { cmd: "settings_get" }
  | ({ cmd: "settings_save" } & SettingsPatch)
  | { cmd: "qq_status_get" }
  | { cmd: "qq_connect" }
  | { cmd: "qq_disconnect" }
  | ({ cmd: "qq_config_save" } & QQConfigPatch)
  | { cmd: "feishu_status_get" }
  | { cmd: "feishu_connect" }
  | { cmd: "feishu_disconnect" }
  | ({ cmd: "feishu_config_save" } & FeishuConfigPatch)
  | { cmd: "mention_query"; query: string; nonce: number }
  | { cmd: "mention_preview"; path: string; nonce: number }
  | { cmd: "mention_picked"; path: string }
  | { cmd: "source_search"; query: string; nonce: number; topK?: number }
  | { cmd: "source_ingest"; url: string; nonce: number; title?: string }
  | { cmd: "library_list" }
  | { cmd: "library_add"; source: Omit<LibrarySource, "id" | "addedAt" | "updatedAt"> }
  | { cmd: "library_remove"; id: string }
  | { cmd: "library_refresh"; id: string }
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
);
