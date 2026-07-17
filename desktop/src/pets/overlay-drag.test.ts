import { describe, expect, it } from "vitest";
import { PET_DRAG_THRESHOLD, petDragActivity, petDragDistance, petRollAngle } from "./overlay-drag";

describe("pet overlay drag", () => {
  it("uses the left and right movement rows", () => {
    expect(petDragActivity(-8)).toBe("dragging-left");
    expect(petDragActivity(8)).toBe("dragging-right");
    expect(petDragActivity(0, "dragging-left")).toBe("dragging-left");
  });

  it("keeps small pointer jitter below the click threshold", () => {
    expect(petDragDistance(3, 3)).toBeLessThan(PET_DRAG_THRESHOLD);
    expect(petDragDistance(4, 4)).toBeGreaterThan(PET_DRAG_THRESHOLD);
  });

  it("keeps horizontal rolling continuous and directional", () => {
    expect(petRollAngle(0)).toBe(0);
    expect(petRollAngle(20)).toBe(25);
    expect(petRollAngle(-20)).toBe(-25);
    expect(petRollAngle(Number.NaN)).toBe(0);
  });
});
