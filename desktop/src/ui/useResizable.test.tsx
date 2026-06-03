// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useResizable } from "./useResizable";

function ResizeProbe({ collapsed = false }: { collapsed?: boolean }) {
  const { width, onMouseDown } = useResizable("ctx", collapsed);
  return (
    <div className="app" style={{ ["--ctx-width" as string]: `${width}px` }}>
      <button type="button" onMouseDown={onMouseDown}>
        drag
      </button>
    </div>
  );
}

describe("useResizable", () => {
  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("allows the right sidebar to grow beyond forty percent of the viewport", () => {
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    render(<ResizeProbe />);

    fireEvent.mouseDown(screen.getByRole("button", { name: "drag" }), { clientX: 800 });
    fireEvent.mouseMove(window, { clientX: 200 });
    fireEvent.mouseUp(window);

    expect(localStorage.getItem("jupiter.ctxWidth")).toBe("650");
  });
});
