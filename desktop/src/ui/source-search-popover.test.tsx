// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { SourceSearchPopover } from "./source-search-popover";

afterEach(cleanup);

describe("SourceSearchPopover", () => {
  beforeEach(() => {
    setLang("en");
  });

  it("searches, opens web results in the built-in browser, and adds them", () => {
    const onSourceSearch = vi.fn();
    const onOpenWebSource = vi.fn();
    const onAddSource = vi.fn();
    render(
      <SourceSearchPopover
        open
        sources={[]}
        sourceSearch={{
          type: "$source_search_results",
          nonce: 1,
          query: "NotebookLM",
          results: [
            {
              kind: "web",
              title: "NotebookLM",
              url: "https://notebooklm.google/",
              snippet: "AI notebook source grounding.",
            },
          ],
        }}
        onClose={vi.fn()}
        onSourceSearch={onSourceSearch}
        onAddSource={onAddSource}
        onOpenWebSource={onOpenWebSource}
        onPreviewFileSource={vi.fn()}
        onRevealFileSource={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Search web or saved sources…"), {
      target: { value: "NotebookLM" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(onSourceSearch).toHaveBeenCalledWith("NotebookLM", expect.any(Number), 6);

    fireEvent.click(screen.getByRole("button", { name: "Open source: NotebookLM" }));
    expect(onOpenWebSource).toHaveBeenCalledWith("https://notebooklm.google/");

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onAddSource).toHaveBeenCalledWith({
      kind: "web",
      title: "NotebookLM",
      url: "https://notebooklm.google/",
      snippet: "AI notebook source grounding.",
    });
  });

  it("loads more web results by asking for a larger result set", () => {
    const onSourceSearch = vi.fn();
    render(
      <SourceSearchPopover
        open
        sources={[]}
        sourceSearch={{
          type: "$source_search_results",
          nonce: 1,
          query: "NotebookLM",
          results: [
            {
              kind: "web",
              title: "NotebookLM",
              url: "https://notebooklm.google/",
              snippet: "",
            },
          ],
        }}
        onClose={vi.fn()}
        onSourceSearch={onSourceSearch}
        onAddSource={vi.fn()}
        onOpenWebSource={vi.fn()}
        onPreviewFileSource={vi.fn()}
        onRevealFileSource={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Search web or saved sources…"), {
      target: { value: "NotebookLM" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(onSourceSearch).toHaveBeenNthCalledWith(
      2,
      "NotebookLM",
      expect.any(Number),
      10,
    );
  });

  it("searches saved web sources from the local library", () => {
    const onOpenWebSource = vi.fn();
    render(
      <SourceSearchPopover
        open
        sources={[
          {
            id: "saved-web-1",
            kind: "web",
            title: "Saved NotebookLM",
            url: "https://notebooklm.google/",
            snippet: "Saved source grounding.",
            addedAt: 1,
          },
        ]}
        sourceSearch={{
          type: "$source_search_results",
          nonce: 1,
          query: "notebook",
          results: [],
        }}
        onClose={vi.fn()}
        onSourceSearch={vi.fn()}
        onAddSource={vi.fn()}
        onOpenWebSource={onOpenWebSource}
        onPreviewFileSource={vi.fn()}
        onRevealFileSource={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Search web or saved sources…"), {
      target: { value: "notebook" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    fireEvent.click(screen.getByRole("button", { name: "Open source: Saved NotebookLM" }));

    expect(onOpenWebSource).toHaveBeenCalledWith("https://notebooklm.google/");
  });

  it("searches saved web sources by ingested page text", () => {
    const onOpenWebSource = vi.fn();
    render(
      <SourceSearchPopover
        open
        sources={[
          {
            id: "saved-web-1",
            kind: "web",
            title: "Saved Source",
            url: "https://example.com/research",
            snippet: "Short search snippet.",
            contentText: "The page body discusses neural grounding and citations.",
            addedAt: 1,
          } as any,
        ]}
        sourceSearch={{
          type: "$source_search_results",
          nonce: 1,
          query: "neural grounding",
          results: [],
        }}
        onClose={vi.fn()}
        onSourceSearch={vi.fn()}
        onAddSource={vi.fn()}
        onOpenWebSource={onOpenWebSource}
        onPreviewFileSource={vi.fn()}
        onRevealFileSource={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Search web or saved sources…"), {
      target: { value: "neural grounding" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    fireEvent.click(screen.getByRole("button", { name: "Open source: Saved Source" }));

    expect(onOpenWebSource).toHaveBeenCalledWith("https://example.com/research");
  });

  it("does not show workspace file results", () => {
    const onPreviewFileSource = vi.fn();
    render(
      <SourceSearchPopover
        open
        sources={[]}
        sourceSearch={null}
        onClose={vi.fn()}
        onSourceSearch={vi.fn()}
        onAddSource={vi.fn()}
        onOpenWebSource={vi.fn()}
        onPreviewFileSource={onPreviewFileSource}
        onRevealFileSource={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Search web or saved sources…"), {
      target: { value: "notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.queryByText("docs/notes.md")).toBeNull();
    expect(onPreviewFileSource).not.toHaveBeenCalled();
  });
});
