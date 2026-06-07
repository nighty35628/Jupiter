// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toast } from "../CommandPalette";
import { setLang } from "../i18n";
import { Composer, clipboardFileMentionPaths } from "./composer";

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

  it("does not expose the legacy read-only plan permission as a mode option", () => {
    renderComposer({ editMode: "review" });

    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));

    expect(document.body.textContent).not.toContain("只读模式");
    expect(document.querySelectorAll(".composer-mode-option").length).toBe(3);
  });

  it("renders the active permission mode with a dedicated icon", () => {
    renderComposer({ editMode: "auto" });

    const trigger = screen.getByRole("button", { name: "权限模式" });

    expect(trigger.querySelector(".composer-permission-icon svg")).toBeTruthy();
    expect(trigger.querySelector(".composer-permission-chev")).toBeTruthy();
  });

  it("uses a smaller icon-only permission trigger when the composer is narrow", () => {
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    const narrowRule =
      css.match(
        /@container composer \(max-width: 620px\) \{[\s\S]*?(?=@container composer \(max-width: 520px\))/,
      )?.[0] ?? "";

    expect(narrowRule).toContain("width: 26px;");
    expect(narrowRule).toContain("height: 26px;");
    expect(narrowRule).toContain(".composer-permission-label");
    expect(narrowRule).toContain(".composer-permission-chev");
    expect(narrowRule).toContain("display: none;");
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

describe("desktop Composer source search", () => {
  beforeEach(() => {
    setLang("en");
  });

  it("opens the source search entry from the search button beside plus", () => {
    const onMentionQuery = vi.fn();
    const onOpenSourceSearch = vi.fn();
    renderComposer({ onMentionQuery, onOpenSourceSearch });

    fireEvent.click(screen.getByRole("button", { name: "Search sources" }));

    expect(onOpenSourceSearch).toHaveBeenCalledTimes(1);
    expect(onMentionQuery).not.toHaveBeenCalled();
    expect(screen.queryByText("Mentions — files in the workspace")).toBeNull();
  });
});

describe("desktop Composer clipboard files", () => {
  it("extracts Finder-style file URLs as workspace-relative mentions", () => {
    const paths = clipboardFileMentionPaths(
      {
        files: { length: 2 },
        getData: (type: string) =>
          type === "text/uri-list"
            ? [
                "# Finder comment",
                "file:///repo/src/App.tsx",
                "file:///repo/docs/hello%20world.md",
              ].join("\n")
            : "",
      } as unknown as DataTransfer,
      "/repo",
    );

    expect(paths).toEqual(["src/App.tsx", "docs/hello world.md"]);
  });
});
