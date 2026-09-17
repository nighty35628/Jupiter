// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWebLayout, webContextMaxWidth, webLayoutStage, webSideMaxWidth } from "./useWebLayout";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("Web layout policy", () => {
  it.each([
    [375, "narrow"],
    [639, "narrow"],
    [640, "compact"],
    [641, "compact"],
    [727, "compact"],
    [1119, "compact"],
    [1120, "wide"],
    [1121, "wide"],
    [1440, "wide"],
  ] as const)("uses stage %s -> %s", (width, stage) => expect(webLayoutStage(width)).toBe(stage));

  it("defaults to a docked left sidebar at 727px, ignoring the ambiguous legacy left bit", () => {
    localStorage.setItem("jupiter.sideCollapsed", "1");
    localStorage.setItem("jupiter.ctxCollapsed", "1");
    const { result } = renderHook(() => useWebLayout(true, 727, "tab"));
    expect(result.current.sideCollapsed).toBe(false);
    expect(result.current.ctxCollapsed).toBe(true);
    expect(localStorage.getItem("jupiter.sideCollapsed")).toBe("1");
  });

  it("remembers only explicit docked choices under versioned Web keys", () => {
    const { result, rerender } = renderHook(({ width }) => useWebLayout(true, width, "tab"), {
      initialProps: { width: 727 },
    });
    act(() => result.current.toggleSide());
    expect(localStorage.getItem("jupiter.web.layout.v1.sideCollapsed")).toBe("1");
    rerender({ width: 375 });
    const write = vi.spyOn(localStorage, "setItem");
    act(() => result.current.toggleSide());
    expect(result.current.sideCollapsed).toBe(false);
    act(() => {
      result.current.closeDrawers();
      result.current.closeDrawers();
    });
    expect(result.current.sideCollapsed).toBe(true);
    rerender({ width: 727 });
    expect(result.current.sideCollapsed).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps compact right panels temporary and mutually exclusive with narrow left drawers", () => {
    const { result, rerender } = renderHook(({ width }) => useWebLayout(true, width, "tab"), {
      initialProps: { width: 727 },
    });
    const write = vi.spyOn(localStorage, "setItem");
    act(() => result.current.toggleContext());
    expect(result.current.ctxCollapsed).toBe(false);
    expect(result.current.sideCollapsed).toBe(false);
    rerender({ width: 375 });
    act(() => result.current.toggleSide());
    act(() => result.current.toggleContext());
    expect(result.current.sideCollapsed).toBe(true);
    expect(result.current.ctxCollapsed).toBe(false);
    act(() => result.current.closeDrawers());
    rerender({ width: 1440 });
    expect(result.current.sideCollapsed).toBe(false);
    expect(result.current.ctxCollapsed).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("clears transient drawers when switching tabs, but not on same-stage resizing", () => {
    const { result, rerender } = renderHook(({ width, tab }) => useWebLayout(true, width, tab), {
      initialProps: { width: 727, tab: "one" },
    });
    act(() => result.current.toggleContext());
    rerender({ width: 800, tab: "one" });
    expect(result.current.ctxCollapsed).toBe(false);
    rerender({ width: 800, tab: "two" });
    expect(result.current.ctxCollapsed).toBe(true);
  });

  it("reserves a readable main column even with huge saved panel widths", () => {
    for (const width of [640, 727, 1119, 1120, 1440]) {
      const right = width >= 1120;
      const leftWidth = webSideMaxWidth(width, right);
      const rightWidth = right ? webContextMaxWidth(width, leftWidth) : 0;
      expect(width - leftWidth - rightWidth).toBeGreaterThanOrEqual(360);
    }
  });
});
