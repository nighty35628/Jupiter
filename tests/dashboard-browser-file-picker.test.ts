// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadWebFile } from "../dashboard/src/lib/runtime-transport";

vi.mock("../dashboard/src/lib/runtime-transport", () => ({
  emitRuntimeEvent: vi.fn(),
  getWebWorkspaceChoices: vi.fn(),
  resolveWebWorkspaceFile: vi.fn(),
  uploadWebFile: vi.fn(async (_file: File, name: string) => ({ token: `jupiter-file:${name}` })),
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.mocked(uploadWebFile).mockClear();
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(async () => {
  // Release an old implementation's unresolved picker after a red assertion without leaking a waiter.
  window.dispatchEvent(new Event("focus"));
  await vi.runOnlyPendingTimersAsync();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("browser file picker cancellation", { retry: 0 }, () => {
  it("resolves cancellation once without requiring a window focus event and removes the input/listeners", async () => {
    const { open } = await import("../dashboard/src/lib/shell-services");
    const removeFocus = vi.spyOn(window, "removeEventListener");
    const pending = open({ multiple: true });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const removeInputListener = vi.spyOn(input, "removeEventListener");
    const resolved = vi.fn();
    void pending.then(resolved);
    input.dispatchEvent(new Event("cancel"));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toHaveBeenCalledOnce();
    expect(resolved).toHaveBeenCalledWith([]);
    await expect(pending).resolves.toEqual([]);
    expect(input.isConnected).toBe(false);
    expect(removeFocus).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeInputListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(removeInputListener).toHaveBeenCalledWith("cancel", expect.any(Function));
    input.dispatchEvent(new Event("cancel"));
    input.dispatchEvent(new Event("change"));
    window.dispatchEvent(new Event("focus"));
    await vi.runOnlyPendingTimersAsync();
    expect(resolved).toHaveBeenCalledOnce();
    expect(uploadWebFile).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a scheduled focus fallback instead of retaining a delayed picker completion", async () => {
    const { open } = await import("../dashboard/src/lib/shell-services");
    const pending = open({ multiple: true });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    window.dispatchEvent(new Event("focus"));
    expect(vi.getTimerCount()).toBe(1);
    input.dispatchEvent(new Event("cancel"));
    expect(vi.getTimerCount()).toBe(0);
    await expect(pending).resolves.toEqual([]);
    expect(input.isConnected).toBe(false);
    expect(uploadWebFile).not.toHaveBeenCalled();
  });

  it("opens a fresh picker after cancellation and uploads exactly the newly selected file", async () => {
    const { open } = await import("../dashboard/src/lib/shell-services");
    const first = open({ multiple: true });
    const old = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const cancelled = vi.fn();
    void first.then(cancelled);
    old.dispatchEvent(new Event("cancel"));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toHaveBeenCalledOnce();
    await expect(first).resolves.toEqual([]);
    const next = open({ multiple: true });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input).not.toBe(old);
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
    const file = new File(["synthetic photo bytes"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    await expect(next).resolves.toEqual(["jupiter-file:photo.jpg"]);
    expect(uploadWebFile).toHaveBeenCalledOnce();
    expect(uploadWebFile).toHaveBeenCalledWith(file, "photo.jpg");
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
    input.dispatchEvent(new Event("cancel"));
    old.dispatchEvent(new Event("change"));
    window.dispatchEvent(new Event("focus"));
    await vi.runOnlyPendingTimersAsync();
    expect(uploadWebFile).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
