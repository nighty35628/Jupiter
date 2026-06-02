import { describe, expect, it, vi } from "vitest";
import {
  autoscrollVirtuosoOutput,
  followVirtuosoHeightChange,
  isScrollElementNearBottom,
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

  it("follows list height changes by end-aligning the last message", () => {
    const handle = {
      scrollToIndex: vi.fn(),
      autoscrollToBottom: vi.fn(),
    };

    expect(followVirtuosoHeightChange({ current: handle }, 5, true)).toBe(true);

    expect(handle.scrollToIndex).toHaveBeenCalledWith({
      index: 4,
      align: "end",
      behavior: "auto",
    });
  });

  it("does not follow list height changes when transcript following is disabled", () => {
    const handle = {
      scrollToIndex: vi.fn(),
      autoscrollToBottom: vi.fn(),
    };

    expect(followVirtuosoHeightChange({ current: handle }, 5, false)).toBe(false);

    expect(handle.scrollToIndex).not.toHaveBeenCalled();
  });

  it("detects whether the scroll container is close enough to the bottom", () => {
    const element = {
      scrollTop: 915,
      clientHeight: 100,
      scrollHeight: 1000,
    };

    expect(isScrollElementNearBottom(element)).toBe(true);
    expect(isScrollElementNearBottom({ ...element, scrollTop: 700 })).toBe(false);
  });
});
