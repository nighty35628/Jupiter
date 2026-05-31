/** Display-only — the MODEL always receives full paste text. */

export const DEFAULT_PASTE_LINE_THRESHOLD = 40;
export const DEFAULT_PASTE_CHAR_THRESHOLD = 2000;
/** Lines kept visible at the head of a collapsed paste. */
export const DEFAULT_PASTE_HEAD_LINES = 10;

export interface PasteCollapseOptions {
  lineThreshold?: number;
  charThreshold?: number;
  headLines?: number;
}

export interface PasteCollapseResult {
  /** Text to render in the Historical row (possibly collapsed). */
  displayText: string;
  /** True when collapsing happened. False = input passed through verbatim. */
  collapsed: boolean;
  /** Original char length — exposed so callers can log/annotate. */
  originalChars: number;
  /** Original line count. */
  originalLines: number;
}

export function formatLongPaste(
  input: string,
  opts: PasteCollapseOptions = {},
): PasteCollapseResult {
  const lineCap = opts.lineThreshold ?? DEFAULT_PASTE_LINE_THRESHOLD;
  const charCap = opts.charThreshold ?? DEFAULT_PASTE_CHAR_THRESHOLD;
  const headN = Math.max(1, opts.headLines ?? DEFAULT_PASTE_HEAD_LINES);

  const originalChars = input.length;
  const lines = input.split("\n");
  const originalLines = lines.length;

  if (originalChars <= charCap && originalLines <= lineCap) {
    return { displayText: input, collapsed: false, originalChars, originalLines };
  }

  const header = `▸ pasted ${formatBytes(originalChars)} (${originalLines} lines) — first ${Math.min(headN, originalLines)} shown, full text sent to model`;
  const head = lines.slice(0, headN).join("\n");
  const remaining = originalLines - headN;
  const footer = remaining > 0 ? `… (${remaining} more line${remaining === 1 ? "" : "s"})` : "";
  const displayText = footer ? `${header}\n${head}\n${footer}` : `${header}\n${head}`;
  return { displayText, collapsed: true, originalChars, originalLines };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}
