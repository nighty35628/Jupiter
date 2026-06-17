// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

import { Markdown, WorkspaceProvider } from "./Markdown";
import { openUrl } from "@tauri-apps/plugin-opener";

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn() },
    configurable: true,
  });
});
afterEach(cleanup);

describe("Markdown", () => {
  it("wraps tables in a horizontal scroll container", () => {
    const { container } = render(
      <Markdown
        source={`| A | B | C | D |
| - | - | - | - |
| 1 | 2 | 3 | 4 |`}
      />,
    );

    const wrap = container.querySelector(".markdown-table-wrap");
    expect(wrap).toBeTruthy();
    expect(wrap?.querySelector("table")).toBeTruthy();
  });

  it("turns document paths into previewable file pills", () => {
    const onPreviewFile = vi.fn();
    render(
      <WorkspaceProvider value={{ dir: "/repo", onPreviewFile } as never}>
        <Markdown source="更新完成：docs/spec.docx" />
      </WorkspaceProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "docs/spec.docx" }));

    expect(onPreviewFile).toHaveBeenCalledWith({ path: "docs/spec.docx", line: undefined });
  });

  it("turns unicode filenames in inline code into previewable file links", () => {
    const onPreviewFile = vi.fn();
    render(
      <WorkspaceProvider value={{ dir: "/repo", onPreviewFile } as never}>
        <Markdown source="已生成第二版 `AI画PCB可行性调研报告.pptx`！" />
      </WorkspaceProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "AI画PCB可行性调研报告.pptx" }));

    expect(onPreviewFile).toHaveBeenCalledWith({
      path: "AI画PCB可行性调研报告.pptx",
      line: undefined,
    });
  });

  it("opens external links through the workspace browser callback", () => {
    const onOpenBrowserUrl = vi.fn();
    render(
      <WorkspaceProvider value={{ onOpenBrowserUrl }}>
        <Markdown source="[OpenAI](https://openai.com/docs)" />
      </WorkspaceProvider>,
    );

    fireEvent.click(screen.getByRole("link", { name: /OpenAI/ }));

    expect(onOpenBrowserUrl).toHaveBeenCalledWith("https://openai.com/docs");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("renders unsafe links inert", () => {
    const onOpenBrowserUrl = vi.fn();
    render(
      <WorkspaceProvider value={{ onOpenBrowserUrl }}>
        <Markdown source="[bad](javascript:alert(1))" />
      </WorkspaceProvider>,
    );

    const link = screen.getByRole("link", { name: /bad/ });
    expect(link.getAttribute("href")).toBe("#");
    fireEvent.click(link);

    expect(onOpenBrowserUrl).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("routes fenced mermaid blocks to the diagram renderer", () => {
    const { container } = render(
      <Markdown
        source={`\`\`\`mermaid
graph TD
  A --> B
\`\`\``}
      />,
    );

    expect(container.querySelector(".mermaid-block")).toBeTruthy();
  });

  it("opens html file pills through the workspace browser callback", () => {
    const onOpenHtmlFile = vi.fn();
    const onPreviewFile = vi.fn();
    render(
      <WorkspaceProvider value={{ dir: "/repo", onOpenHtmlFile, onPreviewFile }}>
        <Markdown source="打开 reports/index.html" />
      </WorkspaceProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "reports/index.html" }));

    expect(onOpenHtmlFile).toHaveBeenCalledWith({ path: "reports/index.html", line: undefined });
    expect(onPreviewFile).not.toHaveBeenCalled();
  });

  it("opens a file actions menu from a file pill", () => {
    render(
      <WorkspaceProvider value={{ dir: "/repo" }}>
        <Markdown source="查看 docs/spec.docx" />
      </WorkspaceProvider>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "docs/spec.docx" }));

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reveal in folder" })).toBeTruthy();
  });

  it("does not render a separate file dropdown button", () => {
    const { container } = render(
      <WorkspaceProvider value={{ dir: "/repo" }}>
        <Markdown source="查看 docs/spec.docx" />
      </WorkspaceProvider>,
    );

    expect(container.querySelector(".file-pill-menu-btn")).toBeNull();
    expect(screen.getByRole("button", { name: "docs/spec.docx" })).toBeTruthy();
  });
});
