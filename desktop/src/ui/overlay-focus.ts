import { type RefObject, useEffect, useRef } from "react";

export function visibleFocusTarget(element: HTMLElement | null): boolean {
  if (element === document.body || element === document.documentElement) return false;
  if (!element?.isConnected || element.closest('[inert], [hidden], [aria-hidden="true"]'))
    return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

export function restoreVisibleFocus(element: HTMLElement | null): void {
  const target = visibleFocusTarget(element)
    ? element
    : document.querySelector<HTMLElement>(".titlebar .tb-left button");
  target?.focus({ preventScroll: true });
}

export function overlayTabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter(visibleFocusTarget);
}

export function trapOverlayTab(event: KeyboardEvent, root: HTMLElement): void {
  if (event.key !== "Tab") return;
  const items = overlayTabbables(root);
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    event.preventDefault();
    root.focus();
    return;
  }
  if (
    !root.contains(document.activeElement) ||
    (event.shiftKey && document.activeElement === first)
  ) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

const inertOwners = new WeakMap<HTMLElement, { count: number; original: boolean }>();
export function makeInert(elements: HTMLElement[]): () => void {
  for (const element of elements) {
    const entry = inertOwners.get(element) ?? { count: 0, original: element.hasAttribute("inert") };
    entry.count += 1;
    inertOwners.set(element, entry);
    element.setAttribute("inert", "");
  }
  return () => {
    for (const element of elements) {
      const entry = inertOwners.get(element);
      if (!entry || --entry.count > 0) continue;
      if (!entry.original) element.removeAttribute("inert");
      inertOwners.delete(element);
    }
  };
}

/** Disable siblings along the ancestor path, without disabling the dialog itself. */
export function isolateOverlay(root: HTMLElement): () => void {
  const siblings: HTMLElement[] = [];
  for (let node: HTMLElement | null = root; node?.parentElement; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (!(sibling instanceof HTMLElement) || sibling === node) continue;
      siblings.push(sibling);
    }
    if (node.parentElement === document.body) break;
  }
  return makeInert(siblings);
}

export function useQuickSettingsFocus(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  returnFocus?: RefObject<HTMLElement | null>,
) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (returnFocus) returnFocus.current = trigger;
    const release = isolateOverlay(root.parentElement ?? root);
    (overlayTabbables(root)[0] ?? root).focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else trapOverlayTab(event, root);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      release();
      restoreVisibleFocus(trigger);
    };
  }, [ref, returnFocus]);
}
