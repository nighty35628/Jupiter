// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./cards", () => ({
  AssistantText: () => null,
  PlanCardView: () => null,
  ShellCard: () => null,
  ToolCard: () => null,
  ReasoningCard: () => null,
}));

import {
  ChoiceApprovalCard,
  ConfirmApprovalCard,
  PathAccessApprovalCard,
} from "./thread";

function makeShellPrompt(
  command: string,
): import("@jupiter/core-utils").ApprovalPrompt {
  return {
    id: 1,
    kind: "shell",
    tone: "warn",
    title: "Run command",
    subtitle: command,
    preview: command,
    meta: {},
    actions: [
      { id: "run_once", label: "Run once", kind: "allow_once" },
      { id: "always_allow", label: "Always allow — git", kind: "allow_always" },
      {
        id: "deny",
        label: "Deny",
        kind: "reject",
        secondaryInput: { hint: "Reason", required: false },
      },
    ],
    data: { prefix: command.split(" ")[0] ?? "" },
  };
}

function makePathPrompt(
  path: string,
  intent: "read" | "write",
): import("@jupiter/core-utils").ApprovalPrompt {
  return {
    id: 2,
    kind: "path",
    tone: "warn",
    title: `Access path — ${intent}`,
    subtitle: path,
    preview: `read_file → ${path}`,
    meta: { sandboxRoot: "/workspace" },
    actions: [
      {
        id: "run_once",
        label: intent === "write" ? "Allow write" : "Allow read",
        kind: "allow_once",
      },
      {
        id: "always_allow",
        label: "Always allow — /workspace",
        kind: "allow_always",
      },
      {
        id: "deny",
        label: "Deny",
        kind: "reject",
        secondaryInput: { hint: "Reason", required: false },
      },
    ],
    data: { prefix: "/workspace", intent },
  };
}

afterEach(cleanup);

describe("ChoiceApprovalCard", () => {
  it("renders choice options and resolves the picked option", () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();

    const { container } = render(
      <ChoiceApprovalCard
        c={{
          id: 10,
          question: "你想用哪种方式做 PPT?",
          options: [
            {
              id: "html",
              title: "HTML 网页幻灯片",
              summary: "浏览器直接打开",
            },
            {
              id: "pptx",
              title: "生成 .pptx 文件",
              summary: "可以用 Office 编辑",
            },
          ],
          allowCustom: false,
        }}
        onPick={onPick}
        onCancel={onCancel}
      />,
    );

    expect(container.querySelector(".choice-approval")).toBeTruthy();
    expect(screen.getByText("你想用哪种方式做 PPT?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /HTML 网页幻灯片/ }));
    expect(onPick).toHaveBeenCalledWith("html");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps cancel as a separate action", () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();

    render(
      <ChoiceApprovalCard
        c={{
          id: 11,
          question: "Choose a path",
          options: [{ id: "one", title: "Option one" }],
          allowCustom: false,
        }}
        onPick={onPick}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Cancel|取消/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("ConfirmApprovalCard — ApprovalPrompt rendering", () => {
  it("renders title, subtitle, and action buttons from prompt", () => {
    const { container } = render(
      <ConfirmApprovalCard
        prompt={makeShellPrompt("git status")}
        onAllow={() => {}}
        onAlwaysAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(container.querySelector(".ap-title")?.textContent).toBe(
      "Run command",
    );
    expect(container.querySelector(".ap-sub")?.textContent).toBe("git status");
    expect(screen.getByRole("button", { name: "Run once" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Always allow — git" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("marks long command previews as contained so approval actions stay reachable", () => {
    const command = `npm test -- ${"very-long-argument-".repeat(30)}`;
    const { container } = render(
      <ConfirmApprovalCard
        prompt={makeShellPrompt(command)}
        onAllow={() => {}}
        onAlwaysAllow={() => {}}
        onDeny={() => {}}
      />,
    );

    expect(
      container
        .querySelector(".ap-preview")
        ?.classList.contains("ap-preview--long"),
    ).toBe(true);
    expect(
      container
        .querySelector(".ap-foot")
        ?.contains(screen.getByRole("button", { name: "Run once" })),
    ).toBe(true);
    expect(
      container
        .querySelector(".ap-foot")
        ?.contains(screen.getByRole("button", { name: "Deny" })),
    ).toBe(true);
  });

  it("fires onAllow when primary button is clicked", () => {
    const onAllow = vi.fn();
    render(
      <ConfirmApprovalCard
        prompt={makeShellPrompt("echo hi")}
        onAllow={onAllow}
        onAlwaysAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run once" }));
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it("fires onAlwaysAllow with prefix when tertiary button is clicked", () => {
    const onAlwaysAllow = vi.fn();
    render(
      <ConfirmApprovalCard
        prompt={makeShellPrompt("npm test")}
        onAllow={() => {}}
        onAlwaysAllow={onAlwaysAllow}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Always allow/ }));
    expect(onAlwaysAllow).toHaveBeenCalledTimes(1);
    expect(onAlwaysAllow).toHaveBeenCalledWith("npm");
  });

  it("fires onDeny when secondary button is clicked", () => {
    const onDeny = vi.fn();
    render(
      <ConfirmApprovalCard
        prompt={makeShellPrompt("rm -rf /")}
        onAllow={() => {}}
        onAlwaysAllow={() => {}}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });
});

describe("PathAccessApprovalCard — ApprovalPrompt rendering", () => {
  it("renders title, subtitle, and action buttons from prompt", () => {
    const { container } = render(
      <PathAccessApprovalCard
        prompt={makePathPrompt("/etc/passwd", "read")}
        onAllow={() => {}}
        onAlwaysAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(container.querySelector(".ap-title")?.textContent).toBe(
      "Access path — read",
    );
    expect(container.querySelector(".ap-sub")?.textContent).toBe("/etc/passwd");
    expect(screen.getByRole("button", { name: "Allow read" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("fires onAlwaysAllow with prefix for path access", () => {
    const onAlwaysAllow = vi.fn();
    render(
      <PathAccessApprovalCard
        prompt={makePathPrompt("/tmp", "write")}
        onAllow={() => {}}
        onAlwaysAllow={onAlwaysAllow}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Always allow/ }));
    expect(onAlwaysAllow).toHaveBeenCalledTimes(1);
    expect(onAlwaysAllow).toHaveBeenCalledWith("/workspace");
  });
});
