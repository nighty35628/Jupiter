// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Undo2 } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { AssistantMsg, UserMsg } from "./thread";

afterEach(() => {
  cleanup();
  setLang("en");
});

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

  it("collapses running shell output after completion when default is collapsed", () => {
    const { rerender } = render(
      <AssistantMsg
        {...baseProps}
        pending
        segments={[
          {
            kind: "tool",
            callId: "call-1",
            name: "run_command",
            args: JSON.stringify({ command: "echo hi" }),
            startedAt: 0,
          },
        ]}
      />,
    );

    expect(screen.getByText("echo hi")).toBeTruthy();

    rerender(
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

  it("keeps running shell output open after completion when default is expanded", () => {
    const { rerender } = render(
      <AssistantMsg
        {...baseProps}
        pending
        processCardsDefaultOpen
        segments={[
          {
            kind: "tool",
            callId: "call-1",
            name: "run_command",
            args: JSON.stringify({ command: "echo hi" }),
            startedAt: 0,
          },
        ]}
      />,
    );

    rerender(
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

describe("message rollback actions", () => {
  it("renders rollback to current before copy for user messages", () => {
    setLang("zh-CN");
    const onRollback = vi.fn();
    vi.mocked(Undo2).mockClear();
    render(
      <UserMsg
        text="change the header"
        rollbackAvailable
        onRollback={onRollback}
      />,
    );

    const actions = screen.getAllByRole("button");
    expect(actions[0]?.getAttribute("title")).toBe("回滚到当前");
    expect(actions[1]?.getAttribute("title")).toBe("复制这条消息");

    fireEvent.click(actions[0]!);
    expect(onRollback).toHaveBeenCalled();
    expect(Undo2).toHaveBeenCalled();
  });

  it("keeps rollback visible but disabled when unavailable", () => {
    setLang("zh-CN");
    render(<UserMsg text="latest message" rollbackAvailable={false} />);

    const rollback = screen.getByRole("button", { name: "无法回滚到当前" });
    expect((rollback as HTMLButtonElement).disabled).toBe(true);
    expect(rollback.getAttribute("title")).toBe("无法回滚到当前");
  });
});
