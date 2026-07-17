export interface TranscriptElisionSegment {
  kind: "elision";
  segmentCount: number;
  charCount: number;
}

export interface TranscriptDisplayTruncation {
  originalChars: number;
}

export interface TranscriptBudgetOptions {
  maxPayloadBytes?: number;
  maxChars?: number;
  maxSegments?: number;
  maxFieldChars?: number;
  maxUserChars?: number;
  previewChars?: number;
  preserveTurns?: ReadonlySet<number>;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_MAX_CHARS = 180_000;
const DEFAULT_MAX_SEGMENTS = 160;
const DEFAULT_MAX_FIELD_CHARS = 64_000;
const DEFAULT_MAX_USER_CHARS = 64_000;
const DEFAULT_PREVIEW_CHARS = 12_000;

type UnknownMessage = { kind: string; [key: string]: unknown };
type UnknownSegment = { kind: string; [key: string]: unknown };

function segmentChars(segment: UnknownSegment): number {
  if (segment.kind === "text" || segment.kind === "reasoning") {
    return typeof segment.text === "string" ? segment.text.length : 0;
  }
  if (segment.kind === "tool") {
    return (
      (typeof segment.args === "string" ? segment.args.length : 0) +
      (typeof segment.result === "string" ? segment.result.length : 0)
    );
  }
  return 0;
}

function payloadBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function previewText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[display preview truncated]`;
}

function collapseAssistant(
  message: UnknownMessage,
  remainingChars: number,
  remainingSegments: number,
  options: Required<Omit<TranscriptBudgetOptions, "preserveTurns">>,
): { message: UnknownMessage; usedChars: number; usedSegments: number } {
  const segments = Array.isArray(message.segments) ? (message.segments as UnknownSegment[]) : [];
  const totalChars = segments.reduce((sum, segment) => sum + segmentChars(segment), 0);
  const fieldTooLarge = segments.some((segment) => {
    if (segment.kind === "text" || segment.kind === "reasoning") {
      return typeof segment.text === "string" && segment.text.length > options.maxFieldChars;
    }
    if (segment.kind === "tool") {
      return (
        (typeof segment.args === "string" && segment.args.length > options.maxFieldChars) ||
        (typeof segment.result === "string" && segment.result.length > options.maxFieldChars)
      );
    }
    return false;
  });

  if (!fieldTooLarge && segments.length <= remainingSegments && totalChars <= remainingChars) {
    return { message, usedChars: totalChars, usedSegments: segments.length };
  }

  let preview: UnknownSegment | undefined;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment?.kind !== "text" || typeof segment.text !== "string" || !segment.text.trim()) {
      continue;
    }
    const text = previewText(
      segment.text,
      Math.max(0, Math.min(options.previewChars, remainingChars)),
    );
    if (text.length > 0 && remainingSegments > 1) preview = { ...segment, text };
    break;
  }

  const previewChars = preview ? segmentChars(preview) : 0;
  const elision: TranscriptElisionSegment = {
    kind: "elision",
    segmentCount: segments.length,
    charCount: totalChars,
  };
  const nextSegments: UnknownSegment[] = [{ ...elision }];
  if (preview) nextSegments.push(preview);
  return {
    message: { ...message, segments: nextSegments, displayTruncated: true },
    usedChars: previewChars,
    usedSegments: nextSegments.length,
  };
}

/** Bounds renderer data while keeping turn shells; full records stay on disk. */
export function budgetTranscriptMessages<T extends { kind: string }>(
  input: readonly T[],
  opts: TranscriptBudgetOptions = {},
): T[] {
  const options = {
    maxPayloadBytes: opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    maxChars: opts.maxChars ?? DEFAULT_MAX_CHARS,
    maxSegments: opts.maxSegments ?? DEFAULT_MAX_SEGMENTS,
    maxFieldChars: opts.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS,
    maxUserChars: opts.maxUserChars ?? DEFAULT_MAX_USER_CHARS,
    previewChars: opts.previewChars ?? DEFAULT_PREVIEW_CHARS,
  };
  const preserveTurns = opts.preserveTurns ?? new Set<number>();
  const messages = input as readonly UnknownMessage[];
  let totalChars = 0;
  let totalSegments = 0;
  for (const message of messages) {
    if (message.kind === "user" && typeof message.text === "string") {
      totalChars += message.text.length;
    } else if (message.kind === "assistant" && Array.isArray(message.segments)) {
      totalSegments += message.segments.length;
      totalChars += (message.segments as UnknownSegment[]).reduce(
        (sum, segment) => sum + segmentChars(segment),
        0,
      );
    }
  }
  if (
    totalChars <= options.maxChars &&
    totalSegments <= options.maxSegments &&
    payloadBytes(input) <= options.maxPayloadBytes
  ) {
    return input as T[];
  }

  let remainingChars = options.maxChars;
  let remainingSegments = options.maxSegments;
  const next = messages.slice() as UnknownMessage[];
  for (let i = next.length - 1; i >= 0; i--) {
    const message = next[i];
    if (!message) continue;
    const turn = typeof message.turn === "number" ? message.turn : -1;
    if (message.kind === "assistant" && Array.isArray(message.segments)) {
      if (message.pending === true || preserveTurns.has(turn)) {
        remainingChars -= (message.segments as UnknownSegment[]).reduce(
          (sum, segment) => sum + segmentChars(segment),
          0,
        );
        remainingSegments -= message.segments.length;
        continue;
      }
      const collapsed = collapseAssistant(
        message,
        Math.max(0, remainingChars),
        Math.max(0, remainingSegments),
        options,
      );
      next[i] = collapsed.message;
      remainingChars -= collapsed.usedChars;
      remainingSegments -= collapsed.usedSegments;
      continue;
    }
    if (message.kind === "user" && typeof message.text === "string") {
      const allowed = Math.max(0, Math.min(options.maxUserChars, remainingChars));
      if (!preserveTurns.has(turn) && message.text.length > allowed) {
        const text = previewText(message.text, Math.min(options.previewChars, allowed));
        next[i] = {
          ...message,
          text,
          displayTruncated: { originalChars: message.text.length },
        };
        remainingChars -= text.length;
      } else {
        remainingChars -= message.text.length;
      }
    }
  }

  if (payloadBytes(next) > options.maxPayloadBytes) {
    for (let i = 0; i < next.length && payloadBytes(next) > options.maxPayloadBytes; i++) {
      const message = next[i];
      if (!message || message.kind !== "assistant" || !Array.isArray(message.segments)) continue;
      const turn = typeof message.turn === "number" ? message.turn : -1;
      if (
        message.pending === true ||
        preserveTurns.has(turn) ||
        message.displayTruncated === true
      ) {
        continue;
      }
      const chars = (message.segments as UnknownSegment[]).reduce(
        (sum, segment) => sum + segmentChars(segment),
        0,
      );
      next[i] = {
        ...message,
        displayTruncated: true,
        segments: [
          {
            kind: "elision",
            segmentCount: message.segments.length,
            charCount: chars,
          } satisfies TranscriptElisionSegment,
        ],
      };
    }
  }
  return next as T[];
}

export function transcriptPayloadBytes(messages: readonly { kind: string }[]): number {
  return payloadBytes(messages);
}
