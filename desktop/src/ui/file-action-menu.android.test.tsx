// @vitest-environment jsdom

import { openPath } from "@tauri-apps/plugin-opener";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { FileActionMenu } from "./file-action-menu";

vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), revealItemInDir: vi.fn() }));

beforeEach(() => {
  setLang("en");
  document.documentElement.dataset.hostPlatform = "android";
  vi.mocked(openPath).mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.hostPlatform;
});

function show(path = "/workspace/report.pdf") {
  const props = {
    anchor: { left: 20, top: 20 },
    path,
    workspaceDir: "/workspace",
    onClose: vi.fn(),
    onPreviewFile: vi.fn(),
    onOpenHtmlFile: vi.fn(),
  };
  render(<FileActionMenu {...props} />);
  return props;
}

describe("Android FileActionMenu", { retry: 0 }, () => {
  it("offers Save File separately from Preview and hides unsupported desktop actions", () => {
    show();
    expect(screen.queryByRole("button", { name: "Save File" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reveal in folder" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open with…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open in default app" })).toBeNull();
  });

  it("saves HTML without routing the save action into HTML preview", async () => {
    const props = show("/workspace/report.html");
    const save = screen.queryByRole("button", { name: "Save File" });
    expect(save).not.toBeNull();
    await act(async () => {
      fireEvent.click(save!);
    });
    expect(openPath).toHaveBeenCalledWith("/workspace/report.html");
    expect(props.onOpenHtmlFile).not.toHaveBeenCalled();
    expect(props.onPreviewFile).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("keeps export errors visible and allows an explicit retry", async () => {
    vi.mocked(openPath).mockRejectedValueOnce(new Error("outside authorized workspace"));
    const props = show();
    const save = screen.queryByRole("button", { name: "Save File" });
    expect(save).not.toBeNull();
    await act(async () => {
      fireEvent.click(save!);
    });
    expect(screen.getByRole("alert").textContent).toContain("outside authorized workspace");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(openPath).toHaveBeenCalledOnce();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save File" }));
    });
    expect(openPath).toHaveBeenCalledTimes(2);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("keeps Preview independent from export", () => {
    const props = show("/workspace/report.html");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(props.onPreviewFile).toHaveBeenCalledWith({
      path: "/workspace/report.html",
      line: undefined,
    });
    expect(openPath).not.toHaveBeenCalled();
  });

  it.each([
    ["docs/report.pdf", "/workspace/docs/report.pdf"],
    [
      "jupiter-file:12345678-1234-4123-8123-123456789abc",
      "jupiter-file:12345678-1234-4123-8123-123456789abc",
    ],
  ])("resolves workspace paths but preserves file tokens (%s)", async (path, expected) => {
    show(path);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save File" }));
    });
    expect(openPath).toHaveBeenCalledWith(expected);
  });

  it("waits for Native save completion and prevents duplicate export requests", async () => {
    let finish!: () => void;
    vi.mocked(openPath).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const props = show();
    await act(async () => {
      const save = screen.getByRole("button", { name: "Save File" });
      fireEvent.click(save);
      fireEvent.click(save);
    });
    expect(openPath).toHaveBeenCalledOnce();
    expect(
      (screen.getByRole("button", { name: "Saving File…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => {
      finish();
    });
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("shows cancellation without treating it as an error or retrying automatically", async () => {
    vi.mocked(openPath).mockRejectedValueOnce(new DOMException("Export cancelled", "AbortError"));
    const props = show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save File" }));
    });
    expect(screen.getByRole("status").textContent).toBe("Save cancelled.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(openPath).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Save File" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("preserves Web actions including the HTML-open shortcut", () => {
    document.documentElement.dataset.hostPlatform = "browser";
    const props = show("/workspace/report.html");
    expect(screen.getByRole("button", { name: "Reveal in folder" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open with…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open in default app" }));
    expect(props.onOpenHtmlFile).toHaveBeenCalledWith({
      path: "/workspace/report.html",
      line: undefined,
    });
    expect(openPath).not.toHaveBeenCalled();
  });
});
