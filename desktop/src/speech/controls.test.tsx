// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { SpeechButton, SpeechStatus } from "./controls";
import type { SpeechUi } from "./use-speech-draft";
import { SpeechSettings } from "./settings";
import { speechCapabilities } from "./host";
import { invoke } from "@tauri-apps/api/core";
vi.mock("./host", async importOriginal => ({
  ...await importOriginal<typeof import("./host")>(),
  hasSpeechHost: () => true,
  speechCapabilities: vi.fn(),
}));
beforeEach(() => { setLang("en"); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const caps = { available: true, backend: "whisper" as const, localAvailable: true, networkAvailable: false,
  autoLanguage: true, modelReady: true, modelBytes: 147951465 };
function speech(patch: Partial<SpeechUi> = {}): SpeechUi {
  return { phase: "idle", preview: "", candidate: "", error: "", capabilities: caps,
    language: "en", pending: false, toggle: vi.fn(async () => {}), cancel: vi.fn(), insert: vi.fn(),
    discard: vi.fn(), onComposition: vi.fn(), ...patch };
}
describe("voice controls", { retry: 0 }, () => {
  it("has a separate accessible finish/cancel control and never a send action", () => {
    const state = speech({ phase: "recording", pending: true });
    render(<><SpeechButton speech={state} /><SpeechStatus speech={state} /></>);
    fireEvent.click(screen.getByRole("button", { name: "Finish dictation" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
    expect(state.toggle).toHaveBeenCalledOnce();
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });
  it("hides the microphone without an available native capability", () => {
    render(<SpeechButton speech={speech({ capabilities: null })} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("offers insertion only for a conflicting result", () => {
    const state = speech({ candidate: "recovered words" });
    render(<SpeechStatus speech={state} />);
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(state.insert).toHaveBeenCalledOnce();
  });
  it("keeps recognition language independent of UI language", async () => {
    vi.mocked(speechCapabilities).mockResolvedValue(caps);
    render(<SpeechSettings />);
    fireEvent.change(await screen.findByLabelText("Recognition language"), { target: { value: "ja" } });
    expect(localStorage.getItem("jupiter.speech.language")).toBe("ja");
    expect(screen.getByText("Voice input")).toBeTruthy();
  });
  it("requires explicit consent before downloading", async () => {
    vi.mocked(speechCapabilities).mockResolvedValue({ ...caps, modelReady: false });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const before = vi.mocked(invoke).mock.calls.length;
    render(<SpeechSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Download model" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(vi.mocked(invoke).mock.calls.slice(before).some(([command]) => command === "speech_download_model")).toBe(false);
  });
  it("does not offer Auto for an Android service without automatic switching", async () => {
    vi.mocked(speechCapabilities).mockResolvedValue({ ...caps, backend: "android", autoLanguage: false, networkAvailable: true });
    render(<SpeechSettings />);
    await waitFor(() => expect(screen.getByLabelText("Recognition language")).toBeTruthy());
    expect(screen.queryByRole("option", { name: "Automatic" })).toBeNull();
    await act(async () => fireEvent.change(screen.getByLabelText("Recognition mode"), { target: { value: "system" } }));
    expect(screen.getByText(/may send audio to its provider/)).toBeTruthy();
  });
  it("does not poll native capabilities while no download is active", async () => {
    vi.useFakeTimers();
    vi.mocked(speechCapabilities).mockClear().mockResolvedValue(caps);
    await act(async () => { render(<SpeechSettings />); });
    expect(speechCapabilities).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(speechCapabilities).toHaveBeenCalledOnce();
  });
  it("does not let an older download completion invalidate the remove status", async () => {
    const missing = { ...caps, modelReady: false };
    let finishDownload!: () => void;
    let finishStatus!: (value: typeof missing) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<void>(resolve => { finishDownload = resolve; }))
      .mockResolvedValueOnce(undefined);
    vi.mocked(speechCapabilities).mockReset().mockResolvedValue(missing)
      .mockResolvedValueOnce(missing)
      .mockImplementationOnce(() => new Promise(resolve => { finishStatus = resolve; }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SpeechSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Download model" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel dictation" }));
    await waitFor(() => expect(finishStatus).toBeTypeOf("function"));
    await act(async () => { finishDownload(); });
    await act(async () => { finishStatus(missing); });
    expect(screen.queryByRole("button", { name: "Download model" })).toBeTruthy();
    expect(speechCapabilities).toHaveBeenCalledTimes(2);
  });
  it("shows bounded model download progress", async () => {
    vi.mocked(speechCapabilities).mockResolvedValue({ ...caps, modelReady: false, modelDownloading: true, modelProgress: 0.4 });
    render(<SpeechSettings />);
    const progress = await screen.findByRole("progressbar", { name: "Downloading model" });
    expect(progress.getAttribute("value")).toBe("0.4");
    expect(progress.getAttribute("max")).toBe("1");
  });
});
