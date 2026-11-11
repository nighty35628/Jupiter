// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readImageDraft, writeImageDraft } from "../ui/image-draft-store";
import type { SpeechEvent } from "./controller";
import { useSpeechDraft, cancelSpeechDraft } from "./use-speech-draft";
import { speechHost, speechCapabilities } from "./host";

const fake = vi.hoisted(() => ({ receive: (_event: SpeechEvent) => {}, id: "" }));
vi.mock("./host", () => ({
  hasSpeechHost: () => true, readSpeechLanguage: () => "en", readSpeechMode: () => "local",
  speechCapabilities: vi.fn(async () => ({ available: true, modelReady: true, autoLanguage: true, localAvailable: true })),
  speechHost: {
    listen: vi.fn(async (callback: (event: SpeechEvent) => void) => { fake.receive = callback; return () => {}; }),
    start: vi.fn(async (id: string) => { fake.id = id; }),
    finish: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
  },
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("speech with the actual draft store", { retry: 0 }, () => {
  it("preserves attachments and detects ABA text changes", async () => {
    const key = crypto.randomUUID();
    writeImageDraft(key, draft => ({ ...draft, text: "original", shareIntakeIds: ["receipt"] }));
    const textarea = createRef<HTMLTextAreaElement>();
    const { result } = renderHook(() => useSpeechDraft(key, true, true, textarea));
    await waitFor(() => expect(result.current.capabilities).not.toBeNull());
    await act(() => result.current.toggle());
    act(() => {
      writeImageDraft(key, draft => ({ ...draft, text: "changed" }));
      writeImageDraft(key, draft => ({ ...draft, text: "original" }));
      fake.receive({ sessionId: fake.id, state: "result", text: "new" });
    });
    expect(readImageDraft(key).text).toBe("original");
    expect(readImageDraft(key).shareIntakeIds).toEqual(["receipt"]);
    expect(result.current.candidate).toBe("new");
  });
  it("invalidates same-tab session rebindings before late results", async () => {
    const first = crypto.randomUUID(), next = crypto.randomUUID();
    const textarea = createRef<HTMLTextAreaElement>();
    const { result, rerender } = renderHook(({ key }) => useSpeechDraft(key, true, true, textarea), { initialProps: { key: first } });
    await waitFor(() => expect(result.current.capabilities).not.toBeNull());
    await act(() => result.current.toggle());
    const oldReceive = fake.receive, oldId = fake.id;
    rerender({ key: next });
    act(() => oldReceive({ sessionId: oldId, state: "result", text: "wrong" }));
    expect(readImageDraft(first).text).toBe("");
    expect(readImageDraft(next).text).toBe("");
  });
  it("cancel at send or enqueue discards any future result", async () => {
    const key = crypto.randomUUID(), textarea = createRef<HTMLTextAreaElement>();
    const { result } = renderHook(() => useSpeechDraft(key, true, true, textarea));
    await waitFor(() => expect(result.current.capabilities).not.toBeNull());
    await act(() => result.current.toggle());
    const id = fake.id;
    act(() => {
      cancelSpeechDraft(key);
      fake.receive({ sessionId: id, state: "result", text: "late" });
    });
    expect(readImageDraft(key).text).toBe("");
    expect(speechHost.cancel).toHaveBeenCalledWith(id);
  });
  it("invalidates a reset binding even when the new-tab draft key stays the same", async () => {
    const key = crypto.randomUUID(), textarea = createRef<HTMLTextAreaElement>();
    const { result, rerender } = renderHook(({ binding }) => useSpeechDraft(key, true, true, textarea, binding), { initialProps: { binding: 1 } });
    await waitFor(() => expect(result.current.capabilities).not.toBeNull());
    await act(() => result.current.toggle());
    const receive = fake.receive, id = fake.id;
    rerender({ binding: 2 });
    act(() => receive({ sessionId: id, state: "result", text: "old binding" }));
    expect(readImageDraft(key).text).toBe("");
  });
  it("resets IME ownership when the composer is rebound", async () => {
    const textarea = createRef<HTMLTextAreaElement>();
    const { result, rerender } = renderHook(({ key }) => useSpeechDraft(key, true, true, textarea), { initialProps: { key: crypto.randomUUID() } });
    await waitFor(() => expect(result.current.capabilities).not.toBeNull());
    result.current.onComposition(true);
    rerender({ key: crypto.randomUUID() });
    vi.mocked(speechHost.start).mockClear();
    await act(() => result.current.toggle());
    expect(speechHost.start).toHaveBeenCalledOnce();
  });
  it("ignores an older capability reply after newer settings refresh", async () => {
    let older!: (value: never) => void;
    vi.mocked(speechCapabilities).mockImplementationOnce(() => new Promise(resolve => { older = resolve; }));
    const textarea = createRef<HTMLTextAreaElement>();
    const { result } = renderHook(() => useSpeechDraft("status-race", true, true, textarea));
    act(() => window.dispatchEvent(new Event("jupiter:speech-settings")));
    await waitFor(() => expect(result.current.capabilities?.modelReady).toBe(true));
    await act(async () => older({ available: true, modelReady: false } as never));
    expect(result.current.capabilities?.modelReady).toBe(true);
  });
});
