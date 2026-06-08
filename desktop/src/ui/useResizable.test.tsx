// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useBottomResizable, useResizable } from "./useResizable";

function ResizeProbe({
  side = "ctx",
  collapsed = false,
  activeWhenCollapsed = false,
}: {
  side?: "side" | "ctx";
  collapsed?: boolean;
  activeWhenCollapsed?: boolean;
}) {
  const { width, onMouseDown } = useResizable(
    side,
    collapsed,
    activeWhenCollapsed,
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

function BottomResizeProbe({ collapsed = false }: { collapsed?: boolean }) {
  const { height, onMouseDown } = useBottomResizable(collapsed);
  return (
    <div className="app" style={{ ["--bottom-height" as string]: `${height}px` }}>
      <button type="button" onMouseDown={onMouseDown}>
        drag bottom
      </button>
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

  it("resizes the bottom panel height by dragging upward", () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    render(<BottomResizeProbe />);

    fireEvent.mouseDown(screen.getByRole("button", { name: "drag bottom" }), { clientY: 700 });
    fireEvent.mouseMove(window, { clientY: 500 });
    fireEvent.mouseUp(window);

    expect(localStorage.getItem("jupiter.bottomHeight")).toBe("500");
  });
});
