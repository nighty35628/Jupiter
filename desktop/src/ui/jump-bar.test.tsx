// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JumpBar } from "./jump-bar";

Element.prototype.scrollIntoView = vi.fn();

describe("JumpBar", () => {
  it("uses Virtuoso index scrolling when a turn dot is clicked", () => {
    const scrollToIndex = vi.fn();
    const { container } = render(
      <JumpBar
        messages={[
          { kind: "user", text: "first prompt", turn: 1 },
          { kind: "assistant", turn: 1 },
          { kind: "user", text: "second prompt", turn: 2 },
        ]}
        virtuosoRef={{ current: { scrollToIndex } }}
      />,
    );

    const secondDot = container.querySelector<HTMLElement>('[data-turn="2"]');
    expect(secondDot).toBeTruthy();

    fireEvent.click(secondDot!);

    expect(scrollToIndex).toHaveBeenCalledWith({
      index: 2,
      align: "start",
      behavior: "smooth",
    });
  });
});
