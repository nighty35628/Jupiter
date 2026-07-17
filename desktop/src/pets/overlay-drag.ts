import type { PetVisualActivity } from "./types";

export const PET_DRAG_THRESHOLD = 5;
export const PET_ROLL_DEGREES_PER_PX = 1.25;

export function petDragDistance(deltaX: number, deltaY: number): number {
  return Math.hypot(deltaX, deltaY);
}

export function petRollAngle(horizontalOffset: number): number {
  if (!Number.isFinite(horizontalOffset)) return 0;
  return horizontalOffset * PET_ROLL_DEGREES_PER_PX;
}

export function petDragActivity(
  deltaX: number,
  previous: PetVisualActivity | null = null,
): PetVisualActivity {
  if (Math.abs(deltaX) < 1) {
    return previous === "dragging-left" || previous === "dragging-right"
      ? previous
      : "dragging-right";
  }
  return deltaX < 0 ? "dragging-left" : "dragging-right";
}
