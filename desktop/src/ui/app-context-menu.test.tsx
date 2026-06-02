// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

import {
  contextMenuItemKinds,
  getContextMenuDetails,
  positionAppContextMenu,
} from "./app-context-menu";

describe("positionAppContextMenu", () => {
  it("keeps the menu visible near the right and bottom edges", () => {
    expect(
      positionAppContextMenu(
        { left: 770, top: 570 },
        { width: 220, height: 190 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ left: 572, top: 402 });
  });
});

describe("getContextMenuDetails", () => {
  it("detects editable targets and exposes edit actions", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "hello Jupiter";
    textarea.setSelectionRange(0, 5);

    const details = getContextMenuDetails(textarea, "");

    expect(details.editable).toBe(textarea);
    expect(details.editableSelection).toBe("hello");
    expect(contextMenuItemKinds(details, true)).toEqual(["copy", "cut", "paste", "selectAll"]);
  });

  it("does not offer mutating edit actions for readonly inputs", () => {
    const input = document.createElement("input");
    input.value = "locked";
    input.readOnly = true;
    input.setSelectionRange(0, 6);

    expect(contextMenuItemKinds(getContextMenuDetails(input, ""), true)).toEqual([
      "copy",
      "selectAll",
    ]);
  });

  it("detects file and link targets from the closest element", () => {
    const link = document.createElement("a");
    link.href = "https://example.com/docs";
    link.dataset.jupiterFilePath = "docs/guide.md";
    link.dataset.jupiterFileLine = "12";
    const nested = document.createElement("span");
    link.append(nested);

    const details = getContextMenuDetails(nested, "");

    expect(details.link?.href).toBe("https://example.com/docs");
    expect(details.file).toEqual({ path: "docs/guide.md", line: "12" });
    expect(contextMenuItemKinds(details, true)).toEqual([
      "previewFile",
      "openFile",
      "revealFile",
      "openWith",
      "copyFilePath",
      "openLink",
      "copyLink",
    ]);
  });
});
