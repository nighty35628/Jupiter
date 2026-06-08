// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloatingLayer } from "./floating-layer";

afterEach(cleanup);

describe("FloatingLayer", () => {
  it("renders content anchored to coordinates", () => {
    render(
      <FloatingLayer anchor={{ left: 42, top: 64 }} open onClose={vi.fn()}>
        <div role="menu">Menu</div>
      </FloatingLayer>,
    );

    const layer = screen.getByRole("menu").parentElement;
    expect(layer?.style.left).toBe("42px");
    expect(layer?.style.top).toBe("64px");
  });

  it("renders content anchored to an element", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    anchor.getBoundingClientRect = () =>
      ({
        x: 10,
        y: 20,
        left: 10,
        top: 20,
        right: 50,
        bottom: 40,
        width: 40,
        height: 20,
      }) as DOMRect;

    render(
      <FloatingLayer anchor={anchor} open onClose={vi.fn()}>
        <div role="menu">Menu</div>
      </FloatingLayer>,
    );

    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    anchor.remove();
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(
      <FloatingLayer anchor={{ left: 0, top: 0 }} open onClose={onClose}>
        <div role="menu">Menu</div>
      </FloatingLayer>,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on outside pointer down but not inside", () => {
    const onClose = vi.fn();
    render(
      <FloatingLayer anchor={{ left: 0, top: 0 }} open onClose={onClose}>
        <div role="menu">Menu</div>
      </FloatingLayer>,
    );

    fireEvent.pointerDown(screen.getByRole("menu"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
