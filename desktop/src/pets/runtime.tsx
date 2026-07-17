import { Component, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { PetDefinition, PetVisualActivity } from "./types";

type AnimationSpec = {
  row: number;
  durations: readonly number[];
};

const ANIMATIONS: Record<PetVisualActivity, AnimationSpec> = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  "dragging-right": { row: 1, durations: [110, 110, 110, 110, 110, 110, 110, 150] },
  "dragging-left": { row: 2, durations: [110, 110, 110, 110, 110, 110, 110, 150] },
  waving: { row: 3, durations: [140, 140, 140, 280] },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280] },
  failure: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
};

export class PetErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    console.error("desktop pet render failed", error);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof matchMedia === "function"
      ? matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function useAnimationPaused(): boolean {
  const [paused, setPaused] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const sync = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  return paused;
}

export function PetSprite({
  pet,
  activity,
  lookAround = false,
  animationEnabled = true,
  frameOverride,
  className = "",
}: {
  pet: PetDefinition;
  activity: PetVisualActivity;
  lookAround?: boolean;
  animationEnabled?: boolean;
  frameOverride?: number;
  className?: string;
}) {
  const spriteRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);
  const lookUntilRef = useRef(0);
  const pointerRafRef = useRef<number | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const reducedMotion = useReducedMotion();
  const paused = useAnimationPaused();

  const paint = useCallback((row: number, column: number) => {
    const element = spriteRef.current;
    if (!element) return;
    element.style.backgroundPosition = `${(column / 7) * 100}% ${(row / 10) * 100}%`;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    setLoadState("loading");
    image.onload = () => {
      if (!cancelled) setLoadState("ready");
    };
    image.onerror = () => {
      if (!cancelled) setLoadState("failed");
    };
    image.src = pet.spriteUrl;
    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [pet.spriteUrl]);

  useEffect(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const spec = ANIMATIONS[activity];
    const manualFrame =
      frameOverride === undefined
        ? null
        : Math.max(0, Math.floor(frameOverride)) % spec.durations.length;
    paint(spec.row, manualFrame ?? 0);
    if (
      manualFrame !== null ||
      !animationEnabled ||
      loadState !== "ready" ||
      paused ||
      reducedMotion
    )
      return;

    let frame = 0;
    let cancelled = false;
    const step = () => {
      if (cancelled) return;
      if (Date.now() >= lookUntilRef.current) paint(spec.row, frame);
      const delay = spec.durations[frame] ?? 160;
      frame = (frame + 1) % spec.durations.length;
      timerRef.current = window.setTimeout(step, delay);
    };
    step();
    return () => {
      cancelled = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [activity, animationEnabled, frameOverride, loadState, paint, paused, reducedMotion]);

  useEffect(() => {
    if (
      !animationEnabled ||
      !lookAround ||
      activity !== "idle" ||
      paused ||
      reducedMotion ||
      loadState !== "ready"
    )
      return;
    const onPointerMove = (event: PointerEvent) => {
      if (pointerRafRef.current !== null) return;
      pointerRafRef.current = window.requestAnimationFrame(() => {
        pointerRafRef.current = null;
        const element = spriteRef.current;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        const dx = event.clientX - (rect.left + rect.width / 2);
        const dy = event.clientY - (rect.top + rect.height / 2);
        if (Math.hypot(dx, dy) < 28) return;
        const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;
        const direction = Math.round(((degrees + 360) % 360) / 22.5) % 16;
        lookUntilRef.current = Date.now() + 650;
        paint(direction < 8 ? 9 : 10, direction % 8);
      });
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      if (pointerRafRef.current !== null) window.cancelAnimationFrame(pointerRafRef.current);
      pointerRafRef.current = null;
      lookUntilRef.current = 0;
    };
  }, [activity, animationEnabled, loadState, lookAround, paint, paused, reducedMotion]);

  return (
    <span
      ref={spriteRef}
      className={`pet-sprite ${className}`.trim()}
      data-loading={loadState === "loading" || undefined}
      data-failed={loadState === "failed" || undefined}
      data-pixelated={pet.pixelated || undefined}
      data-pet={pet.packageId}
      style={{ backgroundImage: loadState === "failed" ? undefined : `url("${pet.spriteUrl}")` }}
      aria-hidden="true"
    />
  );
}
