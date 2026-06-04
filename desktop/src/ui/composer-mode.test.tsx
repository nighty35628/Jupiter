// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toast } from "../CommandPalette";
import { setLang } from "../i18n";
import { Composer } from "./composer";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderComposer(props?: Partial<React.ComponentProps<typeof Composer>>) {
  return render(
    <Composer
      draft=""
      setDraft={vi.fn()}
      onSend={vi.fn()}
      onAbort={vi.fn()}
      disabled={false}
      busy={false}
      modelLabel="deepseek-v4-flash"
      reasoningEffort="high"
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      editMode="review"
      onEditModeChange={vi.fn()}
      textareaRef={createRef<HTMLTextAreaElement>()}
      slashCommands={[]}
      onMentionQuery={vi.fn()}
      onMentionPreview={vi.fn()}
      onMentionPicked={vi.fn()}
      mentionResults={null}
      workspaceDir="/repo"
      {...props}
    />,
  );
}

describe("desktop permission mode copy", () => {
  beforeEach(() => {
    setLang("zh-CN");
  });

  it("uses full-control wording in the permission mode menu instead of legacy YOLO copy", () => {
    renderComposer({ editMode: "yolo" });

    const trigger = screen.getByRole("button", { name: "权限模式" });
    expect(trigger.textContent).toContain("完全控制");

    fireEvent.click(trigger);

    expect(screen.getAllByText("完全控制").length).toBeGreaterThan(0);
    expect(screen.getByText(/完全控制权限/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/YOLO/i);
  });

  it("does not show a legacy YOLO badge in the full-control toast", () => {
    render(<Toast message={{ msg: "已切换到完全控制权限，所有操作将自动批准", yolo: true }} />);

    expect(document.body.textContent).toContain("完全控制");
    expect(document.body.textContent).not.toMatch(/YOLO/i);
  });
});

describe("desktop Composer queued sends", () => {
  beforeEach(() => {
    setLang("zh-CN");
  });

  it("renders queued sends as vertical rows with jump-the-line actions", () => {
    renderComposer({
      queuedSends: ["先做这个", "再做那个"],
      onPrioritizeQueuedSend: vi.fn(),
      onDequeueSend: vi.fn(),
    });

    expect(document.querySelectorAll(".composer-queue-row").length).toBe(2);
    expect(screen.getAllByRole("button", { name: /插队/ }).length).toBe(2);
  });

  it("asks the caller to prioritize the selected queued send", () => {
    const onPrioritizeQueuedSend = vi.fn();
    renderComposer({
      queuedSends: ["先做这个", "再做那个"],
      onPrioritizeQueuedSend,
      onDequeueSend: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "插队：再做那个" }));

    expect(onPrioritizeQueuedSend).toHaveBeenCalledWith(1);
  });
});
