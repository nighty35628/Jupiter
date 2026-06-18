export type SlashGroup =
  | "chat"
  | "setup"
  | "info"
  | "session"
  | "extend"
  | "code"
  | "jobs"
  | "advanced";

export type SlashArgCompleter =
  | "models"
  | "mcp-resources"
  | "mcp-prompts"
  | "skills"
  | "path"
  | readonly string[];

export interface SlashCommandSpec {
  cmd: string;
  summary: string;
  contextual?: "code";
  /** Visual category in the suggestions palette + /help. `advanced` collapses by default. */
  group: SlashGroup;
  /** If the command takes args, hint text shown after the name. */
  argsHint?: string;
  /** First-arg picker source. `"path"` async-lists the filesystem for directory completion (used by `/cwd`). */
  argCompleter?: SlashArgCompleter;
  /** Alternate names — typing any of these resolves to `cmd` for dispatch / suggestion / arg-context. */
  aliases?: readonly string[];
}

export const SLASH_GROUP_ORDER = [
  "setup",
  "info",
  "chat",
  "extend",
  "session",
  "code",
  "jobs",
  "advanced",
] as const satisfies readonly SlashGroup[];

export const SLASH_GROUP_LABEL: Record<SlashGroup, string> = {
  setup: "SETUP",
  info: "INFO",
  chat: "CHAT",
  extend: "EXTEND",
  session: "SESSION",
  code: "CODE",
  jobs: "JOBS",
  advanced: "ADVANCED",
};

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { cmd: "help", group: "chat", summary: "show the full command reference", aliases: ["?"] },
  {
    cmd: "new",
    group: "chat",
    summary: "start a fresh conversation (clear context + scrollback)",
    aliases: ["reset", "clear"],
  },
  { cmd: "retry", group: "chat", summary: "truncate & resend your last message (fresh sample)" },
  {
    cmd: "compact",
    group: "chat",
    summary:
      "fold older turns into a summary message (cache-safe). Auto-fires at 50% ctx; this is the manual trigger.",
  },
  {
    cmd: "stop",
    group: "chat",
    summary: "abort the current model turn (typed alternative to Esc)",
  },
  {
    cmd: "btw",
    group: "chat",
    argsHint: "<question>",
    summary:
      "ask a quick side question — answered from a blank slate, never added to the conversation context",
  },
  {
    cmd: "ask",
    group: "chat",
    argsHint: "<question>",
    summary: "ask a quick no-tool question and save the exchange in the current session",
  },

  {
    cmd: "model",
    group: "setup",
    argsHint: "<id>",
    summary: "switch DeepSeek model id. Bare opens picker.",
    argCompleter: "models",
  },
  {
    cmd: "effort",
    group: "setup",
    argsHint: "<low|medium|high|max>",
    summary:
      "reasoning_effort cap — high is the safe default (vLLM/Azure compatible); max is a DeepSeek extension.",
    argCompleter: ["low", "medium", "high", "max"],
  },
  {
    cmd: "language",
    group: "setup",
    argsHint: "<EN|zh-CN|de|ru>",
    summary: "switch the runtime language",
    argCompleter: ["EN", "zh-CN", "de", "ru"],
    aliases: ["lang"],
  },
  {
    cmd: "theme",
    group: "setup",
    argsHint: "[auto|dark|light|midnight|deep-blue|high-contrast]",
    summary: "show or persist the terminal theme preference. Bare opens picker.",
    argCompleter: ["auto", "dark", "light", "midnight", "deep-blue", "high-contrast"],
  },

  {
    cmd: "status",
    group: "info",
    argsHint: "[detail]",
    summary: "current model, flags, context, session; detail adds cache diagnostics",
    argCompleter: ["detail"],
  },
  {
    cmd: "cost",
    group: "info",
    argsHint: "[text]",
    summary:
      "bare → last turn's spend (Usage card); with text → estimate cost of sending it next (worst-case + likely-cache)",
  },
  {
    cmd: "context",
    group: "info",
    summary: "show context-window breakdown (system / tools / log / input)",
  },
  {
    cmd: "stats",
    group: "info",
    argsHint: "[history]",
    summary:
      "cross-session cost dashboard (today / week / month / all-time · cache hit · vs Claude)",
  },
  {
    cmd: "doctor",
    group: "info",
    summary: "health check (api / config / api-reach / index / hooks / project)",
  },
  {
    cmd: "keys",
    group: "info",
    summary: "keyboard + mouse + copy/paste reference",
  },
  {
    cmd: "feedback",
    group: "info",
    summary: "open a GitHub issue with diagnostic info copied to clipboard",
  },
  {
    cmd: "about",
    group: "info",
    summary: "project info — version, website, repo, license",
  },

  { cmd: "sessions", group: "session", summary: "list saved sessions (current marked with ▸)" },
  {
    cmd: "title",
    group: "session",
    summary: "ask the model to rename this session from the conversation",
    aliases: ["retitle"],
  },

  { cmd: "mcp", group: "extend", summary: "list MCP servers + tools attached to this session" },
  {
    cmd: "resource",
    group: "extend",
    argsHint: "[uri]",
    summary: "browse + read MCP resources (no arg → list URIs; <uri> → fetch contents)",
    argCompleter: "mcp-resources",
  },
  {
    cmd: "prompt",
    group: "extend",
    argsHint: "[name]",
    summary: "browse + fetch MCP prompts (no arg → list names; <name> → render prompt)",
    argCompleter: "mcp-prompts",
  },
  {
    cmd: "memory",
    group: "extend",
    argsHint: "[list|show <name>|forget <name>|clear <scope> confirm]",
    summary: "show / manage pinned memory (JUPITER.md + ~/.jupiter/memory)",
  },
  {
    cmd: "skill",
    group: "extend",
    argsHint:
      "[list|update [--check]|paths|paths add <path>|paths remove <path|N>|show <name>|new <name>|<name> [args]]",
    summary: "list / run / scaffold skills (project + custom + global + builtin)",
    argCompleter: "skills",
  },
  { cmd: "workflows", group: "extend", summary: "list built-in workflow templates" },
  {
    cmd: "workflow",
    group: "extend",
    argsHint: "<start|status|open|cancel|export|save-library> [id]",
    summary: "start, inspect, or cancel built-in workflow runs",
    argCompleter: ["start", "status", "open", "cancel", "export", "save-library"],
  },
  {
    cmd: "qq",
    group: "extend",
    argsHint: "<connect|status|disconnect>",
    summary: "connect, inspect, or disconnect the QQ channel",
    argCompleter: ["connect", "status", "disconnect"],
  },
  {
    cmd: "feishu",
    group: "extend",
    argsHint: "<connect|status|disconnect>",
    summary: "connect, inspect, or disconnect the Feishu channel",
    argCompleter: ["connect", "status", "disconnect"],
  },
  {
    cmd: "dingtalk",
    group: "extend",
    argsHint: "<connect|status|disconnect>",
    summary: "connect, inspect, or disconnect the DingTalk channel",
    argCompleter: ["connect", "status", "disconnect"],
    aliases: ["ding"],
  },
  {
    cmd: "telegram",
    group: "extend",
    argsHint: "<connect|status|disconnect>",
    summary: "connect, inspect, or disconnect the Telegram channel",
    argCompleter: ["connect", "status", "disconnect"],
    aliases: ["tg"],
  },

  {
    cmd: "init",
    group: "code",
    argsHint: "[force]",
    summary:
      "scan the project and synthesize a baseline JUPITER.md (model writes; review with /apply). `force` overwrites an existing file.",
    contextual: "code",
    argCompleter: ["force"],
  },
  {
    cmd: "apply",
    group: "code",
    argsHint: "[N|N,M|N-M]",
    summary:
      "commit pending edit blocks to disk (no arg → all; `1`, `1,3`, or `1-4` → that subset, rest stay pending)",
    contextual: "code",
  },
  {
    cmd: "discard",
    group: "code",
    argsHint: "[N|N,M|N-M]",
    summary: "drop pending edit blocks without writing (no arg → all; indices → that subset)",
    contextual: "code",
  },
  {
    cmd: "walk",
    group: "code",
    summary:
      "step through pending edits one block at a time (git-add-p style: y/n per block, a apply rest, A flip AUTO)",
    contextual: "code",
  },
  {
    cmd: "undo",
    group: "code",
    summary: "roll back the last applied edit batch",
    contextual: "code",
  },
  {
    cmd: "rewind",
    group: "code",
    summary: "roll back the last applied edit batch",
    contextual: "code",
  },
  {
    cmd: "history",
    group: "code",
    summary: "list every edit batch this session (ids for /show, undone markers)",
    contextual: "code",
  },
  {
    cmd: "show",
    group: "code",
    argsHint: "[id]",
    summary: "dump a stored edit diff (omit id for newest non-undone)",
    contextual: "code",
  },
  {
    cmd: "commit",
    group: "code",
    argsHint: '"msg"',
    summary: "git add -A && git commit -m ...",
    contextual: "code",
  },
  {
    cmd: "mode",
    group: "code",
    argsHint: "[review|auto|yolo]",
    summary:
      "edit-gate: review (queue) · auto (apply+undo) · yolo (apply+auto-shell). Shift+Tab cycles.",
    contextual: "code",
    argCompleter: ["review", "auto", "yolo"],
  },
  {
    cmd: "diff",
    group: "code",
    argsHint: "[summary|full|none]",
    summary:
      "diff display mode: summary (path +stats, default) · full (unified diff) · none (checkmark only)",
    contextual: "code",
    argCompleter: ["summary", "full", "none"],
  },
  {
    cmd: "plan",
    group: "code",
    argsHint: "[on|off|strict]",
    summary: "legacy CLI read-only plan rails; desktop /plan is one-shot planning",
    contextual: "code",
    argCompleter: ["on", "off", "strict"],
  },
  {
    cmd: "checkpoint",
    group: "code",
    argsHint: "[name|list|forget <id>]",
    summary:
      "snapshot every file the session has touched (Cursor-style internal store, not git). /checkpoint alone lists.",
    contextual: "code",
    argCompleter: ["list", "forget"],
  },
  {
    cmd: "restore",
    group: "code",
    argsHint: "<name|id>",
    summary: "roll back files to a named checkpoint (see /checkpoint list)",
    contextual: "code",
  },
  {
    cmd: "cwd",
    group: "code",
    argsHint: "[path]",
    summary:
      "switch the workspace root mid-session — re-points fs / shell / memory tools, reloads project hooks, refreshes the at-mention walker",
    contextual: "code",
    aliases: ["sandbox"],
    argCompleter: "path",
  },

  {
    cmd: "jobs",
    group: "jobs",
    summary: "list background jobs started by run_background",
    contextual: "code",
  },
  {
    cmd: "kill",
    group: "jobs",
    argsHint: "<id>",
    summary: "stop a background job by id (SIGTERM → SIGKILL after grace)",
    contextual: "code",
  },
  {
    cmd: "logs",
    group: "jobs",
    argsHint: "<id> [lines]",
    summary: "tail a background job's output (default last 80 lines)",
    contextual: "code",
  },

  {
    cmd: "budget",
    group: "advanced",
    argsHint: "[usd|off]",
    summary:
      "session USD cap — warns at 80%, refuses next turn at 100%. Off by default. /budget alone shows status",
    argCompleter: ["off", "1", "5", "10", "20", "50"],
  },
  {
    cmd: "search-engine",
    group: "advanced",
    argsHint: "<bing|bing-intl|searxng|metaso|baidu|tavily|perplexity|exa|brave|ollama> [<key>]",
    summary:
      "switch web search backend — bing (default, works from CN without proxy), bing-intl (international index via www.bing.com), searxng (self-hosted), metaso (free 100/d), baidu (Baidu AI Search, free 1500/mo per Baidu docs), tavily (free 1000/mo), perplexity (AI-native), exa (AI-native), brave (independent index, free 2000/mo), or ollama (Ollama cloud web search). Provider with no key prompts inline config.",
    argCompleter: [
      "bing",
      "bing-intl",
      "searxng",
      "metaso",
      "baidu",
      "tavily",
      "perplexity",
      "exa",
      "brave",
      "ollama",
    ],
    aliases: ["se"],
  },
  {
    cmd: "hooks",
    group: "advanced",
    argsHint: "[reload]",
    summary: "list active hooks (settings.json under .jupiter/) · reload re-reads from disk",
  },
  {
    cmd: "permissions",
    group: "advanced",
    argsHint: "[list|add <prefix>|remove <prefix|N>|clear confirm]",
    summary:
      "show / edit shell allowlist (builtin read-only · per-project: ~/.jupiter/config.json)",
    argCompleter: ["list", "add", "remove", "clear"],
  },
  {
    cmd: "dashboard",
    group: "advanced",
    argsHint: "[stop]",
    summary: "launch the embedded web dashboard (127.0.0.1, token-gated)",
    argCompleter: ["stop"],
  },
  {
    cmd: "loop",
    group: "advanced",
    argsHint: "<5s..6h> <prompt>  ·  stop  ·  (no args = status)",
    summary: "auto-resubmit <prompt> every <interval> until you type something / Esc / /loop stop",
  },
  {
    cmd: "plans",
    group: "advanced",
    summary: "list this session's active + archived plans, newest first",
  },
  {
    cmd: "replay",
    group: "advanced",
    summary: "load an archived plan as a read-only Time Travel snapshot (default: newest)",
    argsHint: "[N]",
  },
  {
    cmd: "update",
    group: "advanced",
    summary: "show current vs latest version + the shell command to upgrade",
  },
  { cmd: "exit", group: "advanced", summary: "quit the TUI", aliases: ["quit", "q"] },
];
