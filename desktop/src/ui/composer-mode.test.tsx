// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toast } from "../CommandPalette";
import { setLang } from "../i18n";
import { Composer, clipboardFileMentionPaths, sanitizeComposerInput } from "./composer";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "save_clipboard_image") return "/tmp/jupiter-pasted-images/pasted.png";
    if (cmd === "read_clipboard_file_paths") return ["/repo/docs/paper.pdf"];
    return undefined;
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:jupiter-pasted-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectURL,
    });
  } else {
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  }
  if (originalRevokeObjectURL) {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectURL,
    });
  } else {
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  }
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

  it("keeps plan out of the persistent permission mode menu", () => {
    renderComposer({ editMode: "review" });

    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));

    expect(document.querySelectorAll(".composer-mode-option").length).toBe(3);
    expect(document.querySelector('.composer-mode-option[data-mode="plan"]')).toBeNull();
  });

  it("arms one-shot plan from the plus menu instead of changing permission mode", () => {
    const onEditModeChange = vi.fn();
    const onPlanArmedChange = vi.fn();
    renderComposer({ editMode: "review", onEditModeChange, onPlanArmedChange });

    fireEvent.click(screen.getByRole("button", { name: "添加上下文" }));
    fireEvent.click(screen.getByRole("button", { name: /计划/ }));

    expect(onPlanArmedChange).toHaveBeenCalledWith(true);
    expect(onEditModeChange).not.toHaveBeenCalled();
  });

  it("keeps the plus menu compact and removes the duplicate image attach entry", () => {
    renderComposer({ editMode: "review" });

    fireEvent.click(screen.getByRole("button", { name: "添加上下文" }));

    const menu = document.querySelector(".composer-plus-menu");
    expect(menu).toBeTruthy();
    expect(menu?.querySelectorAll(".composer-menu-item").length).toBe(4);
    expect(document.body.textContent).toContain("添加文件");
    expect(document.body.textContent).toContain("提及工作区文件");
    expect(document.body.textContent).not.toContain("插入图片");

    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    const plusMenuRule = css.match(/\.composer-plus-menu,\n\.composer-mode-menu \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(plusMenuRule).toContain("width: 200px");
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

  it("strips terminal arrow-key escape sequences from composer input", () => {
    expect(sanitizeComposerInput("hello\u001b[C\u001b[D world\u0007")).toBe("hello world");
    expect(sanitizeComposerInput("\u001b[Aask Jupiter")).toBe("ask Jupiter");
  });

  it("shows pasted images as thumbnails without inserting @ paths into the textarea", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    const onSend = vi.fn();
    const onMentionPicked = vi.fn();
    const { container } = renderComposer({ onSend, onMentionPicked });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");
    const imageFile = new File([new Uint8Array([1, 2, 3])], "paste.png", { type: "image/png" });

    fireEvent.paste(textarea, {
      clipboardData: {
        files: { length: 0 },
        getData: () => "",
        items: [{ type: "image/png", getAsFile: () => imageFile }],
      },
    });

    await waitFor(() => {
      expect(screen.getByAltText("pasted image")).toBeTruthy();
    });
    expect((screen.getByAltText("pasted image") as HTMLImageElement).src).toBe(
      "blob:jupiter-pasted-preview",
    );
    expect(textarea.value).toBe("");
    expect(document.body.textContent).not.toContain("@/tmp/jupiter-pasted-images");
    expect(onMentionPicked).toHaveBeenCalledWith("/tmp/jupiter-pasted-images/pasted.png");

    fireEvent.click(container.querySelector(".send-btn")!);

    expect(onSend).toHaveBeenCalledWith({
      hiddenMentions: ["/tmp/jupiter-pasted-images/pasted.png"],
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:jupiter-pasted-preview");
  });

  it("handles pasted images exposed only through clipboard files", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    const onSend = vi.fn();
    const onMentionPicked = vi.fn();
    const { container } = renderComposer({ onSend, onMentionPicked });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");
    const imageFile = new File([new Uint8Array([1, 2, 3])], "paste.png", { type: "image/png" });

    fireEvent.paste(textarea, {
      clipboardData: {
        files: {
          length: 1,
          0: imageFile,
          item: (index: number) => (index === 0 ? imageFile : null),
        },
        getData: () => "",
        items: [],
      },
    });

    await waitFor(() => {
      expect(screen.getByAltText("pasted image")).toBeTruthy();
    });
    expect((screen.getByAltText("pasted image") as HTMLImageElement).src).toBe(
      "blob:jupiter-pasted-preview",
    );
    expect(textarea.value).toBe("");
    expect(onMentionPicked).toHaveBeenCalledWith("/tmp/jupiter-pasted-images/pasted.png");

    fireEvent.click(container.querySelector(".send-btn")!);

    expect(onSend).toHaveBeenCalledWith({
      hiddenMentions: ["/tmp/jupiter-pasted-images/pasted.png"],
    });
  });

  it("shows pasted files as attachment cards without inserting @ paths into the textarea", () => {
    const onSend = vi.fn();
    const onMentionPicked = vi.fn();
    const { container } = renderComposer({ onSend, onMentionPicked });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");

    fireEvent.paste(textarea, {
      clipboardData: {
        files: { length: 1 },
        getData: (type: string) =>
          type === "text/uri-list" ? "file:///repo/docs/paper.pdf" : "",
        items: [],
      },
    });

    expect(screen.getByLabelText("Attached file paper.pdf")).toBeTruthy();
    expect(document.body.textContent).toContain("paper.pdf");
    expect(document.body.textContent).toContain("PDF");
    expect(textarea.value).toBe("");
    expect(document.body.textContent).not.toContain("@docs/paper.pdf");
    expect(onMentionPicked).toHaveBeenCalledWith("docs/paper.pdf");

    fireEvent.click(container.querySelector(".send-btn")!);

    expect(onSend).toHaveBeenCalledWith({
      hiddenMentions: ["docs/paper.pdf"],
    });
  });

  it("falls back to desktop clipboard file paths when the browser paste event only has a filename", async () => {
    const onSend = vi.fn();
    const onMentionPicked = vi.fn();
    const { container } = renderComposer({ onSend, onMentionPicked });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");

    fireEvent.paste(textarea, {
      clipboardData: {
        files: {
          length: 1,
          0: { name: "paper.pdf" },
          item: (index: number) => (index === 0 ? ({ name: "paper.pdf" } as File) : null),
        },
        getData: (type: string) => (type === "text/plain" ? "paper.pdf" : ""),
        items: [{ kind: "file", type: "application/pdf", getAsFile: () => null }],
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Attached file paper.pdf")).toBeTruthy();
    });
    expect(textarea.value).toBe("");
    expect(document.body.textContent).not.toContain("@paper.pdf");
    expect(onMentionPicked).toHaveBeenCalledWith("docs/paper.pdf");

    fireEvent.click(container.querySelector(".send-btn")!);

    expect(onSend).toHaveBeenCalledWith({
      hiddenMentions: ["docs/paper.pdf"],
    });
  });

  it("prefers desktop clipboard file paths over Finder icon image data", async () => {
    const onSend = vi.fn();
    const onMentionPicked = vi.fn();
    const { container } = renderComposer({ onSend, onMentionPicked });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");
    const iconImage = new File([new Uint8Array([1, 2, 3])], "icon.png", { type: "image/png" });

    fireEvent.paste(textarea, {
      clipboardData: {
        files: { length: 0 },
        getData: (type: string) => (type === "text/plain" ? "paper.pdf" : ""),
        items: [{ kind: "string", type: "image/png", getAsFile: () => iconImage }],
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Attached file paper.pdf")).toBeTruthy();
    });
    expect(screen.queryByAltText("pasted image")).toBeNull();
    expect(onMentionPicked).toHaveBeenCalledWith("docs/paper.pdf");

    fireEvent.click(container.querySelector(".send-btn")!);

    expect(onSend).toHaveBeenCalledWith({
      hiddenMentions: ["docs/paper.pdf"],
    });
  });

  it("falls back to desktop clipboard paths when Finder paste exposes only a filename string", async () => {
    const onSend = vi.fn();
    const onMentionPicked = vi.fn();
    const { container } = renderComposer({ onSend, onMentionPicked });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");

    fireEvent.paste(textarea, {
      clipboardData: {
        files: { length: 0 },
        getData: (type: string) => (type === "text/plain" ? "paper.pdf" : ""),
        items: [],
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Attached file paper.pdf")).toBeTruthy();
    });
    expect(textarea.value).toBe("");
    expect(onMentionPicked).toHaveBeenCalledWith("docs/paper.pdf");

    fireEvent.click(container.querySelector(".send-btn")!);

    expect(onSend).toHaveBeenCalledWith({
      hiddenMentions: ["docs/paper.pdf"],
    });
  });

  it("falls back to desktop clipboard paths when WebView exposes only a Files clipboard type", async () => {
    const onSend = vi.fn();
    const onMentionPicked = vi.fn();
    const { container } = renderComposer({ onSend, onMentionPicked });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");

    fireEvent.paste(textarea, {
      clipboardData: {
        files: { length: 0 },
        getData: () => "",
        items: [],
        types: ["Files"],
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Attached file paper.pdf")).toBeTruthy();
    });
    expect(textarea.value).toBe("");
    expect(onMentionPicked).toHaveBeenCalledWith("docs/paper.pdf");

    fireEvent.click(container.querySelector(".send-btn")!);

    expect(onSend).toHaveBeenCalledWith({
      hiddenMentions: ["docs/paper.pdf"],
    });
  });

  it("probes the desktop clipboard when WebView emits an empty paste event", async () => {
    const onSend = vi.fn();
    const onMentionPicked = vi.fn();
    const { container } = renderComposer({ onSend, onMentionPicked });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");

    fireEvent.paste(textarea, {
      clipboardData: {
        files: { length: 0 },
        getData: () => "",
        items: [],
        types: [],
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Attached file paper.pdf")).toBeTruthy();
    });
    expect(textarea.value).toBe("");
    expect(onMentionPicked).toHaveBeenCalledWith("docs/paper.pdf");

    fireEvent.click(container.querySelector(".send-btn")!);

    expect(onSend).toHaveBeenCalledWith({
      hiddenMentions: ["docs/paper.pdf"],
    });
  });

  it("probes the desktop clipboard when WebView exposes only an empty text type", async () => {
    const onSend = vi.fn();
    const onMentionPicked = vi.fn();
    const { container } = renderComposer({ onSend, onMentionPicked });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");

    fireEvent.paste(textarea, {
      clipboardData: {
        files: { length: 0 },
        getData: () => "",
        items: [],
        types: ["text/plain"],
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Attached file paper.pdf")).toBeTruthy();
    });
    expect(textarea.value).toBe("");
    expect(onMentionPicked).toHaveBeenCalledWith("docs/paper.pdf");

    fireEvent.click(container.querySelector(".send-btn")!);

    expect(onSend).toHaveBeenCalledWith({
      hiddenMentions: ["docs/paper.pdf"],
    });
  });

  it("probes the desktop clipboard from Cmd+V when no paste event changes the textarea", async () => {
    const onSend = vi.fn();
    const onMentionPicked = vi.fn();
    const { container } = renderComposer({ onSend, onMentionPicked });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");

    fireEvent.keyDown(textarea, { key: "v", metaKey: true });

    await waitFor(() => {
      expect(screen.getByLabelText("Attached file paper.pdf")).toBeTruthy();
    });
    expect(textarea.value).toBe("");
    expect(onMentionPicked).toHaveBeenCalledWith("docs/paper.pdf");

    fireEvent.click(container.querySelector(".send-btn")!);

    expect(onSend).toHaveBeenCalledWith({
      hiddenMentions: ["docs/paper.pdf"],
    });
  });

  it("keeps filename text when desktop clipboard has no file paths", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    const setDraft = vi.fn();
    const { container } = renderComposer({ setDraft });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");

    fireEvent.paste(textarea, {
      clipboardData: {
        files: { length: 0 },
        getData: (type: string) => (type === "text/plain" ? "paper.pdf" : ""),
        items: [],
      },
    });

    await waitFor(() => {
      expect(setDraft).toHaveBeenCalled();
    });
    const updater = setDraft.mock.calls.at(-1)?.[0] as (current: string) => string;
    expect(updater("")).toBe("paper.pdf");
  });

  it("adds files picked from the plus menu as attachment cards", async () => {
    vi.mocked(openFileDialog).mockResolvedValueOnce("/repo/docs/paper.pdf");
    const onSend = vi.fn();
    const onMentionPicked = vi.fn();
    const { container } = renderComposer({ onSend, onMentionPicked });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");

    fireEvent.click(screen.getByRole("button", { name: "添加上下文" }));
    fireEvent.click(screen.getByRole("button", { name: /添加文件/ }));

    await waitFor(() => {
      expect(screen.getByLabelText("Attached file paper.pdf")).toBeTruthy();
    });
    expect(textarea.value).toBe("");
    expect(document.body.textContent).not.toContain("@docs/paper.pdf");
    expect(onMentionPicked).toHaveBeenCalledWith("docs/paper.pdf");

    fireEvent.click(container.querySelector(".send-btn")!);

    expect(onSend).toHaveBeenCalledWith({
      hiddenMentions: ["docs/paper.pdf"],
    });
  });

  it("adds images picked from the plus menu as thumbnail attachments", async () => {
    vi.mocked(openFileDialog).mockResolvedValueOnce("/repo/images/photo.png");
    const onSend = vi.fn();
    const onMentionPicked = vi.fn();
    const { container } = renderComposer({ onSend, onMentionPicked });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("missing textarea");

    fireEvent.click(screen.getByRole("button", { name: "添加上下文" }));
    fireEvent.click(screen.getByRole("button", { name: /添加文件/ }));

    await waitFor(() => {
      expect(screen.getByAltText("pasted image")).toBeTruthy();
    });
    expect((screen.getByAltText("pasted image") as HTMLImageElement).src).toBe(
      "asset:///repo/images/photo.png",
    );
    expect(textarea.value).toBe("");
    expect(document.body.textContent).not.toContain("@images/photo.png");
    expect(onMentionPicked).toHaveBeenCalledWith("images/photo.png");

    fireEvent.click(container.querySelector(".send-btn")!);

    expect(onSend).toHaveBeenCalledWith({
      hiddenMentions: ["images/photo.png"],
    });
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

  it("keeps hero composer input text left-aligned on the new-chat empty screen", () => {
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    const heroTextareaRule =
      css.match(/\.empty-state \.composer-wrap--hero \.composer textarea \{[\s\S]*?\n\}/)?.[0] ??
      "";
    const heroBackdropRule =
      css.match(
        /\.empty-state \.composer-wrap--hero \.composer-backdrop \{[\s\S]*?\n\}/,
      )?.[0] ?? "";
    const heroTextareaWrapRule =
      css.match(
        /\.empty-state \.composer-wrap--hero \.composer-textarea-wrap \{[\s\S]*?\n\}/,
      )?.[0] ?? "";

    expect(heroTextareaRule).not.toContain("text-align: center");
    expect(heroBackdropRule).not.toContain("align-items: center");
    expect(heroBackdropRule).not.toContain("justify-items: center");
    expect(heroBackdropRule).not.toContain("text-align: center");
    expect(heroTextareaWrapRule).not.toContain("align-items: center");
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

  it("ignores macOS file reference URLs so the desktop backend can resolve them", () => {
    const paths = clipboardFileMentionPaths(
      {
        files: { length: 1 },
        getData: (type: string) =>
          type === "text/uri-list" ? "file:///.file/id=6571367.16939185" : "",
      } as unknown as DataTransfer,
      "/repo",
    );

    expect(paths).toEqual([]);
  });

  it("extracts Tauri clipboard file paths instead of falling back to pasted filenames", () => {
    const paths = clipboardFileMentionPaths(
      {
        files: {
          length: 1,
          0: { name: "paper.pdf", path: "/repo/docs/paper.pdf" },
          item: (index: number) =>
            index === 0
              ? ({ name: "paper.pdf", path: "/repo/docs/paper.pdf" } as unknown as File)
              : null,
        },
        getData: (type: string) => (type === "text/plain" ? "paper.pdf" : ""),
      } as unknown as DataTransfer,
      "/repo",
    );

    expect(paths).toEqual(["docs/paper.pdf"]);
  });

  it("extracts plain-text local paths even when WebView exposes no file list", () => {
    const paths = clipboardFileMentionPaths(
      {
        files: { length: 0 },
        getData: (type: string) =>
          type === "text/plain"
            ? "/repo/docs/paper.pdf\nfile:///repo/docs/hello%20world.md"
            : "",
      } as unknown as DataTransfer,
      "/repo",
    );

    expect(paths).toEqual(["docs/paper.pdf", "docs/hello world.md"]);
  });
});
