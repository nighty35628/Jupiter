import { useEffect, useRef } from "react";
import { t } from "../i18n";
import { makeInert, overlayTabbables, restoreVisibleFocus, trapOverlayTab } from "./overlay-focus";

export function useWebDrawer(
  panel: "side" | "ctx" | "info" | null,
  onClose: () => void,
  modalOpen: boolean,
) {
  const closeRef = useRef(onClose);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  closeRef.current = onClose;
  useEffect(() => {
    if (!panel || modalOpen) return;
    const selector =
      panel === "side"
        ? ".sidebar"
        : panel === "info"
          ? '.context-info-popover[data-open="true"]'
          : '.ctx[data-placement="side"]';
    const root = document.querySelector<HTMLElement>(selector);
    if (!root) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const attributeKeys = ["role", "aria-modal", "tabindex", "aria-label"];
    const previous = attributeKeys.map((key) => root.getAttribute(key));
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("tabindex", "-1");
    if (!root.hasAttribute("aria-label"))
      root.setAttribute(
        "aria-label",
        t(panel === "side" ? "app.titlebar.sidebar" : "contextPanel.toggleRightSidebar"),
      );
    const blocked = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".app .main, .app .tabbar, .app .sidebar, .app .ctx, .app .context-info-popover",
      ),
    ).filter((element) => element !== root);
    const release = makeInert(blocked);
    const focus =
      lastFocusRef.current && root.contains(lastFocusRef.current)
        ? lastFocusRef.current
        : (overlayTabbables(root)[0] ?? root);
    focus.focus({ preventScroll: true });
    const rememberFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) lastFocusRef.current = event.target;
    };
    root.addEventListener("focusin", rememberFocus);
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        document.querySelector(
          ".settings-card, .settings-mask, .cmdk-mask, .jobs-mask, .about-mask, .wd-mask, .web-workspace-dialog",
        )
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else trapOverlayTab(event, root);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      root.removeEventListener("focusin", rememberFocus);
      release();
      attributeKeys.forEach((key, index) => {
        const value = previous[index];
        if (value === null || value === undefined) root.removeAttribute(key);
        else root.setAttribute(key, value);
      });
      // Opening another modal owns focus restoration until that modal closes.
      if (!document.querySelector(".settings-card, .settings-mask")) restoreVisibleFocus(trigger);
    };
  }, [panel, modalOpen]);
}
