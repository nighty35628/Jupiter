// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_PETS } from "./catalog";
import { PetSprite } from "./runtime";

class LoadedImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    if (value) this.onload?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Image", LoadedImage);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PetSprite", () => {
  it("uses the directional v2 atlas rows while dragging", () => {
    const view = render(<PetSprite pet={BUILTIN_PETS[0]!} activity="dragging-left" />);
    const sprite = view.container.querySelector<HTMLElement>(".pet-sprite");
    expect(sprite?.style.backgroundPosition).toBe("0% 20%");

    view.rerender(<PetSprite pet={BUILTIN_PETS[0]!} activity="dragging-right" />);
    expect(sprite?.style.backgroundPosition).toBe("0% 10%");
  });

  it("uses a distance-driven frame override without scheduling a timer", () => {
    const view = render(
      <PetSprite pet={BUILTIN_PETS[0]!} activity="dragging-right" frameOverride={3} />,
    );
    const sprite = view.container.querySelector<HTMLElement>(".pet-sprite");
    expect(sprite?.style.backgroundPosition).toBe(`${(3 / 7) * 100}% 10%`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps animating when the always-on-top window is not focused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    render(<PetSprite pet={BUILTIN_PETS[0]!} activity="running" />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => vi.advanceTimersByTime(500));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("does not schedule preview animation or pointer tracking while inactive", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    render(
      <PetSprite pet={BUILTIN_PETS[0]!} activity="idle" lookAround animationEnabled={false} />,
    );

    expect(addEventListener.mock.calls.some(([type]) => type === "pointermove")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
