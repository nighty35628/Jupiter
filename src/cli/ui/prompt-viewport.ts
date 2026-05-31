/** Slice each prompt line to a single visual row — Ink/Yoga wrap miscounts on CJK Windows terminals and leaks ghost rows. */

import { type PasteEntry, decodePasteSentinel, formatBytesShort } from "./paste-sentinels.js";

export type Segment = { kind: "text"; text: string } | { kind: "paste"; id: number; label: string };

export interface Viewport {
  /** Segments to render left-to-right. Sum of cells <= visibleCells. */
  segments: Segment[];
  /** `null` when cursor is not on this line. */
  cursorCell: number | null;
  /** True when content was clipped on the left side. */
  hiddenLeft: boolean;
  /** True when content was clipped on the right side. */
  hiddenRight: boolean;
}

/** Treats Ambiguous=1 to match Ink/Yoga's own miscount — agreement matters more than correctness here. */
export function charCells(ch: string): number {
  if (ch.length === 0) return 0;
  const code = ch.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return 0;
  if (code < 0x1100) return 1;
  // Hangul Jamo
  if (code >= 0x1100 && code <= 0x115f) return 2;
  // CJK Radicals, Kangxi Radicals, Ideographic Description, CJK Symbols
  if (code >= 0x2e80 && code <= 0x303e) return 2;
  // Hiragana, Katakana, Bopomofo, Hangul Compat Jamo, Kanbun
  if (code >= 0x3041 && code <= 0x33ff) return 2;
  // CJK Unified Ext A
  if (code >= 0x3400 && code <= 0x4dbf) return 2;
  // CJK Unified Ideographs
  if (code >= 0x4e00 && code <= 0x9fff) return 2;
  // Yi Syllables
  if (code >= 0xa000 && code <= 0xa4cf) return 2;
  // Hangul Syllables
  if (code >= 0xac00 && code <= 0xd7a3) return 2;
  // CJK Compatibility Ideographs
  if (code >= 0xf900 && code <= 0xfaff) return 2;
  // CJK Compatibility Forms
  if (code >= 0xfe30 && code <= 0xfe4f) return 2;
  // Halfwidth and Fullwidth Forms (fullwidth half is wide)
  if (code >= 0xff00 && code <= 0xff60) return 2;
  // Fullwidth signs
  if (code >= 0xffe0 && code <= 0xffe6) return 2;
  return 1;
}

/** Total cells of a string, with paste sentinels expanded to placeholder width. */
export function stringCells(s: string, pastes?: ReadonlyMap<number, PasteEntry>): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const id = decodePasteSentinel(ch);
    if (id !== null) {
      n += pasteSentinelCells(id, pastes);
    } else {
      n += charCells(ch);
    }
  }
  return n;
}

/** Compact placeholder for cell-width arithmetic; the visible chip lives in PasteChipRow. */
export function pasteSentinelLabel(id: number, entry: PasteEntry | undefined): string {
  if (!entry) return `[paste #${id + 1} · (missing)]`;
  return `[paste #${id + 1} · ${entry.lineCount}l · ${formatBytesShort(entry.charCount)}]`;
}

function pasteSentinelCells(id: number, pastes?: ReadonlyMap<number, PasteEntry>): number {
  const entry = pastes?.get(id);
  return pasteSentinelLabel(id, entry).length;
}

export function buildViewport(
  line: string,
  cursorCol: number | null,
  visibleCells: number,
  pastes?: ReadonlyMap<number, PasteEntry>,
): Viewport {
  if (visibleCells <= 0) {
    return {
      segments: [],
      cursorCell: cursorCol === null ? null : 0,
      hiddenLeft: false,
      hiddenRight: line.length > 0,
    };
  }
  const totalCells = stringCells(line, pastes);

  // Fast path: whole line fits.
  if (totalCells <= visibleCells) {
    const segments = textToSegments(line, pastes);
    let cursorCell: number | null = null;
    if (cursorCol !== null) {
      cursorCell = stringCells(line.slice(0, cursorCol), pastes);
    }
    return { segments, cursorCell, hiddenLeft: false, hiddenRight: false };
  }

  // Static viewport (cursor not on this line) — clip from the right.
  if (cursorCol === null) {
    return clipFromLeft(line, visibleCells, pastes);
  }

  // Cursor-bearing line: slide a window so cursor stays visible.
  // Reserve 1 cell on each potentially-clipped side for the marker.
  return clipAroundCursor(line, cursorCol, visibleCells, pastes);
}

