import type { RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";

type TranscriptVirtuosoHandle = Pick<
  VirtuosoHandle,
  "autoscrollToBottom" | "scrollToIndex"
>;

export function scrollVirtuosoToBottom(
  virtuosoRef: RefObject<TranscriptVirtuosoHandle | null>,
  totalCount: number,
  smooth = true,
): boolean {
  const handle = virtuosoRef.current;
  if (!handle || totalCount <= 0) return false;
  handle.scrollToIndex({
    index: totalCount - 1,
    align: "end",
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
  busy: boolean,
): boolean {
  if (!busy) return false;
  return autoscrollVirtuosoOutput(virtuosoRef);
}
