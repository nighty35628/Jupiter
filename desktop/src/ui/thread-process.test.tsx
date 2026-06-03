// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMsg } from "./thread";

afterEach(cleanup);

const baseProps = {
  pending: false,
  model: "deepseek-reasoner",
  pendingConfirms: [],
  onApproveConfirm: vi.fn(),
  onRejectConfirm: vi.fn(),
  onAlwaysAllowConfirm: vi.fn(),
};

describe("AssistantMsg process cards", () => {
  it("keeps completed shell output collapsed by default", () => {
    render(
      <AssistantMsg
        {...baseProps}
        segments={[
          {
            kind: "tool",
            callId: "call-1",
            name: "run_command",
            args: JSON.stringify({ command: "echo hi" }),
            startedAt: 0,
            result: "hello from shell",
            ok: true,
          },
        ]}
      />,
    );

    expect(screen.queryByText("hello from shell")).toBeNull();
  });

  it("opens completed shell output when process cards default open", () => {
    render(
      <AssistantMsg
        {...baseProps}
        processCardsDefaultOpen
        segments={[
          {
            kind: "tool",
            callId: "call-1",
            name: "run_command",
            args: JSON.stringify({ command: "echo hi" }),
            startedAt: 0,
            result: "hello from shell",
            ok: true,
          },
        ]}
      />,
    );

    expect(screen.getByText("hello from shell")).toBeTruthy();
  });
});
