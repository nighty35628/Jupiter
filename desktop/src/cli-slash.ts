export type DesktopCliSlashCommand = {
  cmd: string;
  summary: string;
  argsHint?: string;
  aliases?: readonly string[];
};

export const DESKTOP_CLI_SLASH_COMMANDS: readonly DesktopCliSlashCommand[] = [
  { cmd: "help", summary: "show the full command reference", aliases: ["?"] },
  {
    cmd: "new",
    summary: "start a fresh conversation (clear context + scrollback)",
    aliases: ["reset", "clear"],
  },
  { cmd: "retry", summary: "truncate & resend your last message (fresh sample)" },
  {
    cmd: "compact",
    summary: "fold older turns into a summary message (cache-safe)",
  },
  { cmd: "stop", summary: "abort the current model turn" },
  {
    cmd: "btw",
    argsHint: "<question>",
    summary: "ask a quick side question from a blank slate",
  },
  {
    cmd: "model",
    argsHint: "<id>",
    summary: "switch model id. Bare opens picker.",
  },
  {
    cmd: "effort",
    argsHint: "<low|medium|high|max>",
    summary: "reasoning_effort cap",
  },
  {
    cmd: "language",
    argsHint: "<EN|zh-CN|de|ru>",
    summary: "switch the runtime language",
    aliases: ["lang"],
  },
  {
    cmd: "theme",
    argsHint: "[auto|dark|light|midnight|deep-blue|high-contrast]",
    summary: "show or persist the theme preference",
  },
  { cmd: "status", summary: "current model, flags, context, session" },
  {
    cmd: "cost",
    argsHint: "[text]",
    summary: "show last turn spend or estimate next message cost",
  },
  { cmd: "context", summary: "show context-window breakdown" },
  { cmd: "stats", summary: "cross-session cost dashboard" },
  { cmd: "doctor", summary: "health check" },
  { cmd: "keys", summary: "keyboard + mouse + copy/paste reference" },
  { cmd: "feedback", summary: "open a GitHub issue with diagnostic info" },
  { cmd: "about", summary: "project info — version, website, repo, license" },
  { cmd: "sessions", summary: "list saved sessions" },
  {
    cmd: "title",
    summary: "ask the model to rename this session",
    aliases: ["retitle"],
  },
  { cmd: "mcp", summary: "list MCP servers + tools attached to this session" },
  {
    cmd: "resource",
    argsHint: "[uri]",
    summary: "browse + read MCP resources",
  },
  {
    cmd: "prompt",
    argsHint: "[name]",
    summary: "browse + fetch MCP prompts",
  },
  {
    cmd: "memory",
    argsHint: "[list|show <name>|forget <name>|clear <scope> confirm]",
    summary: "show / manage pinned memory",
  },
  {
    cmd: "skill",
    argsHint:
      "[list|paths|paths add <path>|paths remove <path|N>|show <name>|new <name>|<name> [args]]",
    summary: "list / run / scaffold skills",
  },
  {
    cmd: "qq",
    argsHint: "<connect|status|disconnect>",
    summary: "connect, inspect, or disconnect the QQ channel",
  },
  {
    cmd: "feishu",
    argsHint: "<connect|status|disconnect>",
    summary: "connect, inspect, or disconnect the Feishu channel",
  },
  {
    cmd: "telegram",
    argsHint: "<connect|status|disconnect>",
    summary: "connect, inspect, or disconnect the Telegram channel",
    aliases: ["tg"],
  },
  {
    cmd: "init",
    argsHint: "[force]",
    summary: "scan the project and synthesize a baseline JUPITER.md",
  },
  {
    cmd: "apply",
    argsHint: "[N|N,M|N-M]",
    summary: "commit pending edit blocks to disk",
  },
  {
    cmd: "discard",
    argsHint: "[N|N,M|N-M]",
    summary: "drop pending edit blocks without writing",
  },
  { cmd: "walk", summary: "step through pending edits one block at a time" },
  { cmd: "undo", summary: "roll back the last applied edit batch" },
  { cmd: "rewind", summary: "roll back the last applied edit batch" },
  { cmd: "history", summary: "list every edit batch this session" },
  {
    cmd: "show",
    argsHint: "[id]",
    summary: "dump a stored edit diff",
  },
  {
    cmd: "commit",
    argsHint: '"msg"',
    summary: "git add -A && git commit -m ...",
  },
  {
    cmd: "mode",
    argsHint: "[ask|auto|full]",
    summary: "permission mode",
  },
  {
    cmd: "diff",
    argsHint: "[summary|full|none]",
    summary: "diff display mode",
  },
  {
    cmd: "plan",
    argsHint: "[task|off]",
    summary: "one-shot planning: propose a plan before executing a task",
  },
  {
    cmd: "checkpoint",
    argsHint: "[name|list|forget <id>]",
    summary: "snapshot every touched file",
  },
  {
    cmd: "restore",
    argsHint: "<name|id>",
    summary: "roll back files to a named checkpoint",
  },
  {
    cmd: "cwd",
    argsHint: "[path]",
    summary: "switch the workspace root mid-session",
    aliases: ["sandbox"],
  },
  { cmd: "jobs", summary: "list background jobs" },
  {
    cmd: "kill",
    argsHint: "<id>",
    summary: "stop a background job",
  },
  {
    cmd: "logs",
    argsHint: "<id> [lines]",
    summary: "tail a background job's output",
  },
  {
    cmd: "budget",
    argsHint: "[usd|off]",
    summary: "session USD cap",
  },
  {
    cmd: "search-engine",
    argsHint:
      "<bing|bing-intl|searxng|metaso|baidu|tavily|perplexity|exa|brave|ollama> [<key>]",
    summary: "switch web search backend",
    aliases: ["se"],
  },
  {
    cmd: "hooks",
    argsHint: "[reload]",
    summary: "list active hooks",
  },
  {
    cmd: "permissions",
    argsHint: "[list|add <prefix>|remove <prefix|N>|clear confirm]",
    summary: "show / edit shell allowlist",
  },
  {
    cmd: "dashboard",
    argsHint: "[stop]",
    summary: "launch the embedded web dashboard",
  },
  {
    cmd: "loop",
    argsHint: "<5s..6h> <prompt> · stop",
    summary: "auto-resubmit a prompt on an interval",
  },
  { cmd: "plans", summary: "list active + archived plans" },
  {
    cmd: "replay",
    argsHint: "[N]",
    summary: "load an archived plan as a read-only snapshot",
  },
  { cmd: "update", summary: "show current vs latest version" },
  { cmd: "exit", summary: "quit the app", aliases: ["quit", "q"] },
];

const ALIASES: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const spec of DESKTOP_CLI_SLASH_COMMANDS) {
    for (const alias of spec.aliases ?? []) out[alias] = spec.cmd;
  }
  return out;
})();

export function parseDesktopSlash(
  text: string,
): { cmd: string; args: string[] } | null {
  const trimmed = text.trim();
  const bareShortcut = /^(undo|rewind)(?:\s+(.+))?$/i.exec(trimmed);
  const slashText = bareShortcut
    ? `/${trimmed}`
    : trimmed.startsWith("/") && !trimmed.startsWith("//")
      ? trimmed
      : "";
  if (!slashText) return null;
  const parts = slashText.slice(1).trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? "";
  if (!cmd) return null;
  return { cmd, args: parts.slice(1) };
}

export function resolveDesktopSlashAlias(cmd: string): string {
  return ALIASES[cmd] ?? cmd;
}

export function isKnownDesktopCliSlash(cmd: string): boolean {
  const canonical = resolveDesktopSlashAlias(cmd);
  return DESKTOP_CLI_SLASH_COMMANDS.some((spec) => spec.cmd === canonical);
}
