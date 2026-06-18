import {
  SLASH_COMMANDS,
  SLASH_GROUP_ORDER,
  type SlashCommandSpec,
  type SlashGroup,
} from "./registry.js";
import type { SlashArgContext } from "./types.js";

export { SLASH_COMMANDS, SLASH_GROUP_LABEL, SLASH_GROUP_ORDER } from "./registry.js";

const SLASH_GROUP_RANK = new Map<SlashGroup, number>(
  SLASH_GROUP_ORDER.map((group, index) => [group, index]),
);

export function orderSlashCommandsByGroup<T extends Pick<SlashCommandSpec, "group">>(
  commands: readonly T[],
): T[] {
  return commands
    .map((command, index) => ({ command, index }))
    .sort((a, b) => {
      const groupDiff =
        SLASH_GROUP_RANK.get(a.command.group)! - SLASH_GROUP_RANK.get(b.command.group)!;
      if (groupDiff !== 0) return groupDiff;
      return a.index - b.index;
    })
    .map((entry) => entry.command);
}

export function suggestSlashCommands(
  prefix: string,
  codeMode = false,
  counts?: Readonly<Record<string, number>>,
): SlashCommandSpec[] {
  const p = prefix.toLowerCase();
  const matches = SLASH_COMMANDS.filter((c) => {
    // Empty prefix = browsing the menu — show the full release command surface except
    // advanced rows, which remain collapsed behind the footer hint.
    if (p === "") return c.group !== "advanced";
    if (c.contextual === "code" && !codeMode) return false;
    if (c.cmd.startsWith(p)) return true;
    return c.aliases?.some((a) => a.startsWith(p)) ?? false;
  });
  if (p === "") return orderSlashCommandsByGroup(matches);
  if (!counts) return matches;
  const indexOf = new Map(matches.map((s, i) => [s.cmd, i]));
  return [...matches].sort((a, b) => {
    const diff = (counts[b.cmd] ?? 0) - (counts[a.cmd] ?? 0);
    if (diff !== 0) return diff;
    return (indexOf.get(a.cmd) ?? 0) - (indexOf.get(b.cmd) ?? 0);
  });
}

export function countAdvancedCommands(codeMode: boolean): number {
  return SLASH_COMMANDS.filter(
    (c) => c.group === "advanced" && (c.contextual !== "code" || codeMode),
  ).length;
}

/** alias → canonical cmd map, derived from SLASH_COMMANDS at module init. */
const ALIAS_TO_CMD: Readonly<Record<string, string>> = (() => {
  const m: Record<string, string> = {};
  for (const spec of SLASH_COMMANDS) {
    if (!spec.aliases) continue;
    for (const a of spec.aliases) m[a] = spec.cmd;
  }
  return m;
})();

export function resolveSlashAlias(name: string): string {
  return ALIAS_TO_CMD[name] ?? name;
}

/** Picker fires only when arg tail has no internal whitespace; past that it's a usage hint. */
export function detectSlashArgContext(input: string, codeMode = false): SlashArgContext | null {
  const m = /^\/(\S+) ([\s\S]*)$/.exec(input);
  if (!m) return null;
  const cmdName = resolveSlashAlias(m[1]!.toLowerCase());
  const tail = m[2] ?? "";
  const spec = SLASH_COMMANDS.find(
    (s) => s.cmd === cmdName && (s.contextual !== "code" || codeMode),
  );
  if (!spec) return null;
  const hasInternalSpace = /\s/.test(tail);
  const partialOffset = input.length - tail.length;
  if (hasInternalSpace) {
    return { spec, partial: tail, partialOffset, kind: "hint" };
  }
  return {
    spec,
    partial: tail,
    partialOffset,
    kind: spec.argCompleter ? "picker" : "hint",
  };
}

export function parseSlash(text: string): { cmd: string; args: string[] } | null {
  if (!text.startsWith("/")) return null;
  // "//" is a line comment, not a slash command
  if (text.startsWith("//")) return null;
  const parts = text.slice(1).trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? "";
  if (!cmd) return null;
  return { cmd, args: parts.slice(1) };
}
