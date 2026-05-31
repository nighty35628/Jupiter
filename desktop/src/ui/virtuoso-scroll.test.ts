import { describe, expect, it, vi } from "vitest";
import {
  autoscrollVirtuosoOutput,
  followVirtuosoHeightChange,
  scrollVirtuosoToBottom,
} from "./virtuoso-scroll";

describe("desktop Virtuoso transcript scrolling", () => {
  it("scrolls the virtualized transcript to the last rendered message", () => {
    const handle = {
      scrollToIndex: vi.fn(),
      autoscrollToBottom: vi.fn(),
    };

    expect(scrollVirtuosoToBottom({ current: handle }, 4, true)).toBe(true);

    expect(handle.scrollToIndex).toHaveBeenCalledWith({
      index: 3,
      align: "end",
      behavior: "smooth",
    });
  });

  it("does nothing when there are no messages to scroll to", () => {
    const handle = {
      scrollToIndex: vi.fn(),
      autoscrollToBottom: vi.fn(),
    };

    expect(scrollVirtuosoToBottom({ current: handle }, 0, true)).toBe(false);

    expect(handle.scrollToIndex).not.toHaveBeenCalled();
  });

  it("asks Virtuoso to keep following output when the last item grows", () => {
    const handle = {
      scrollToIndex: vi.fn(),
      autoscrollToBottom: vi.fn(),
    };

    expect(autoscrollVirtuosoOutput({ current: handle })).toBe(true);

    expect(handle.autoscrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("follows list height changes during an active turn", () => {
    const handle = {
      scrollToIndex: vi.fn(),
      autoscrollToBottom: vi.fn(),
    };

    expect(followVirtuosoHeightChange({ current: handle }, true)).toBe(true);

    expect(handle.autoscrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("does not follow list height changes after the turn settles", () => {
    const handle = {
      scrollToIndex: vi.fn(),
      autoscrollToBottom: vi.fn(),
    };

    expect(followVirtuosoHeightChange({ current: handle }, false)).toBe(false);

    expect(handle.autoscrollToBottom).not.toHaveBeenCalled();
  });
});
