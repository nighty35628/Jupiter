// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../i18n";
import type { OutgoingCommand } from "../protocol";
import { usePromptPrediction } from "../use-prompt-prediction";
import { Composer } from "./composer";
import * as imageAttachments from "./image-attachments";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

type Props = Partial<React.ComponentProps<typeof Composer>>;

function setup(initial: Props = {}, strict = false) {
  let props = initial;
  const textareaRef = createRef<HTMLTextAreaElement>();
  const onSend = vi.fn();
  const onHistoryPush = vi.fn();
  const onPredictionAccept = vi.fn();
  const onPredictionDismiss = vi.fn();
  const onPredictionUnavailable = vi.fn();
  function Harness() {
    const [draft, setDraft] = useState("");
    return <Composer
      draft={draft} setDraft={setDraft} onSend={onSend} onAbort={vi.fn()}
      modelLabel="deepseek-v4-flash" reasoningEffort="high" editMode="review"
      onModelChange={vi.fn()} onEffortChange={vi.fn()} onEditModeChange={vi.fn()}
      textareaRef={textareaRef} slashCommands={[]}
      prediction={{ id: "turn-1", text: "Explain the next step." }}
      onPredictionAccept={onPredictionAccept} onPredictionDismiss={onPredictionDismiss}
      onPredictionUnavailable={onPredictionUnavailable} onHistoryPush={onHistoryPush}
      {...props}
    />;
  }
  const tree = () => strict ? <StrictMode><Harness /></StrictMode> : <Harness />;
  const view = render(tree());
  return {
    ...view, textarea: textareaRef.current!, onSend, onHistoryPush,
    onPredictionAccept, onPredictionDismiss, onPredictionUnavailable,
    update(next: Props) { props = { ...props, ...next }; view.rerender(tree()); },
  };
}

function mockFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  return () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}

beforeEach(() => setLang("en"));
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
  delete document.documentElement.dataset.nativeWindow;
});

