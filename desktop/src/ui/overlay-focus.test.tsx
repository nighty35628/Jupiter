// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeInert, restoreVisibleFocus, trapOverlayTab } from "./overlay-focus";

afterEach(cleanup);

describe("overlay focus ownership", () => {
  it("keeps shared background inert until both overlapping owners release it", () => {
    const { container } = render(<button type="button">background</button>);
    const button = container.querySelector("button")!;
    const releaseDrawer = makeInert([button]);
    const releaseSettings = makeInert([button]);
    releaseDrawer();
    expect(button.hasAttribute("inert")).toBe(true);
    releaseSettings();
    expect(button.hasAttribute("inert")).toBe(false);
  });

  it("restores to the visible sidebar toggle when the original trigger is removed or hidden", () => {
    const { container } = render(
      <>
        <div className="titlebar">
          <div className="tb-left">
            <button type="button">Sidebar</button>
          </div>
        </div>
        <div inert>
          <button type="button" id="hidden-trigger">
            Settings
          </button>
        </div>
      </>,
    );
    const fallback = container.querySelector("button")!;
    restoreVisibleFocus(container.querySelector("#hidden-trigger"));
    expect(document.activeElement).toBe(fallback);
    restoreVisibleFocus(document.createElement("button"));
    expect(document.activeElement).toBe(fallback);
    restoreVisibleFocus(document.body);
    expect(document.activeElement).toBe(fallback);
  });

  it("wraps Tab in both directions and ignores inert controls", () => {
    const { container } = render(
      <section>
        <button type="button">first</button>
        <button type="button" inert>
          hidden
        </button>
        <button type="button">last</button>
      </section>,
    );
    const root = container.querySelector("section")!;
    const buttons = root.querySelectorAll("button");
    const listener = (event: KeyboardEvent) => trapOverlayTab(event, root);
    root.addEventListener("keydown", listener);
    buttons[2]!.focus();
    fireEvent.keyDown(buttons[2]!, { key: "Tab" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0]!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(buttons[2]);
    root.removeEventListener("keydown", listener);
  });
});
