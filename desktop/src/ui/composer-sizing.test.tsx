// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeComposerTextareaWidth } from "./composer-sizing";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Web composer width observer", () => {
  it("remeasures after grid animation settles, ignores height-only changes, and cleans up", () => {
    vi.useFakeTimers();
    let notify = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const { container } = render(<textarea style={{ lineHeight: "20px", padding: "10px" }} />);
    const textarea = container.querySelector("textarea")!;
    let width = 30;
    Object.defineProperty(textarea, "clientWidth", { get: () => width });
    Object.defineProperty(textarea, "scrollHeight", { get: () => (width < 100 ? 280 : 60) });
    textarea.style.height = "280px";
    const stop = observeComposerTextareaWidth(textarea);
    width = 280;
    notify();
    act(() => vi.runOnlyPendingTimers());
    expect(textarea.style.height).toBe("60px");
    notify();
    expect(vi.getTimerCount()).toBe(0);
    width = 300;
    notify();
    stop();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
