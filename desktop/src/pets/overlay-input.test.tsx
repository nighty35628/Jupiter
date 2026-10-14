// @vitest-environment jsdom
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPetAlphaMask, petOverlayHit } from "./overlay-hit-test";
import { usePetOverlayInput } from "./overlay-input";

vi.mock("./overlay-hit-test", () => ({
  loadPetAlphaMask: vi.fn(async () => null),
  petOverlayHit: vi.fn(() => false),
}));
const native = getCurrentWindow();
const root = { current: document.createElement("div") };
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(cursorPosition).mockResolvedValue({ x: -140, y: 240 } as never);
  vi.mocked(native.innerPosition).mockResolvedValue({ x: -200, y: 100 } as never);
  vi.mocked(native.scaleFactor).mockResolvedValue(2);
  vi.mocked(petOverlayHit).mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const tick = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(35);
  });

describe("native pet pointer passthrough", () => {
  it("passes blank space through and re-enables input over artwork using physical coordinates", async () => {
    renderHook(() => usePetOverlayInput(native, root, true, "pet.webp", () => false));
    await tick();
    expect(loadPetAlphaMask).toHaveBeenCalledWith("pet.webp");
    expect(petOverlayHit).toHaveBeenLastCalledWith(root.current, null, 30, 70);
    expect(native.setIgnoreCursorEvents).toHaveBeenLastCalledWith(true);
    vi.mocked(petOverlayHit).mockReturnValue(true);
    await tick();
    expect(native.setIgnoreCursorEvents).toHaveBeenLastCalledWith(false);
    vi.mocked(petOverlayHit).mockReturnValue(false);
    await tick();
    expect(native.setIgnoreCursorEvents).toHaveBeenLastCalledWith(true);
    expect(native.setIgnoreCursorEvents).toHaveBeenCalledTimes(3);
  });

  it("retains input during dragging and native menu tracking, then restores passthrough", async () => {
    let captured = true;
    const view = renderHook(() =>
      usePetOverlayInput(native, root, true, "pet.webp", () => captured),
    );
    await tick();
    expect(native.setIgnoreCursorEvents).toHaveBeenLastCalledWith(false);
    captured = false;
    await tick();
    expect(native.setIgnoreCursorEvents).toHaveBeenLastCalledWith(true);
    view.unmount();
    const calls = vi.mocked(cursorPosition).mock.calls.length;
    await tick();
    expect(cursorPosition).toHaveBeenCalledTimes(calls);
  });

  it("does not poll a disabled overlay and stops when it is hidden", async () => {
    const view = renderHook(
      ({ enabled }) => usePetOverlayInput(native, root, enabled, undefined, () => false),
      {
        initialProps: { enabled: false },
      },
    );
    await tick();
    expect(cursorPosition).not.toHaveBeenCalled();
    view.rerender({ enabled: true });
    await tick();
    view.rerender({ enabled: false });
    const calls = vi.mocked(cursorPosition).mock.calls.length;
    await tick();
    expect(cursorPosition).toHaveBeenCalledTimes(calls);
    expect(native.setIgnoreCursorEvents).toHaveBeenLastCalledWith(true);
  });

  it("fails open to underlying apps when cursor polling fails", async () => {
    vi.mocked(cursorPosition).mockRejectedValueOnce(new Error("unavailable"));
    renderHook(() => usePetOverlayInput(native, root, true, undefined, () => false));
    await tick();
    expect(native.setIgnoreCursorEvents).toHaveBeenCalledWith(true);
  });
});
