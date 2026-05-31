/** User-typed `!cmd` skips the allowlist — that gate is for the MODEL, not the user. */

export function detectBangCommand(text: string): string | null {
  if (!text.startsWith("!")) return null;
  const body = text.slice(1).trim();
  if (!body) return null;
  return body;
}

export function formatBangUserMessage(cmd: string, output: string): string {
  return `[!${cmd}]\n${output}`;
}
