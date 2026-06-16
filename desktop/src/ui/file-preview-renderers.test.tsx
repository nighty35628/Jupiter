// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FilePreviewRenderer, previewRendererKind } from "./file-preview-renderers";

describe("file-preview-renderers", () => {
  it("selects rich preview renderers by extension and mime", () => {
    expect(previewRendererKind("paper.pdf")).toBe("pdf");
    expect(previewRendererKind("paper.bin", "application/pdf")).toBe("pdf");
    expect(previewRendererKind("brief.docx")).toBe("docx");
    expect(
      previewRendererKind(
        "brief.bin",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("docx");
    expect(previewRendererKind("legacy.doc")).toBe("unsupported");
    expect(previewRendererKind("README.md")).toBe("markdown");
    expect(previewRendererKind("notes.txt")).toBe("text");
    expect(previewRendererKind("image.png", "image/png")).toBe("image");
  });

  it("keeps renderer loading lazy and shows a bounded shell", () => {
    render(<FilePreviewRenderer path="paper.pdf" url="file:///tmp/paper.pdf" />);
    expect(screen.getByText(/PDF preview/i)).toBeTruthy();
    expect(screen.getByText(/Loading/i)).toBeTruthy();
  });

  it("renders text directly and unsupported documents explicitly", () => {
    const { rerender } = render(
      <FilePreviewRenderer path="notes.txt" url="file:///tmp/notes.txt" text="hello" />,
    );
    expect(screen.getByText("hello")).toBeTruthy();

    rerender(<FilePreviewRenderer path="legacy.doc" url="file:///tmp/legacy.doc" />);
    expect(screen.getByText(/not supported/i)).toBeTruthy();
  });

  it("prefers rich docx rendering even when extracted text exists", () => {
    render(
      <FilePreviewRenderer
        path="brief.docx"
        url="file:///tmp/brief.docx"
        text="Extracted fallback text"
      />,
    );

    expect(screen.getByText(/Loading DOCX preview/i)).toBeTruthy();
    expect(screen.queryByText("Extracted fallback text")).toBeNull();
  });

  it("renders markdown text through Markdown", () => {
    render(
      <FilePreviewRenderer
        path="README.md"
        url="file:///tmp/README.md"
        text={"# Title\n\n**bold**"}
      />,
    );

    expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy();
    expect(screen.getByText("bold").tagName.toLowerCase()).toBe("strong");
  });
});
