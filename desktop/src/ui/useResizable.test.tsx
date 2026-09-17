// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useBottomResizable, useResizable } from "./useResizable";

function ResizeProbe({
  side = "ctx",
  collapsed = false,
  activeWhenCollapsed = false,
  maxWidth,
}: {
  side?: "side" | "ctx";
  collapsed?: boolean;
  activeWhenCollapsed?: boolean;
  maxWidth?: number;
}) {
  const { width, onMouseDown } = useResizable(
    side,
    collapsed,
    activeWhenCollapsed,
    maxWidth === undefined
      ? undefined
      : { maxWidth, scale: 1.25, persistKey: "jupiter.web.layout.v1.sideWidth" },
  );
  const widthVar = side === "side" ? "--side-width" : "--ctx-width";
  return (
    <div className="app" style={{ [widthVar as string]: `${width}px` }}>
      <button type="button" onMouseDown={onMouseDown}>
        drag
      </button>
      <span data-testid="width">{width}</span>
    </div>
  );
}

function BottomResizeProbe({
  collapsed = false,
  maxHeight,
}: { collapsed?: boolean; maxHeight?: number }) {
  const { height, onMouseDown } = useBottomResizable(
    collapsed,
    maxHeight === undefined
      ? undefined
      : {
          maxHeight,
          scale: 1.25,
          persistKey: "jupiter.web.layout.v1.bottomHeight",
        },
  );
  return (
    <div className="app" style={{ ["--bottom-height" as string]: `${height}px` }}>
      <button type="button" onMouseDown={onMouseDown}>
        drag bottom
      </button>
      <span data-testid="bottom-height">{height}</span>
    </div>
  );
}

describe("useResizable", () => {
  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("uses matching default widths for the left and right sidebars", () => {
    const { rerender } = render(<ResizeProbe side="side" />);
    expect(screen.getByTestId("width").textContent).toBe("254");

    rerender(<ResizeProbe side="ctx" />);
    expect(screen.getByTestId("width").textContent).toBe("254");
  });

  it("clamps saved widths temporarily without overwriting the preference", () => {
    localStorage.setItem("jupiter.sideWidth", "900");
    const { rerender } = render(<ResizeProbe side="side" maxWidth={260} />);
    expect(screen.getByTestId("width").textContent).toBe("260");
    expect(localStorage.getItem("jupiter.web.layout.v1.sideWidth")).toBeNull();
    rerender(<ResizeProbe side="side" maxWidth={500} />);
    expect(screen.getByTestId("width").textContent).toBe("500");
    rerender(<ResizeProbe side="side" maxWidth={1000} />);
    expect(screen.getByTestId("width").textContent).toBe("900");
    expect(localStorage.getItem("jupiter.sideWidth")).toBe("900");
  });

  it("starts a zoomed drag from the effective width and saves only to the Web key", () => {
    localStorage.setItem("jupiter.sideWidth", "900");
    render(<ResizeProbe side="side" maxWidth={300} />);
    fireEvent.mouseDown(screen.getByRole("button", { name: "drag" }), { clientX: 375 });
    fireEvent.mouseMove(window, { clientX: 250 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId("width").textContent).toBe("200");
    expect(localStorage.getItem("jupiter.web.layout.v1.sideWidth")).toBe("200");
    expect(localStorage.getItem("jupiter.sideWidth")).toBe("900");
  });

  it("allows the right sidebar to grow beyond forty percent of the viewport", () => {
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    render(<ResizeProbe />);

    fireEvent.mouseDown(screen.getByRole("button", { name: "drag" }), { clientX: 800 });
    fireEvent.mouseMove(window, { clientX: 200 });
    fireEvent.mouseUp(window);

    expect(localStorage.getItem("jupiter.ctxWidth")).toBe("650");
  });

  it("can resize the right info panel while the normal context sidebar is collapsed", () => {
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    render(<ResizeProbe collapsed activeWhenCollapsed />);

    fireEvent.mouseDown(screen.getByRole("button", { name: "drag" }), { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 380 });
    fireEvent.mouseUp(window);

    expect(localStorage.getItem("jupiter.ctxWidth")).toBe("374");
  });

  it("uses a compact default bottom panel height", () => {
    render(<BottomResizeProbe />);

    expect(screen.getByTestId("bottom-height").textContent).toBe("180");
  });

  it("resizes the bottom panel height by dragging upward", () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    render(<BottomResizeProbe />);

    fireEvent.mouseDown(screen.getByRole("button", { name: "drag bottom" }), { clientY: 700 });
    fireEvent.mouseMove(window, { clientY: 500 });
    fireEvent.mouseUp(window);

    expect(localStorage.getItem("jupiter.bottomHeight")).toBe("380");
  });

  it("temporarily clamps a saved bottom height as available height changes", () => {
    localStorage.setItem("jupiter.bottomHeight", "700");
    const { rerender } = render(<BottomResizeProbe maxHeight={180} />);
    expect(screen.getByTestId("bottom-height").textContent).toBe("180");
    rerender(<BottomResizeProbe maxHeight={750} />);
    expect(screen.getByTestId("bottom-height").textContent).toBe("700");
    expect(localStorage.getItem("jupiter.web.layout.v1.bottomHeight")).toBeNull();
    expect(localStorage.getItem("jupiter.bottomHeight")).toBe("700");
  });
});
