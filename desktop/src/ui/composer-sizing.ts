export const DEFAULT_COMPOSER_ROWS = 2;
export const AUTOSIZE_COMPOSER_ROWS = 5;
export const MAX_COMPOSER_ROWS = 15;

export type ComposerTextareaSizing = {
  heightPx: number;
  overflowY: "hidden" | "auto";
};

export function getComposerTextareaSizing({
  contentRows,
  lineHeightPx,
  verticalPaddingPx,
}: {
  contentRows: number;
  lineHeightPx: number;
  verticalPaddingPx: number;
}): ComposerTextareaSizing {
  const safeRows = Math.max(1, Math.ceil(contentRows));
  const visibleRows =
    safeRows < AUTOSIZE_COMPOSER_ROWS
      ? DEFAULT_COMPOSER_ROWS
      : Math.min(safeRows, MAX_COMPOSER_ROWS);

  return {
    heightPx: visibleRows * lineHeightPx + verticalPaddingPx,
    overflowY: safeRows > visibleRows ? "auto" : "hidden",
  };
}

export function applyComposerTextareaAutosize(textarea: HTMLTextAreaElement) {
  const style = window.getComputedStyle(textarea);
  const lineHeightPx = Number.parseFloat(style.lineHeight);
  const paddingTopPx = Number.parseFloat(style.paddingTop);
  const paddingBottomPx = Number.parseFloat(style.paddingBottom);
  const verticalPaddingPx = paddingTopPx + paddingBottomPx;
  const measuredLineHeight = Number.isFinite(lineHeightPx) ? lineHeightPx : 20;

  textarea.style.height = "auto";
  const contentRows = Math.ceil(
    Math.max(textarea.scrollHeight - verticalPaddingPx, measuredLineHeight) / measuredLineHeight,
  );
  const sizing = getComposerTextareaSizing({
    contentRows,
    lineHeightPx: measuredLineHeight,
    verticalPaddingPx,
  });
  textarea.style.height = `${sizing.heightPx}px`;
  textarea.style.overflowY = sizing.overflowY;
}

export function observeComposerTextareaWidth(textarea: HTMLTextAreaElement): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  let width = textarea.clientWidth;
  let frame = 0;
  const observer = new ResizeObserver(() => {
    const nextWidth = textarea.clientWidth;
    // Grid transitions continue after React renders. Ignore height-only updates
    // so autosizing cannot schedule its own ResizeObserver loop.
    if (nextWidth <= 0 || nextWidth === width) return;
    width = nextWidth;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      applyComposerTextareaAutosize(textarea);
    });
  });
  observer.observe(textarea);
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
}
