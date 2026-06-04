export function getThreadMaxWidth({
  viewportWidth,
  visibleSide,
  visibleCtx,
}: {
  viewportWidth: number;
  visibleSide: number;
  visibleCtx: number;
}): number {
  return Math.max(580, Math.min(viewportWidth - visibleSide - visibleCtx - 80, 1120));
}

export function getVisibleContextWidth({
  ctxCollapsed,
  contextInfoOpen,
  ctxWidth,
}: {
  ctxCollapsed: boolean;
  contextInfoOpen: boolean;
  ctxWidth: number;
}): number {
  return ctxCollapsed && !contextInfoOpen ? 0 : ctxWidth;
}
