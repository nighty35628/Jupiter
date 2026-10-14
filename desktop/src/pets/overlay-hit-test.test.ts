// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { petFrameHit, petOverlayHit } from "./overlay-hit-test";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("pet hit testing", () => {
  it("uses the current atlas frame and rejects transparent padding and shadows", () => {
    const mask = { width: 16, height: 22, data: new Uint8ClampedArray(16 * 22 * 4) };
    mask.data[(6 * 16 + 4) * 4 + 3] = 255;
    mask.data[(6 * 16 + 5) * 4 + 3] = 40;
    expect(petFrameHit(mask, 2, 3, 0.1, 0.1)).toBe(true);
    expect(petFrameHit(mask, 2, 3, 0.8, 0.1)).toBe(false);
    expect(petFrameHit(mask, 2, 3, 0.1, 0.8)).toBe(false);
    expect(petFrameHit(mask, 0, 0, 0.1, 0.1)).toBe(false);
    for (const [x, y] of [
      [-0.1, 0.5],
      [1, 0.5],
      [0.5, -0.1],
      [0.5, 1],
    ]) {
      expect(petFrameHit(mask, 2, 3, x!, y!)).toBe(false);
    }
  });

  it("keeps visible menu bounds interactive but not hidden bubbles or empty window space", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="pet-context-menu"></div><button class="pet-status-bubble"></button>';
    document.body.append(root);
    for (const child of root.children) {
      vi.spyOn(child, "getBoundingClientRect").mockReturnValue({
        left: 10,
        top: 20,
        right: 80,
        bottom: 60,
      } as DOMRect);
    }
    expect(petOverlayHit(root, null, 30, 30)).toBe(true);
    expect(petOverlayHit(root, null, 100, 100)).toBe(false);
    (root.children[0] as HTMLElement).style.pointerEvents = "none";
    (root.children[1] as HTMLElement).style.opacity = "0";
    expect(petOverlayHit(root, null, 30, 30)).toBe(false);
  });

  it("maps CSS sprite dimensions and the selected frame to alpha pixels", () => {
    vi.stubGlobal(
      "DOMMatrixReadOnly",
      class {
        inverse() {
          return this;
        }
        transformPoint(point: { x: number; y: number }) {
          return point;
        }
      },
    );
    const root = document.createElement("div");
    root.innerHTML =
      '<span class="pet-overlay-sprite" style="width:100px;height:100px;background-position:0% 30%;transform:none"></span>';
    document.body.append(root);
    const sprite = root.firstElementChild as HTMLElement;
    // jsdom does not expand background-position into its computed longhands.
    sprite.style.backgroundPositionX = "0%";
    sprite.style.backgroundPositionY = "30%";
    vi.spyOn(sprite, "getBoundingClientRect").mockReturnValue({
      left: 50,
      top: 40,
      width: 100,
      height: 100,
    } as DOMRect);
    const mask = { width: 16, height: 22, data: new Uint8ClampedArray(16 * 22 * 4) };
    mask.data[6 * 16 * 4 + 3] = 255;
    expect(petOverlayHit(root, mask, 60, 50)).toBe(true);
    expect(petOverlayHit(root, mask, 140, 50)).toBe(false);
    expect(petOverlayHit(root, mask, 49, 50)).toBe(false);
    expect(petOverlayHit(root, null, 60, 50)).toBe(false);
    sprite.dataset.failed = "true";
    expect(petOverlayHit(root, mask, 60, 50)).toBe(false);
  });
});
