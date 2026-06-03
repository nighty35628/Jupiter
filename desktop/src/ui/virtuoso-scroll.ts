import type { RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";

type TranscriptVirtuosoHandle = Pick<
  VirtuosoHandle,
  "autoscrollToBottom" | "scrollTo" | "scrollToIndex"
>;

export type ScrollMetrics = {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
};

export const TRANSCRIPT_BOTTOM_THRESHOLD = 80;

export function isScrollElementNearBottom(
  element: ScrollMetrics,
  threshold = TRANSCRIPT_BOTTOM_THRESHOLD,
): boolean {
  return (
    element.scrollTop + element.clientHeight >= element.scrollHeight - threshold
  );
}

export function scrollVirtuosoToBottom(
  virtuosoRef: RefObject<TranscriptVirtuosoHandle | null>,
  totalCount: number,
  smooth = true,
): boolean {
  const handle = virtuosoRef.current;
  if (!handle || totalCount <= 0) return false;
  handle.scrollTo({
    top: Number.MAX_SAFE_INTEGER,
    behavior: smooth ? "smooth" : "auto",
  });
  return true;
}

export function autoscrollVirtuosoOutput(
  virtuosoRef: RefObject<TranscriptVirtuosoHandle | null>,
): boolean {
  const handle = virtuosoRef.current;
  if (!handle) return false;
  handle.autoscrollToBottom();
  return true;
}

export function followVirtuosoHeightChange(
  virtuosoRef: RefObject<TranscriptVirtuosoHandle | null>,
  totalCount: number,
  shouldFollow: boolean,
): boolean {
  if (!shouldFollow) return false;
  return scrollVirtuosoToBottom(virtuosoRef, totalCount, false);
}
