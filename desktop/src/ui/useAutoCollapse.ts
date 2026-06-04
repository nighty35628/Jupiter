import { useCallback, useRef, useState } from "react";

/** A collapsible panel whose state is persisted to localStorage and can be
 *  driven by either the user (toggle) or the responsive layout
 *  (requireCollapsed / releaseCollapsed). Only user-driven changes persist —
 *  auto-collapses survive in memory but never overwrite the stored preference,
 *  and only auto-collapses get restored when the layout releases them. */
export function useAutoCollapse(
  persistKey: string,
  defaultCollapsed = false,
): {
  collapsed: boolean;
  toggle: () => void;
  requireCollapsed: () => void;
  releaseCollapsed: () => void;
} {
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem(persistKey);
    if (saved === "1") return true;
    if (saved === "0") return false;
    return defaultCollapsed;
  });
  const sourceRef = useRef<"user" | "auto">("user");

  const toggle = useCallback(() => {
    sourceRef.current = "user";
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(persistKey, next ? "1" : "0");
      return next;
    });
  }, [persistKey]);

  const requireCollapsed = useCallback(() => {
    setCollapsed((c) => {
      if (c) return c;
      sourceRef.current = "auto";
      return true;
    });
  }, []);

  const releaseCollapsed = useCallback(() => {
    setCollapsed((c) => {
      if (!c || sourceRef.current !== "auto") return c;
      sourceRef.current = "user";
      return false;
    });
  }, []);

  return { collapsed, toggle, requireCollapsed, releaseCollapsed };
}
