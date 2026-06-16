// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MermaidBlock, setMermaidLoaderForTest } from "./mermaid-renderer";

const renderMock = vi.fn();
const initializeMock = vi.fn();

describe("MermaidBlock", () => {
  beforeEach(() => {
    renderMock.mockReset();
    initializeMock.mockReset();
    setMermaidLoaderForTest(() =>
      Promise.resolve({
        default: {
          initialize: initializeMock,
          render: renderMock,
        },
      }),
    );
  });

  it("renders sanitized mermaid svg output", async () => {
    renderMock.mockResolvedValue({
      svg: '<svg><script>alert(1)</script><g onclick="alert(2)"><text>Flow</text></g></svg>',
    });

    const { container } = render(<MermaidBlock source="graph TD; A-->B" idSeed="diagram-1" />);

    await waitFor(() => expect(screen.getByText("Flow")).toBeTruthy());
    expect(initializeMock).toHaveBeenCalledWith({ securityLevel: "strict", startOnLoad: false });
    expect(container.innerHTML).not.toContain("<script");
    expect(container.innerHTML).not.toContain("onclick");
  });

  it("falls back to source text when rendering fails", async () => {
    renderMock.mockRejectedValue(new Error("bad diagram"));

    render(<MermaidBlock source="not valid" idSeed="diagram-2" />);

    await waitFor(() => expect(screen.getByText(/Mermaid render failed/i)).toBeTruthy());
    expect(screen.getByText("not valid")).toBeTruthy();
  });
});