describe("Composer prompt predictions", () => {
  it("shows a separate ghost without modifying the draft, height, or history", () => {
    const view = setup({ prediction: undefined });
    const height = view.textarea.style.height;
    view.update({ prediction: { id: "turn-1", text: "Long line\n".repeat(24) } });
    const ghost = view.container.querySelector(".composer-prediction");
    expect(ghost?.parentElement).toBe(view.textarea.parentElement);
    expect(ghost?.textContent).toBe("Long line\n".repeat(24));
    expect(view.textarea.value).toBe("");
    expect(view.textarea.placeholder).toBe("");
    expect(view.textarea.style.height).toBe(height);
    expect(view.onHistoryPush).not.toHaveBeenCalled();
    expect(view.onPredictionUnavailable).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Accept suggestion" }).title).toContain("Long line\n".repeat(24));
  });

  it("accepts the full text with Tab into the draft without sending or storing history", () => {
    const text = "word ".repeat(48);
    const view = setup({ prediction: { id: "turn-1", text } });
    expect(fireEvent.keyDown(view.textarea, { key: "Tab" })).toBe(false);
    expect(view.textarea.value).toBe(text);
    expect(view.onPredictionAccept).toHaveBeenCalledOnce();
    expect(view.onSend).not.toHaveBeenCalled();
    expect(view.onHistoryPush).not.toHaveBeenCalled();
    expect(view.onPredictionUnavailable).not.toHaveBeenCalled();
    expect(view.onPredictionDismiss).not.toHaveBeenCalled();
  });

  it("accepts via an accessible icon button and restores textarea focus", () => {
    const view = setup();
    const button = screen.getByRole("button", { name: "Accept suggestion" });
    button.focus();
    fireEvent.click(button);
    expect(view.textarea.value).toBe("Explain the next step.");
    expect(document.activeElement).toBe(view.textarea);
    expect(view.onPredictionAccept).toHaveBeenCalledOnce();
    expect(view.onSend).not.toHaveBeenCalled();
  });

  it.each([{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }])(
    "leaves modified Tab alone: %j", (modifiers) => {
      const view = setup();
      expect(fireEvent.keyDown(view.textarea, { key: "Tab", ...modifiers })).toBe(true);
      expect(view.textarea.value).toBe("");
      expect(view.onPredictionAccept).not.toHaveBeenCalled();
    },
  );

  it.each([{ isComposing: true }, { keyCode: 229 }])("rejects IME Tab: %j", (ime) => {
    const view = setup();
    fireEvent.keyDown(view.textarea, { key: "Tab", ...ime });
    expect(view.onPredictionAccept).not.toHaveBeenCalled();
    expect(view.textarea.value).toBe("");
  });

  it("keeps the 50ms composition-end guard for a newly arrived suggestion", () => {
    vi.useFakeTimers();
    const view = setup();
    fireEvent.compositionStart(view.textarea);
    expect(view.onPredictionUnavailable).toHaveBeenCalled();
    fireEvent.compositionEnd(view.textarea);
    view.update({ prediction: { id: "turn-2", text: "New suggestion" } });
    fireEvent.keyDown(view.textarea, { key: "Tab" });
    expect(view.onPredictionAccept).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(51));
    fireEvent.keyDown(view.textarea, { key: "Tab" });
    expect(view.textarea.value).toBe("New suggestion");
  });

  it("dismisses Escape once and does not revive the same id on rerender", () => {
    const view = setup();
    fireEvent.keyDown(view.textarea, { key: "Escape" });
    expect(view.onPredictionDismiss).toHaveBeenCalledOnce();
    view.update({ prediction: { id: "turn-1", text: "Still stale" } });
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
    fireEvent.keyDown(view.textarea, { key: "Tab" });
    expect(view.onPredictionAccept).not.toHaveBeenCalled();
  });

  it("lets Escape dismiss a round whose prediction has not arrived yet", () => {
    const view = setup({ prediction: undefined });
    fireEvent.keyDown(view.textarea, { key: "Escape" });
    expect(view.onPredictionDismiss).toHaveBeenCalledOnce();
  });

  it("invalidates Shift+Enter as a newline input action without sending", () => {
    const view = setup();
    fireEvent.keyDown(view.textarea, { key: "Enter", shiftKey: true });
    expect(view.onPredictionUnavailable).toHaveBeenCalled();
    expect(view.onSend).not.toHaveBeenCalled();
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
  });

  it("does not accept with Enter and retains normal sending after acceptance", () => {
    const view = setup();
    fireEvent.keyDown(view.textarea, { key: "Enter" });
    expect(view.onSend).not.toHaveBeenCalled();
    expect(view.onPredictionAccept).not.toHaveBeenCalled();
    fireEvent.keyDown(view.textarea, { key: "Tab" });
    fireEvent.keyDown(view.textarea, { key: "Enter" });
    expect(view.onSend).toHaveBeenCalledOnce();
    expect(view.onHistoryPush).toHaveBeenCalledOnce();
  });

  it.each([
    { draft: " " }, { busy: true }, { disabled: true }, { intakePending: 1 },
    { images: [{ kind: "image" as const, id: "a".repeat(64), name: "image.png", mime: "image/png" as const, bytes: 1, width: 1, height: 1 }] },
  ])("does not display in an ineligible initial state: %j", (props) => {
    const view = setup(props);
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
    expect(view.onPredictionUnavailable).not.toHaveBeenCalled();
    fireEvent.keyDown(view.textarea, { key: "Tab" });
    expect(view.onPredictionAccept).not.toHaveBeenCalled();
  });

  it("invalidates a prediction on typing and does not revive after clearing", () => {
    const view = setup();
    fireEvent.keyDown(view.textarea, { key: "x" });
    expect(view.onPredictionUnavailable).toHaveBeenCalled();
    fireEvent.change(view.textarea, { target: { value: "x" } });
    fireEvent.change(view.textarea, { target: { value: "" } });
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
  });

  it.each(["input", "cut", "drop", "paste"])("invalidates on %s even without a draft change", (event) => {
    const view = setup();
    if (event === "paste") fireEvent.paste(view.textarea, { clipboardData: { getData: () => "plain", files: [], items: [], types: ["text/plain"] } });
    else fireEvent(view.textarea, new Event(event, { bubbles: true }));
    expect(view.onPredictionUnavailable).toHaveBeenCalled();
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
  });

  it("notifies unavailable during an in-flight request with no prediction yet", () => {
    const view = setup({ prediction: undefined });
    fireEvent.compositionStart(view.textarea);
    expect(view.onPredictionUnavailable).toHaveBeenCalled();
  });

  it("invalidates external pending and programmatic draft transitions, not mount", () => {
    const view = setup();
    expect(view.onPredictionUnavailable).not.toHaveBeenCalled();
    view.update({ intakePending: 1 });
    expect(view.onPredictionUnavailable).toHaveBeenCalled();
    view.update({ intakePending: 0 });
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
    view.update({ prediction: { id: "turn-2", text: "New suggestion" }, draft: "edited" });
    view.update({ draft: "" });
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
  });

  it("invalidates history navigation even when returning to an empty draft", () => {
    const view = setup({ initialHistory: ["Previous prompt"] });
    fireEvent.keyDown(view.textarea, { key: "ArrowUp" });
    expect(view.textarea.value).toBe("Previous prompt");
    expect(view.onPredictionUnavailable).toHaveBeenCalled();
    fireEvent.keyDown(view.textarea, { key: "ArrowDown" });
    expect(view.textarea.value).toBe("");
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
  });

  it("prioritizes the existing popup over prediction Tab and Escape", () => {
    const view = setup({ slashCommands: [{ cmd: "/clear", desc: "Clear", run: vi.fn() }] });
    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    fireEvent.click(screen.getByText("commands", { selector: ".title" }));
    expect(view.container.querySelector(".popup")).not.toBeNull();
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
    fireEvent.keyDown(view.textarea, { key: "Tab" });
    expect(view.onPredictionAccept).not.toHaveBeenCalled();
    fireEvent.keyDown(view.textarea, { key: "Escape" });
    expect(view.container.querySelector(".popup")).toBeNull();
  });

  it("does not pick a mention while IME confirms a candidate", () => {
    const onMentionQuery = vi.fn();
    const view = setup({ onMentionQuery });
    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    fireEvent.click(screen.getByText("Mention workspace file", { selector: ".title" }));
    const nonce = onMentionQuery.mock.calls.at(-1)![1];
    view.update({ mentionResults: { nonce, query: "", results: ["src/"] } });
    fireEvent.compositionStart(view.textarea);
    const before = view.textarea.value;
    fireEvent.keyDown(view.textarea, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(view.textarea.value).toBe(before);
    expect(view.container.querySelector(".popup")).not.toBeNull();
    expect(view.onSend).not.toHaveBeenCalled();
  });

  it.each([{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }])(
    "keeps modified Tab as navigation with an active mention directory: %j", (modifiers) => {
      const onMentionQuery = vi.fn();
      const view = setup({ onMentionQuery });
      fireEvent.click(screen.getByRole("button", { name: "Add context" }));
      fireEvent.click(screen.getByText("Mention workspace file", { selector: ".title" }));
      const nonce = onMentionQuery.mock.calls.at(-1)![1];
      view.update({ mentionResults: { nonce, query: "", results: ["src/"] } });
      expect(fireEvent.keyDown(view.textarea, { key: "Tab", ...modifiers })).toBe(true);
      expect(view.textarea.value).toBe("");
      expect(view.onPredictionAccept).not.toHaveBeenCalled();
    },
  );

  it("blocks late suggestions during local image import, even if import fails", async () => {
    let reject!: (error: Error) => void;
    vi.spyOn(imageAttachments, "importImage").mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const view = setup({ tabId: "tab-1", onImagesChange: vi.fn() });
    fireEvent.paste(view.textarea, { clipboardData: { getData: (type: string) => type === "text/uri-list" ? "file:///repo/image.png" : "", files: [], items: [], types: ["text/uri-list"] } });
    expect(view.onPredictionUnavailable).toHaveBeenCalled();
    view.update({ prediction: { id: "turn-2", text: "Late result" } });
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
    await act(async () => reject(new Error("Import failed")));
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
  });

  it("keeps ordinary clipboard uploads pending after desktop probing finishes", async () => {
    let resolve!: (bytes: ArrayBuffer) => void;
    const file = new File(["data"], "test.txt", { type: "text/plain" });
    Object.defineProperty(file, "arrayBuffer", { value: () => new Promise((done) => { resolve = done; }) });
    vi.mocked(invoke).mockResolvedValueOnce([]).mockResolvedValueOnce("/repo/test.txt");
    const view = setup({ prediction: undefined });
    await act(async () => fireEvent.paste(view.textarea, { clipboardData: { getData: () => "", files: [file], items: [], types: ["Files"] } }));
    view.update({ prediction: { id: "turn-2", text: "Late result" } });
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
    expect(screen.getByText("Processing attachments...")).toBeTruthy();
    await act(async () => resolve(new ArrayBuffer(4)));
    expect(view.container.querySelector(".composer-file-attachment")).not.toBeNull();
  });

  it("invalidates local dialog pending immediately, including a canceled import", async () => {
    let resolve!: (path: null) => void;
    vi.mocked(open).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const view = setup({ prediction: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    fireEvent.click(screen.getByText("Add file", { selector: ".title" }));
    expect(view.onPredictionUnavailable).toHaveBeenCalled();
    view.update({ prediction: { id: "turn-1", text: "Late result" } });
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
    await act(async () => resolve(null));
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
  });

  it("invalidates clipboard probing and local file attachments", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    const view = setup();
    await act(async () => fireEvent.paste(view.textarea, { clipboardData: { getData: () => "", files: [], items: [], types: [] } }));
    expect(view.onPredictionUnavailable).toHaveBeenCalled();
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
    await act(async () => fireEvent.paste(view.textarea, { clipboardData: { getData: (type: string) => type === "text/uri-list" ? "file:///repo/test.txt" : "", files: [], items: [], types: ["text/uri-list"] } }));
    expect(view.container.querySelector(".composer-file-attachment")).not.toBeNull();
    view.update({ prediction: { id: "turn-2", text: "Blocked by attachment" } });
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment" }));
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
  });

  it("can fall back to dismiss for unavailable when that callback is omitted", () => {
    const view = setup({ onPredictionUnavailable: undefined });
    fireEvent.change(view.textarea, { target: { value: "x" } });
    expect(view.onPredictionDismiss).toHaveBeenCalled();
  });

  it("shows a nonblocking notice before notifying the parent, once even in StrictMode", () => {
    const flushFrame = mockFrames();
    const seen = vi.fn(() => expect(screen.getByText(t("composer.predictionNotice"))).toBeTruthy());
    const disable = vi.fn();
    const view = setup({ predictionNotice: true, onPredictionNoticeSeen: seen, onDisablePredictions: disable }, true);
    expect(screen.getByText(t("composer.predictionNotice"))).toBeTruthy();
    expect(seen).not.toHaveBeenCalled();
    flushFrame();
    expect(seen).not.toHaveBeenCalled();
    flushFrame();
    expect(seen).toHaveBeenCalledOnce();
    view.update({ onPredictionNoticeSeen: () => seen() });
    flushFrame(); flushFrame();
    expect(seen).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Turn off prompt predictions" }));
    expect(disable).toHaveBeenCalledOnce();
  });

  it.each(["en", "zh-CN", "de", "ja"] as const)("localizes failed-save disclosure in %s", (lang) => {
    const english = t("composer.predictionSaveFailed");
    setLang(lang);
    const message = t("composer.predictionSaveFailed");
    expect(message).not.toBe("composer.predictionSaveFailed");
    expect(message.length).toBeGreaterThan(20);
    if (lang !== "en") expect(message).not.toBe(english);
  });
});

describe("Composer and prediction hook integration", () => {
  function integrated() {
    const flushFrame = mockFrames();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    document.documentElement.dataset.nativeWindow = "true";
    const send = vi.fn(async (_command: OutgoingCommand) => undefined);
    const clear = vi.fn();
    const onSend = vi.fn();
    let candidate: { completionId: string; text?: string } = { completionId: "round-1" };
    function Harness() {
      const [draft, setDraft] = useState("");
      const textareaRef = createRef<HTMLTextAreaElement>();
      const ui = usePromptPrediction({ candidate, active: true, ready: true, busy: false,
        enabled: true, blocked: false, hasDraft: draft !== "", transportAvailable: true, send, clear });
      return <Composer draft={draft} setDraft={setDraft} textareaRef={textareaRef}
        onSend={onSend} onAbort={vi.fn()} modelLabel="deepseek-v4-flash"
        reasoningEffort="high" editMode="review" onModelChange={vi.fn()}
        onEffortChange={vi.fn()} onEditModeChange={vi.fn()} slashCommands={[]}
        prediction={ui.prediction} predictionNotice={ui.notice}
        onPredictionNoticeSeen={ui.markNoticeSeen} onPredictionAccept={ui.dismiss}
        onPredictionDismiss={ui.dismiss} onPredictionUnavailable={ui.dismiss} />;
    }
    const view = render(<Harness />);
    return { ...view, send, clear, onSend, flushFrame,
      respond(text: string) { candidate = { ...candidate, text }; view.rerender(<Harness />); },
    };
  }

  it("commits the notice before allowing the hook request and accepts without sending", () => {
    const view = integrated();
    expect(screen.getByText(t("composer.predictionNotice"))).toBeTruthy();
    expect(view.send).not.toHaveBeenCalled();
    view.flushFrame();
    expect(view.send).not.toHaveBeenCalled();
    view.flushFrame();
    expect(view.send).toHaveBeenCalledWith({ cmd: "prompt_prediction_get", completionId: "round-1" });
    view.respond("Next prompt.");
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("Next prompt.");
    expect(view.onSend).not.toHaveBeenCalled();
    expect(view.send).toHaveBeenCalledWith({ cmd: "prompt_prediction_dismiss", completionId: "round-1" });
    expect(view.clear).toHaveBeenCalledOnce();
  });

  it("cancels an in-flight round on empty-draft editing and drops a late result", () => {
    const view = integrated();
    view.flushFrame(); view.flushFrame();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Backspace" });
    expect(view.send).toHaveBeenCalledWith({ cmd: "prompt_prediction_dismiss", completionId: "round-1" });
    view.respond("Late stale result.");
    expect(view.container.querySelector(".composer-prediction")).toBeNull();
    expect(view.send.mock.calls.filter(([command]) => command.cmd === "prompt_prediction_get")).toHaveLength(1);
  });
});