function clipFromLeft(
  line: string,
  visibleCells: number,
  pastes?: ReadonlyMap<number, PasteEntry>,
): Viewport {
  // Show as much of the head as fits; mark the right edge as hidden.
  // Reserve 1 cell for the `›` marker.
  const budget = Math.max(1, visibleCells - 1);
  let used = 0;
  let end = 0;
  while (end < line.length) {
    const ch = line[end]!;
    const cw = charCellsAt(line, end, pastes);
    if (used + cw > budget) break;
    used += cw;
    end++;
  }
  const segments = textToSegments(line.slice(0, end), pastes);
  return { segments, cursorCell: null, hiddenLeft: false, hiddenRight: end < line.length };
}

function clipAroundCursor(
  line: string,
  cursorCol: number,
  visibleCells: number,
  pastes?: ReadonlyMap<number, PasteEntry>,
): Viewport {
  // `cursorCol` is between 0 and line.length (inclusive). The cursor
  // visually sits BEFORE the char at line[cursorCol] (or after the
  // last char when cursorCol === line.length).
  // We want both the char at the cursor (if any) AND a cell of cursor
  // padding visible.

  // Budget — leave 1 cell for each marker we may need.
  let budget = visibleCells;
  // Right marker: needed if we don't reach end of line.
  // Left marker: needed if start > 0.
  // We don't know in advance, so allocate conservatively: -2 cells.
  const reservedForMarkers = 2;
  budget = Math.max(1, budget - reservedForMarkers);

  // Try to keep cursor roughly centred. Start by aiming `start` ~
  // halfway behind cursorCol.
  const halfBudget = Math.floor(budget / 2);

  // Walk left from cursor, accumulating cells, until we've spent
  // halfBudget OR hit the start of the line.
  let start = cursorCol;
  let leftCells = 0;
  while (start > 0 && leftCells < halfBudget) {
    const cw = charCellsAt(line, start - 1, pastes);
    if (leftCells + cw > halfBudget) break;
    start--;
    leftCells += cw;
  }

  // Walk right from cursor, filling the remaining budget. We always
  // include a cell for the cursor itself if line[cursorCol] exists
  // (since the cursor block covers that char). At end-of-line we
  // include a phantom cell of cursor space.
  const rightBudget = budget - leftCells;
  let end = cursorCol;
  let rightCells = 0;
  // Include the char at the cursor (1 or 2 cells depending on width)
  // if there is one.
  const cursorChar = cursorCol < line.length ? charCellsAt(line, cursorCol, pastes) : 1;
  if (rightBudget >= cursorChar) {
    if (cursorCol < line.length) end = cursorCol + 1;
    rightCells = cursorChar;
    while (end < line.length && rightCells < rightBudget) {
      const cw = charCellsAt(line, end, pastes);
      if (rightCells + cw > rightBudget) break;
      rightCells += cw;
      end++;
    }
  }

  // If we have leftover right-budget and there's still room on the
  // left, expand leftwards more (cursor stays towards the right
  // edge but more left context is shown — common when typing at
  // end of a long line).
  let extraLeftBudget = rightBudget - rightCells;
  while (start > 0 && extraLeftBudget > 0) {
    const cw = charCellsAt(line, start - 1, pastes);
    if (cw > extraLeftBudget) break;
    start--;
    leftCells += cw;
    extraLeftBudget -= cw;
  }

  const hiddenLeft = start > 0;
  const hiddenRight = end < line.length;
  const segments = textToSegments(line.slice(start, end), pastes);
  // Cursor cell relative to the start of the slice. Markers are
  // rendered separately by the caller — they don't shift the
  // segment-relative offset so we don't add them here.
  const cursorCell = stringCells(line.slice(start, cursorCol), pastes);
  return { segments, cursorCell, hiddenLeft, hiddenRight };
}

function charCellsAt(line: string, idx: number, pastes?: ReadonlyMap<number, PasteEntry>): number {
  const ch = line[idx]!;
  const id = decodePasteSentinel(ch);
  if (id !== null) {
    const entry = pastes?.get(id);
    return pasteSentinelLabel(id, entry).length;
  }
  return charCells(ch);
}

export function textToSegments(line: string, pastes?: ReadonlyMap<number, PasteEntry>): Segment[] {
  const out: Segment[] = [];
  let buf = "";
  const flushBuf = () => {
    if (buf.length > 0) {
      out.push({ kind: "text", text: buf });
      buf = "";
    }
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    const id = decodePasteSentinel(ch);
    if (id !== null) {
      flushBuf();
      const label = pasteSentinelLabel(id, pastes?.get(id));
      out.push({ kind: "paste", id, label });
    } else {
      buf += ch;
    }
  }
  flushBuf();
  return out;
}
