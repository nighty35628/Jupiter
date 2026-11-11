// @vitest-environment jsdom

import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, forwardRef, useCallback, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebDragDropEvent } from "../../dashboard/src/lib/shell-services";
import { UploadStore } from "../../src/web/uploads";
import { WorkspaceRegistry } from "../../src/web/workspaces";

const bridge = vi.hoisted(() => ({
  handlers: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  drops: new Set<(event: WebDragDropEvent) => void | Promise<void>>(),
  invoke: vi.fn<(command: string, args?: any) => Promise<unknown>>(),
  deferSetters: false,
  deferredText: undefined as undefined | (() => void),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: bridge.invoke,
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(async () => undefined),
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = bridge.handlers.get(name) ?? new Set();
    handlers.add(handler);
    bridge.handlers.set(name, handlers);
    return () => {
      handlers.delete(handler);
    };
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: async () => false,
    isMaximized: async () => false,
    isFocused: async () => true,
    setFullscreen: vi.fn(),
    toggleMaximize: vi.fn(),
    minimize: vi.fn(),
    close: vi.fn(),
    listen: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));
vi.mock("./CommandPalette", () => ({
  CommandPalette: () => null,
  Toast: () => null,
  buildCommands: () => [],
  useCommandPalette: () => ({ open: false, setOpen: vi.fn() }),
}));
vi.mock("./Markdown", () => ({
  WorkspaceProvider: ({ children }: { children: ReactNode }) => children,
  Markdown: ({ source }: { source: string }) => source,
}));
vi.mock("./ui/splash", () => ({ Splash: () => null, shouldShowSplash: () => false }));
vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function Transcript(
    props: {
      data: unknown[];
      itemContent: (index: number, item: unknown) => ReactNode;
      scrollerRef: (node: HTMLElement | null) => void;
      computeItemKey: (index: number, item: unknown) => string;
    },
    ref,
  ) {
    useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn(), scrollTo: vi.fn() }));
    return (
      <div ref={props.scrollerRef}>
        {props.data.map((row, index) => (
          <div key={props.computeItemKey(index, row)}>{props.itemContent(index, row)}</div>
        ))}
      </div>
    );
  }),
}));
vi.mock("./ui/image-attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui/image-attachments")>();
  return {
    ...actual,
    useImageDraft: (key: string) => {
      const draft = actual.useImageDraft(key);
      const setDraft = useCallback(
        (value: Parameters<typeof draft.setDraft>[0]) => {
          if (bridge.deferSetters) bridge.deferredText = () => draft.setDraft(value);
          else draft.setDraft(value);
        },
        [draft.setDraft],
      );
      const setIntake = useCallback(
        (id: string, change: Parameters<typeof draft.setIntake>[1]) => {
          if (bridge.deferSetters) bridge.deferredText = () => draft.setIntake(id, change);
          else draft.setIntake(id, change);
        },
        [draft.setIntake],
      );
      return { ...draft, setDraft, setIntake };
    },
  };
});

import { App } from "./App";
import { setLang } from "./i18n";
import { conversationDraftKey, readImageDraft, writeImageDraft } from "./ui/image-draft-store";

const IMAGE = {
  kind: "image",
  id: "a".repeat(64),
  name: "shared.png",
  mime: "image/png",
  bytes: 5,
  width: 1,
  height: 1,
};
const FILE_TOKEN = "jupiter-file:12345678-1234-4123-8123-123456789abc";
const commands = () =>
  bridge.invoke.mock.calls.flatMap(([command, args]) =>
    command === "rpc_send" && args?.line ? [JSON.parse(args.line)] : [],
  );

async function emit(event: Record<string, unknown>) {
  await act(async () => {
    for (const callback of bridge.handlers.get("rpc:event") ?? [])
      callback({ payload: { data: JSON.stringify(event) } });
  });
}

