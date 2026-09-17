import { useCallback, useLayoutEffect, useState } from "react";

export const WEB_LAYOUT_KEY = "jupiter.web.layout.v1.";
export const webLayoutStage = (width: number) =>
  width < 640 ? "narrow" : width < 1120 ? "compact" : "wide";

export function webSideMaxWidth(width: number, rightDocked: boolean): number {
  return Math.max(160, Math.min(Math.floor(width * 0.4), width - 360 - (rightDocked ? 160 : 0)));
}

export function webContextMaxWidth(width: number, visibleSide: number): number {
  return Math.max(160, width - visibleSide - 360);
}

function readCollapsed(key: string, fallbackKey?: string): boolean {
  try {
    const saved =
      localStorage.getItem(key) ?? (fallbackKey ? localStorage.getItem(fallbackKey) : null);
    return saved === "1";
  } catch {
    return false;
  }
}

export function useWebLayout(enabled: boolean, width: number, tabId: string) {
  const stage = webLayoutStage(width);
  // The old left bit also recorded automatic drawer closes, so it is not a reliable preference.
  const [sidePreferred, setSidePreferred] = useState(() =>
    readCollapsed(`${WEB_LAYOUT_KEY}sideCollapsed`),
  );
  const [ctxPreferred, setCtxPreferred] = useState(() =>
    readCollapsed(`${WEB_LAYOUT_KEY}ctxCollapsed`, "jupiter.ctxCollapsed"),
  );
  const [drawer, setDrawer] = useState<"side" | "ctx" | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Breakpoint and tab changes dismiss transient drawers before paint.
  useLayoutEffect(() => {
    setDrawer(null);
  }, [stage, tabId]);
  const closeDrawers = useCallback(() => setDrawer(null), []);
  const toggleSide = useCallback(() => {
    if (!enabled) return;
    if (stage === "narrow") {
      setDrawer((current) => (current === "side" ? null : "side"));
    } else {
      setSidePreferred((current) => {
        try {
          localStorage.setItem(`${WEB_LAYOUT_KEY}sideCollapsed`, current ? "0" : "1");
        } catch {
          /* unavailable storage */
        }
        return !current;
      });
    }
  }, [enabled, stage]);
  const toggleContext = useCallback(() => {
    if (!enabled) return;
    if (stage !== "wide") {
      setDrawer((current) => (current === "ctx" ? null : "ctx"));
    } else {
      setCtxPreferred((current) => {
        try {
          localStorage.setItem(`${WEB_LAYOUT_KEY}ctxCollapsed`, current ? "0" : "1");
        } catch {
          /* unavailable storage */
        }
        return !current;
      });
    }
  }, [enabled, stage]);
  return {
    stage,
    drawer,
    closeDrawers,
    toggleSide,
    toggleContext,
    sideCollapsed: stage === "narrow" ? drawer !== "side" : sidePreferred,
    ctxCollapsed: stage !== "wide" ? drawer !== "ctx" : ctxPreferred,
  };
}
