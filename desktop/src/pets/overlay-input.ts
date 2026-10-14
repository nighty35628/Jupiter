import { type Window as NativeWindow, cursorPosition } from "@tauri-apps/api/window";
import { type RefObject, useEffect, useRef } from "react";
import { type PetAlphaMask, loadPetAlphaMask, petOverlayHit } from "./overlay-hit-test";

export function usePetOverlayInput(
  window: NativeWindow,
  root: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  spriteUrl: string | undefined,
  captured: () => boolean,
) {
  const mask = useRef<PetAlphaMask | null>(null);
  const capturedRef = useRef(captured);
  capturedRef.current = captured;

  useEffect(() => {
    let disposed = false;
    mask.current = null;
    if (enabled && spriteUrl)
      void loadPetAlphaMask(spriteUrl).then((value) => {
        if (!disposed) mask.current = value;
      });
    return () => {
      disposed = true;
    };
  }, [enabled, spriteUrl]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let ignored: boolean | undefined;
    const update = async () => {
      try {
        const [cursor, origin, scale] = await Promise.all([
          cursorPosition(),
          window.innerPosition(),
          window.scaleFactor(),
        ]);
        if (disposed) return;
        const hit =
          capturedRef.current() ||
          Boolean(
            root.current &&
              petOverlayHit(
                root.current,
                mask.current,
                (cursor.x - origin.x) / scale,
                (cursor.y - origin.y) / scale,
              ),
          );
        if (ignored !== !hit) {
          await window.setIgnoreCursorEvents(!hit);
          ignored = !hit;
        }
      } catch {
        // A failed probe must not leave an invisible window blocking other applications.
        if (!disposed && !capturedRef.current()) {
          await window.setIgnoreCursorEvents(true).catch(() => undefined);
          ignored = undefined;
        }
      } finally {
        if (!disposed) timer = setTimeout(update, 32);
      }
    };
    void update();
    return () => {
      disposed = true;
      clearTimeout(timer);
      void window.setIgnoreCursorEvents(true).catch(() => undefined);
    };
  }, [enabled, root, window]);

  return (x: number, y: number) =>
    Boolean(root.current && petOverlayHit(root.current, mask.current, x, y));
}