async function bootstrap(tabId: string, sessionId: string, busy = false, load = true) {
  await emit({
    type: "$tab_opened",
    tabId,
    workspaceDir: "/tmp/android-share",
    active: true,
    sessionId,
    conversationViewId: "default",
    sessionTitle: `Share ${tabId}`,
  });
  await emit({
    type: "$settings",
    tabId,
    workspaceDir: "/tmp/android-share",
    model: "mock",
    supportsImages: true,
    reasoningEffort: "high",
    editMode: "review",
    recentWorkspaces: [],
    version: "test",
  });
  if (load)
    await emit({
      type: "$session_loaded",
      tabId,
      name: `share-${tabId}`,
      busy,
      runtimeReady: true,
      messages: [],
      snapshot: {
        sessionId,
        conversationViewId: "default",
        defaultConversationViewId: "default",
        bindingId: 1,
        reason: "load",
        payloadBytes: 0,
        truncated: false,
      },
      history: { generation: "g1", sourceSize: 0, totalTurns: 0, hasMore: false },
      sessionFiles: [],
      carryover: {
        totalCostUsd: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalCompletionTokens: 0,
      },
    });
}

async function start() {
  render(<App />);
  await waitFor(() => expect(bridge.handlers.has("rpc:event")).toBe(true));
}

function drop(text: string, files: File[] = []) {
  const persisted = vi.fn();
  const complete = vi.fn((persist: () => void) => {
    persist();
    persisted();
  });
  const event: WebDragDropEvent = {
    payload: { type: "drop", text, files, intakeId: crypto.randomUUID(), complete },
  };
  return { event, complete, persisted };
}

async function deliver(event: WebDragDropEvent) {
  await act(async () => {
    for (const callback of [...bridge.drops]) await callback(event);
  });
}

