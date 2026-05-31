// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

import { Markdown, WorkspaceProvider } from "./Markdown";

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
});
