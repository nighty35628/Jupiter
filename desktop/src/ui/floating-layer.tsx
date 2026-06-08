import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  type Placement,
} from "@floating-ui/react-dom";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type FloatingLayerPlacement = "bottom-start" | "bottom-end" | "top-start" | "right-start";

type CoordinateAnchor = { left: number; top: number };

function isCoordinateAnchor(
  anchor: HTMLElement | CoordinateAnchor | null,
): anchor is CoordinateAnchor {
  return Boolean(anchor && (typeof HTMLElement === "undefined" || !(anchor instanceof HTMLElement)));
}

export function FloatingLayer({
  anchor,
  open,
  placement = "bottom-start",
  className,
  onClose,
  children,
}: {
  anchor: HTMLElement | CoordinateAnchor | null;
  open: boolean;
  placement?: FloatingLayerPlacement;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", left: 0, top: 0 });

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: MouseEvent | PointerEvent) => {
      const target = event.target as Node | null;
      if (target && layerRef.current?.contains(target)) return;
      onClose();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose, open]);

  useLayoutEffect(() => {
    if (!open || !anchor) return;

    if (isCoordinateAnchor(anchor)) {
      setStyle({ position: "fixed", left: anchor.left, top: anchor.top });
      return;
    }

    const layer = layerRef.current;
    if (!layer) return;

    let cancelled = false;
    const update = () => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        void computePosition(anchor, layer, {
          placement: placement as Placement,
          middleware: [offset(6), flip(), shift({ padding: 8 })],
          strategy: "fixed",
        }).then(({ x, y }) => {
          if (!cancelled) setStyle({ position: "fixed", left: x, top: y });
        });
      });
    };

    const cleanup = autoUpdate(anchor, layer, update);
    update();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [anchor, open, placement]);

  if (!open || !anchor) return null;

  return createPortal(
    <div
      ref={layerRef}
      className={className ? `floating-layer ${className}` : "floating-layer"}
      style={style}
    >
      {children}
    </div>,
    document.body,
  );
}
