// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FilePreviewRenderer, previewRendererKind } from "./file-preview-renderers";

const docxRenderAsync = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("docx-preview", () => ({
  renderAsync: docxRenderAsync,
}));

describe("previewRendererKind", () => {
  it("detects rich preview types by extension", () => {
    expect(previewRendererKind("demo.md")).toBe("markdown");
    expect(previewRendererKind("brief.docx")).toBe("docx");
    expect(previewRendererKind("scan.pdf")).toBe("pdf");
    expect(previewRendererKind("photo.png")).toBe("image");
  });
});

describe("FilePreviewRenderer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    docxRenderAsync.mockClear();
  });

  it("loads docx previews from local bytes instead of fetching the asset URL", async () => {
    const loadBytes = vi.fn(() => Promise.resolve(new Uint8Array([80, 75, 3, 4])));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(
      <FilePreviewRenderer
        path="docs/spec.docx"
        url="asset://localhost/docs/spec.docx"
        text="Extracted text"
        loadBytes={loadBytes}
      />,
    );

    await waitFor(() => expect(loadBytes).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(docxRenderAsync).toHaveBeenCalledTimes(1));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
