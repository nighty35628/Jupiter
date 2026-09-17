// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageAttachmentView } from "./image-attachments";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.runtime;
});

it("closes the image preview with Escape without invoking global task shortcuts", async () => {
  document.documentElement.dataset.runtime = "web";
  const image = {
    kind: "image" as const,
    id: "a".repeat(64),
    name: "sample.png",
    mime: "image/png" as const,
    width: 2,
    height: 1,
    bytes: 12,
  };
  const { container } = render(<ImageAttachmentView image={image} />);
  const dialog = container.querySelector("dialog")!;
  dialog.showModal = vi.fn(() => dialog.setAttribute("open", ""));
  dialog.close = vi.fn(() => dialog.removeAttribute("open"));
  fireEvent.click(container.querySelector(".image-attachment-preview")!);
  await waitFor(() =>
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(`/api/images/${image.id}`),
  );
  const globalShortcut = vi.fn();
  window.addEventListener("keydown", globalShortcut);
  try {
    fireEvent.keyDown(screen.getByRole("dialog", { name: "sample.png" }).querySelector("button")!, {
      key: "Escape",
    });
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(globalShortcut).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("keydown", globalShortcut);
  }
});
