// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePromptPrediction } from "./use-prompt-prediction";
import type { OutgoingCommand } from "./protocol";

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  document.documentElement.dataset.nativeWindow = "true";
  delete document.documentElement.dataset.runtime;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function fixture(overrides: Partial<Parameters<typeof usePromptPrediction>[0]> = {}) {
  const send = vi.fn(async (_command: OutgoingCommand) => undefined);
  const clear = vi.fn();
  const props = { candidate: { completionId: "id", text: "Run the tests." }, active: true, ready: true, busy: false,
    enabled: true, blocked: false, hasDraft: false, transportAvailable: true, send, clear, ...overrides };
  return { ...renderHook((value) => usePromptPrediction(value), { initialProps: props }), props, send, clear };
}

describe("prediction frontend lifecycle", { retry: 0 }, () => {
  it("discloses cost before the first request and requests only once", async () => {
    const f = fixture();
    expect(f.result.current.notice).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
    act(() => f.result.current.markNoticeSeen());
    expect(f.result.current.notice).toBe(true);
    await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    f.rerender({ ...f.props });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("does not revive after typing and clearing the draft", () => {
    const f = fixture();
    f.rerender({ ...f.props, hasDraft: true });
    expect(f.clear).toHaveBeenCalledOnce();
    f.rerender({ ...f.props, hasDraft: false });
    expect(f.result.current.prediction).toBeUndefined();
    expect(f.send.mock.calls.every(([command]) => command.cmd !== "prompt_prediction_get")).toBe(true);
  });

  it("does not let a late failure of A dismiss a newer completion B", async () => {
    let reject!: (error: Error) => void;
    const send = vi.fn((_command: OutgoingCommand) => new Promise<void>((_, no) => { reject = no; }));
    const f = fixture({ send });
    act(() => f.result.current.markNoticeSeen());
    const rejectA = reject;
    f.rerender({ ...f.props, candidate: { completionId: "B", text: "New suggestion" } });
    await act(async () => rejectA(new Error("old request failed")));
    expect(f.clear).not.toHaveBeenCalled();
    expect(f.result.current.prediction?.id).toBe("B");
    expect(send.mock.calls.some(([command]) => command.cmd === "prompt_prediction_dismiss")).toBe(false);
  });

  it("invalidates on backgrounding, task start and disconnect", () => {
    for (const patch of [{ active: false }, { busy: true }, { transportAvailable: false }]) {
      const f = fixture();
      f.rerender({ ...f.props, ...patch });
      f.rerender(f.props);
      expect(f.result.current.prediction).toBeUndefined();
      f.unmount();
    }
  });

  it("does not let a read-only Web observer initiate predictions", () => {
    document.documentElement.dataset.nativeWindow = "false";
    document.documentElement.dataset.runtime = "web";
    document.documentElement.dataset.webWriter = "false";
    const f = fixture();
    act(() => f.result.current.markNoticeSeen());
    expect(f.send).not.toHaveBeenCalled();
    expect(f.result.current.prediction).toBeUndefined();
  });

  it("hides a ready suggestion when writer control is lost", () => {
    const f = fixture();
    act(() => window.dispatchEvent(new CustomEvent("jupiter:web-writer", { detail: { writable: false } })));
    expect(f.result.current.prediction).toBeUndefined();
  });

  it("keeps settings and confirmation overlays from displaying or requesting predictions", () => {
    const f = fixture({ blocked: true });
    act(() => f.result.current.markNoticeSeen());
    expect(f.result.current.prediction).toBeUndefined();
    expect(f.send).not.toHaveBeenCalled();
  });
});
