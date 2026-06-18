import { SLASH_COMMANDS, type SlashCommandSpec } from "../../src/cli/ui/slash/registry.js";

export type DesktopCliSlashCommand = Pick<
  SlashCommandSpec,
  "cmd" | "summary" | "argsHint" | "aliases"
>;

export const DESKTOP_CLI_SLASH_COMMANDS: readonly DesktopCliSlashCommand[] = SLASH_COMMANDS.map(
  ({ cmd, summary, argsHint, aliases }) => ({
    cmd,
    summary,
    ...(argsHint ? { argsHint } : {}),
    ...(aliases ? { aliases } : {}),
  }),
);

const ALIASES: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const spec of DESKTOP_CLI_SLASH_COMMANDS) {
    for (const alias of spec.aliases ?? []) out[alias] = spec.cmd;
  }
  return out;
})();

export function parseDesktopSlash(text: string): { cmd: string; args: string[] } | null {
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
