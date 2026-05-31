/** PUA range U+E100..U+E1FF (BMP, no surrogate pairs) so each sentinel is one codepoint and cursor arithmetic stays trivial. */

export const PASTE_SENTINEL_BASE = 0xe100;
export const PASTE_SENTINEL_RANGE = 256;
export const PASTE_SENTINEL_END = PASTE_SENTINEL_BASE + PASTE_SENTINEL_RANGE;

export interface PasteEntry {
  id: number;
  content: string;
  lineCount: number;
  charCount: number;
}

export function encodePasteSentinel(id: number): string {
  if (id < 0 || id >= PASTE_SENTINEL_RANGE) {
    throw new Error(`paste sentinel id ${id} out of range [0, ${PASTE_SENTINEL_RANGE})`);
  }
  return String.fromCharCode(PASTE_SENTINEL_BASE + id);
}

/** Returns the paste id, or `null` if `ch` is not a sentinel codepoint. */
export function decodePasteSentinel(ch: string): number | null {
  if (ch.length === 0) return null;
  const cp = ch.charCodeAt(0);
  if (cp < PASTE_SENTINEL_BASE || cp >= PASTE_SENTINEL_END) return null;
  return cp - PASTE_SENTINEL_BASE;
}

export function isPasteSentinel(ch: string): boolean {
  return decodePasteSentinel(ch) !== null;
}

export function makePasteEntry(id: number, content: string): PasteEntry {
  return {
    id,
    content,
    lineCount: content.split("\n").length,
    charCount: content.length,
  };
}

/** Unknown sentinels drop to empty — never leak a PUA codepoint into the prompt. */
export function expandPasteSentinels(
  text: string,
  pastes: ReadonlyMap<number, PasteEntry>,
): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const id = decodePasteSentinel(ch);
    if (id === null) {
      out += ch;
      continue;
    }
    const entry = pastes.get(id);
    out += entry?.content ?? "";
  }
  return out;
}

export function bufferHasPaste(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (decodePasteSentinel(text[i]!) !== null) return true;
  }
  return false;
}

export function listPasteIdsInBuffer(text: string): number[] {
  const ids: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const id = decodePasteSentinel(text[i]!);
    if (id !== null) ids.push(id);
  }
  return ids;
}

export function formatBytesShort(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 1024 * 10 ? 1 : 0)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