beforeEach(() => {
  localStorage.clear();
  bridge.handlers.clear();
  bridge.drops.clear();
  bridge.invoke.mockReset();
  bridge.deferSetters = false;
  bridge.deferredText = undefined;
  vi.mocked(getCurrentWebview).mockReturnValue({
    onDragDropEvent: async (callback: (event: WebDragDropEvent) => void | Promise<void>) => {
      bridge.drops.add(callback);
      return () => {
        bridge.drops.delete(callback);
      };
    },
  } as never);
  setLang("en");
  document.documentElement.dataset.hostPlatform = "android";
  document.documentElement.dataset.runtime = "web";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  });
  Element.prototype.scrollIntoView = vi.fn();
  bridge.invoke.mockImplementation(async (command, args) => {
    if (command === "web_upload_file") return FILE_TOKEN;
    if (command === "rpc_send" && args?.line) {
      const rpc = JSON.parse(args.line);
      if (rpc.cmd === "attachment_import")
        queueMicrotask(() => {
          for (const callback of bridge.handlers.get("rpc:event") ?? [])
            callback({
              payload: {
                data: JSON.stringify({
                  type: "$attachment_result",
                  requestId: rpc.requestId,
                  attachment: IMAGE,
                }),
              },
            });
        });
    }
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.hostPlatform;
  delete document.documentElement.dataset.runtime;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Android shares use the bound App draft/drop pipeline", { retry: 0 }, () => {
  it("does not register intake until the active draft identity is ready", async () => {
    await start();
    await bootstrap("a", crypto.randomUUID(), false, false);
    expect(bridge.drops.size).toBe(0);
    await emit({ type: "$ready", tabId: "a" });
    expect(bridge.drops.size).toBe(0);
  });

  it("persists a text-only share while busy without sending or enqueueing it", async () => {
    const sid = crypto.randomUUID();
    const key = conversationDraftKey(sid, "default");
    writeImageDraft(key, () => ({ text: "existing draft" }));
    await start();
    await bootstrap("a", sid, true);
    await waitFor(() => expect(bridge.drops.size).toBe(1));
    const intake = drop("shared text");
    intake.complete.mockImplementation((persist) => {
      expect(readImageDraft(key).text).toBe("existing draft\nshared text");
      persist();
      intake.persisted();
    });
    await deliver(intake.event);
    expect(intake.persisted).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem(`jupiter.image-draft.v1:${key}`)!).text).toBe(
      "existing draft\nshared text",
    );
    expect(readImageDraft(key).queue ?? []).toEqual([]);
    await emit({ type: "$turn_complete", tabId: "a" });
    expect(commands().filter((command) => command.cmd === "user_input")).toEqual([]);
  });

  it("uploads File objects and imports images before completing the durable draft", async () => {
    const sid = crypto.randomUUID();
    const key = conversationDraftKey(sid, "default");
    await start();
    await bootstrap("a", sid);
    await waitFor(() => expect(bridge.drops.size).toBe(1));
    const image = new File(["image"], "shared.png", { type: "image/png" });
    const intake = drop("image caption", [image]);
    intake.complete.mockImplementation((persist) => {
      expect(readImageDraft(key)).toMatchObject({ text: "image caption", attachments: [IMAGE] });
      persist();
      intake.persisted();
    });
    await deliver(intake.event);
    expect(bridge.invoke).toHaveBeenCalledWith("web_upload_file", { file: image });
    expect(commands().filter((command) => command.cmd === "attachment_import")).toEqual([
      expect.objectContaining({ path: FILE_TOKEN, tabId: "a" }),
    ]);
    expect(intake.persisted).toHaveBeenCalledOnce();
    expect(commands().filter((command) => command.cmd === "user_input")).toEqual([]);
  });

  it("keeps an in-flight upload bound to its original draft after switching tabs", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await start();
    await bootstrap("a", a);
    await bootstrap("b", b);
    fireEvent.click(document.querySelector(`[role="tab"][data-session-id="${a}"]`)!);
    await waitFor(() => expect(bridge.drops.size).toBe(1));
    let finishUpload!: (path: string) => void;
    bridge.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpload = resolve;
        }),
    );
    const intake = drop("shared document", [
      new File(["document"], "note.txt", { type: "text/plain" }),
    ]);
    let processing: Promise<void> | void;
    await act(async () => {
      processing = [...bridge.drops][0]!(intake.event);
    });
    expect(intake.complete).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector(`[role="tab"][data-session-id="${b}"]`)!);
    await act(async () => {
      finishUpload(FILE_TOKEN);
      await processing;
    });
    expect(readImageDraft(conversationDraftKey(a, "default")).text).toBe(
      `shared document @${FILE_TOKEN} `,
    );
    expect(readImageDraft(conversationDraftKey(b, "default")).text).toBe("");
    expect(intake.persisted).toHaveBeenCalledOnce();
    expect(commands().filter((command) => command.cmd === "user_input")).toEqual([]);
  });

  it("commits an upload into its forwarded conversation draft after new-tab identity handoff", async () => {
    await start();
    await emit({
      type: "$tab_opened",
      tabId: "fresh",
      workspaceDir: "/tmp/android-share",
      active: true,
    });
    await emit({
      type: "$settings",
      tabId: "fresh",
      workspaceDir: "/tmp/android-share",
      model: "mock",
      supportsImages: true,
      reasoningEffort: "high",
      editMode: "review",
      recentWorkspaces: [],
      version: "test",
    });
    await emit({ type: "$ready", tabId: "fresh" });
    await waitFor(() => expect(bridge.drops.size).toBe(1));
    let finishUpload!: (path: string) => void;
    bridge.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpload = resolve;
        }),
    );
    const intake = drop("shared during handoff", [
      new File(["document"], "note.txt", { type: "text/plain" }),
    ]);
    let processing: Promise<void> | void;
    await act(async () => {
      processing = [...bridge.drops][0]!(intake.event);
    });
    expect(intake.complete).not.toHaveBeenCalled();
    const sid = crypto.randomUUID();
    await bootstrap("fresh", sid);
    const formal = conversationDraftKey(sid, "default");
    const oldPlaceholder = localStorage.getItem("jupiter.image-draft.v1:new:fresh");
    await act(async () => {
      finishUpload(FILE_TOKEN);
      await processing;
    });
    expect(readImageDraft(formal).text).toBe(`shared during handoff @${FILE_TOKEN} `);
    expect(localStorage.getItem("jupiter.image-draft.v1:new:fresh")).toBe(oldPlaceholder);
    expect((document.querySelector("main textarea") as HTMLTextAreaElement).value).toBe(
      `shared during handoff @${FILE_TOKEN} `,
    );
    expect(intake.persisted).toHaveBeenCalledOnce();
    expect(readImageDraft(formal).shareIntakeIds).toEqual([
      (intake.event.payload as { intakeId: string }).intakeId,
    ]);
    expect(commands().filter((command) => command.cmd === "user_input")).toEqual([]);
  });

  it("does not complete when uploading fails, leaving the existing draft unchanged", async () => {
    const sid = crypto.randomUUID();
    const key = conversationDraftKey(sid, "default");
    writeImageDraft(key, () => ({ text: "keep me" }));
    await start();
    await bootstrap("a", sid);
    await waitFor(() => expect(bridge.drops.size).toBe(1));
    bridge.invoke.mockRejectedValueOnce(new Error("upload failed"));
    const intake = drop("do not lose", [new File(["bytes"], "note.txt")]);
    await deliver(intake.event);
    expect(intake.complete).not.toHaveBeenCalled();
    expect(readImageDraft(key).text).toBe("keep me");
  });

  it.skipIf(process.platform === "win32")("rolls back a partial persistent upload, retries within quota, and restores only committed tokens after restart", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "jupiter-share-upload-rollback-")));
    const root = join(home, "uploads");
    const options = {
      persistentRoot: root,
      maxFiles: 2,
      maxFileBytes: 32,
      maxTotalBytes: Buffer.byteLength("first.txtsecond.txt"),
    };
    const stores: UploadStore[] = [];
    try {
      let registry = new WorkspaceRegistry();
      let store = await UploadStore.create(registry, options);
      stores.push(store);
      const sid = crypto.randomUUID();
      const key = conversationDraftKey(sid, "default");
      await start();
      await bootstrap("a", sid);
      await waitFor(() => expect(bridge.drops.size).toBe(1));
      let failSecond = true;
      const uploaded: string[] = [];
      bridge.invoke.mockImplementation(async (command, args) => {
        if (command === "web_upload_file") {
          const file = args.file as File;
          if (file.name === "second.txt" && failSecond) {
            failSecond = false;
            throw new Error("second upload failed");
          }
          async function* body() {
            yield Buffer.from(file.name);
          }
          const received = await store.receive(
            file.name,
            file.type,
            body(),
            Buffer.byteLength(file.name),
          );
          const token = `jupiter-file:${received.file.id}`;
          uploaded.push(token);
          return token;
        }
        if (command === "web_upload_remove")
          await store.remove(String(args.path).slice("jupiter-file:".length));
        return undefined;
      });
      const intake = drop("two documents", [
        new File(["first"], "first.txt"),
        new File(["second"], "second.txt"),
      ]);
      await deliver(intake.event);
      expect(await readdir(root)).toEqual([]);
      expect(intake.complete).not.toHaveBeenCalled();
      expect(readImageDraft(key).text).toBe("");
      expect(bridge.invoke).toHaveBeenCalledWith("web_upload_remove", { path: uploaded[0] });
      const rolledBack = uploaded[0]!;
      await deliver(intake.event);
      expect(intake.persisted).toHaveBeenCalledOnce();
      expect(await readdir(root)).toHaveLength(2);
      expect(readImageDraft(key).text).not.toContain(rolledBack);
      const committed = [...uploaded.slice(1)].sort();
      const uploadCalls = bridge.invoke.mock.calls.filter(
        ([command]) => command === "web_upload_file",
      ).length;
      await store.close();
      registry = new WorkspaceRegistry();
      store = await UploadStore.create(registry, options);
      stores.push(store);
      expect((await readdir(root)).map((id) => `jupiter-file:${id}`).sort()).toEqual(committed);
      expect(() => registry.resolveFile(rolledBack.slice("jupiter-file:".length))).toThrow();
      for (const token of committed)
        expect(registry.resolveFile(token.slice("jupiter-file:".length)).ref.source).toBe("upload");
      cleanup();
      bridge.handlers.clear();
      bridge.drops.clear();
      await start();
      await bootstrap("a", sid);
      await waitFor(() => expect(bridge.drops.size).toBe(1));
      await deliver(intake.event);
      expect(
        bridge.invoke.mock.calls.filter(([command]) => command === "web_upload_file"),
      ).toHaveLength(uploadCalls);
      expect(intake.persisted).toHaveBeenCalledTimes(2);
      expect(await readdir(root)).toHaveLength(2);
    } finally {
      for (const store of stores) await store.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not complete before a delayed draft setter has actually processed its update", async () => {
    bridge.deferSetters = true;
    const sid = crypto.randomUUID();
    const key = conversationDraftKey(sid, "default");
    await start();
    await bootstrap("a", sid);
    await waitFor(() => expect(bridge.drops.size).toBe(1));
    const intake = drop("must not ack early");
    await deliver(intake.event);
    expect(intake.complete).not.toHaveBeenCalled();
    expect(readImageDraft(key).text).toBe("");
    expect(bridge.deferredText).toBeTypeOf("function");
    await act(async () => {
      bridge.deferredText?.();
    });
    expect(readImageDraft(key).text).toBe("must not ack early");
    expect(intake.complete).not.toHaveBeenCalled();
  });

  it("does not remove content-addressed images or pre-existing path tokens on partial intake failure", async () => {
    await start();
    await bootstrap("a", crypto.randomUUID());
    await waitFor(() => expect(bridge.drops.size).toBe(1));
    const imageToken = `jupiter-image:${IMAGE.id}`;
    bridge.invoke.mockImplementation(async (command, args) => {
      if (command === "web_upload_file") {
        if (args.file.name === "second.txt") throw new Error("second upload failed");
        return imageToken;
      }
      return undefined;
    });
    const intake = drop("two files", [
      new File(["image"], "first.png", { type: "image/png" }),
      new File(["second"], "second.txt"),
    ]);
    if (intake.event.payload.type === "drop") intake.event.payload.paths = [FILE_TOKEN];
    await deliver(intake.event);
    expect(intake.complete).not.toHaveBeenCalled();
    expect(bridge.invoke.mock.calls.filter(([command]) => command === "web_upload_remove")).toEqual(
      [],
    );
  });

  it("does not roll back uploaded ordinary files after their draft receipt has committed", async () => {
    const sid = crypto.randomUUID();
    const key = conversationDraftKey(sid, "default");
    await start();
    await bootstrap("a", sid);
    await waitFor(() => expect(bridge.drops.size).toBe(1));
    const intake = drop("committed file", [new File(["file"], "first.txt")]);
    intake.complete.mockImplementation(() => {
      throw new Error("failure after draft commit");
    });
    await deliver(intake.event);
    expect(readImageDraft(key).shareIntakeIds).toEqual([
      (intake.event.payload as { intakeId: string }).intakeId,
    ]);
    expect(readImageDraft(key).text).toContain(FILE_TOKEN);
    expect(bridge.invoke.mock.calls.filter(([command]) => command === "web_upload_remove")).toEqual(
      [],
    );
  });

  it("does not confirm persistence when browser storage rejects the draft", async () => {
    const sid = crypto.randomUUID();
    const key = conversationDraftKey(sid, "default");
    await start();
    await bootstrap("a", sid);
    await waitFor(() => expect(bridge.drops.size).toBe(1));
    const storage = localStorage;
    vi.stubGlobal("localStorage", {
      get length() {
        return storage.length;
      },
      key: storage.key.bind(storage),
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      clear: storage.clear.bind(storage),
      setItem(name: string, value: string) {
        if (name === `jupiter.image-draft.v1:${key}`)
          throw new DOMException("quota", "QuotaExceededError");
        storage.setItem(name, value);
      },
    });
    const intake = drop("retained in memory, Native must keep the original");
    await deliver(intake.event);
    expect(readImageDraft(key).text).toBe("");
    expect(intake.persisted).not.toHaveBeenCalled();
  });

  it("rejects a share that exceeds the existing draft's attachment capacity", async () => {
    const sid = crypto.randomUUID();
    const key = conversationDraftKey(sid, "default");
    writeImageDraft(key, () => ({
      text: "full draft",
      attachments: Array.from({ length: 12 }, (_, index) => ({
        ...IMAGE,
        kind: "image" as const,
        mime: "image/png" as const,
        id: index.toString(16).padStart(64, "0"),
      })),
    }));
    await start();
    await bootstrap("a", sid);
    await waitFor(() => expect(bridge.drops.size).toBe(1));
    const intake = drop("leave this staged", [new File(["file"], "extra.txt")]);
    await deliver(intake.event);
    expect(intake.complete).not.toHaveBeenCalled();
    expect(
      bridge.invoke.mock.calls.filter(([command]) => command === "web_upload_file"),
    ).toHaveLength(0);
    expect(readImageDraft(key).text).toBe("full draft");
  });

  it("records one atomic share write and skips re-upload after the same share is replayed", async () => {
    const sid = crypto.randomUUID();
    const key = conversationDraftKey(sid, "default");
    await start();
    await bootstrap("a", sid);
    await waitFor(() => expect(bridge.drops.size).toBe(1));
    const intake = drop("caption", [new File(["image"], "shared.png", { type: "image/png" })]);
    const storage = localStorage;
    const writes: unknown[] = [];
    vi.stubGlobal("localStorage", {
      get length() {
        return storage.length;
      },
      key: storage.key.bind(storage),
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      clear: storage.clear.bind(storage),
      setItem(name: string, value: string) {
        if (name === `jupiter.image-draft.v1:${key}`) writes.push(JSON.parse(value));
        storage.setItem(name, value);
      },
    });
    await deliver(intake.event);
    expect(writes).toEqual([
      expect.objectContaining({
        text: "caption",
        attachments: [IMAGE],
        shareIntakeIds: [(intake.event.payload as { intakeId: string }).intakeId],
      }),
    ]);
    await deliver(intake.event);
    expect(readImageDraft(key).text).toBe("caption");
    expect(
      bridge.invoke.mock.calls.filter(([command]) => command === "web_upload_file"),
    ).toHaveLength(1);
    expect(intake.persisted).toHaveBeenCalledTimes(2);
  });

  it("shows a persistent accessible failure notice and explicit retry action without sending", async () => {
    await start();
    await bootstrap("a", crypto.randomUUID(), true);
    const retry = vi.fn();
    const discard = vi.fn();
    window.addEventListener("jupiter:android-share-retry", retry);
    window.addEventListener("jupiter:android-share-discard", discard);
    try {
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent("jupiter:android-share-status", {
            detail: { error: "ack unavailable", busy: false },
          }),
        );
      });
      expect(screen.getByRole("alert").textContent).toContain("original is retained");
      fireEvent.click(screen.getByRole("button", { name: "Retry share" }));
      expect(retry).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: "Discard staged share" }));
      expect(discard).toHaveBeenCalledOnce();
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent("jupiter:android-share-status", {
            detail: { error: "ack unavailable", busy: true },
          }),
        );
      });
      expect(
        (screen.getByRole("button", { name: "Retry share" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Retry share" }));
      expect(retry).toHaveBeenCalledOnce();
      expect(
        (screen.getByRole("button", { name: "Discard staged share" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Discard staged share" }));
      expect(discard).toHaveBeenCalledOnce();
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent("jupiter:android-share-status", {
            detail: { error: null, busy: false },
          }),
        );
      });
      expect(screen.queryByRole("button", { name: "Retry share" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Discard staged share" })).toBeNull();
      expect(commands().filter((command) => command.cmd === "user_input")).toEqual([]);
    } finally {
      window.removeEventListener("jupiter:android-share-retry", retry);
      window.removeEventListener("jupiter:android-share-discard", discard);
    }
  });
});
