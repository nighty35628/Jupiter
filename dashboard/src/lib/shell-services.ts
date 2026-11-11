import {
  emitRuntimeEvent,
  getWebWorkspaceChoices,
  resolveWebWorkspaceFile,
  uploadWebFile,
} from "./runtime-transport";
import {
  type AndroidShare, callAndroid, consumeAndroidShare, discardAndroidShare, downloadAndroidFile,
  fetchAndroidShareFiles, isAndroidLocal,
} from "./android-native";
import { findImageDraftIntake } from "../../../desktop/src/ui/image-draft-store";

type UnlistenFn = () => void;
type EventCallback<T = any> = (event: { payload: T; event: string }) => void;

export type WebDragDropEvent = {
  payload: { type: "enter" | "leave" } | {
    type: "drop"; paths?: string[]; files?: File[]; text?: string; intakeId?: string;
    complete?: (persistDraft: () => void) => void;
  };
};

type WebDragDropCallback = (event: WebDragDropEvent) => void | Promise<void>;

const webDragDropCallbacks = new Set<WebDragDropCallback>();
let webDragDropDepth = 0;
let androidShareChecked = false;
let androidShareNeedsReceiver = false;
let androidShareReadyPending = false;
let androidShareRunning = false;
let androidShareDisconnected = false;
let androidShareAbort: AbortController | undefined;
let androidSharePending: { share: AndroidShare; files?: File[]; persist?: () => void } | undefined;
let androidShareStatus: { error: string | null; busy: boolean } = { error: null, busy: false };

function publishAndroidShareStatus(): void {
  window.dispatchEvent(new CustomEvent("jupiter:android-share-status", { detail: androidShareStatus }));
}

async function intakeAndroidShare(explicit = false): Promise<void> {
  if (!isAndroidLocal || androidShareDisconnected || androidShareRunning || !webDragDropCallbacks.size ||
      (!explicit && !androidShareReadyPending && androidShareChecked && !androidShareNeedsReceiver)) return;
  androidShareReadyPending = false;
  androidShareChecked = true;
  androidShareNeedsReceiver = false;
  androidShareRunning = true;
  androidShareStatus = { ...androidShareStatus, busy: true };
  publishAndroidShareStatus();
  try {
    const seen = new Set<string>();
    while (!androidShareDisconnected) {
      if (!androidSharePending) {
        if (!webDragDropCallbacks.size) { androidShareNeedsReceiver = true; return; }
        androidShareReadyPending = false;
        const share = await consumeAndroidShare();
        if (!share) {
          if (androidShareReadyPending) continue;
          androidShareStatus = { error: null, busy: true };
          return;
        }
        // A host replay after a successful ack must not cause an unbounded drain loop.
        if (seen.has(share.id)) return;
        androidSharePending = { share };
      }
      const pending = androidSharePending;
      if (!pending.persist && findImageDraftIntake(pending.share.id) === undefined) {
        androidShareAbort = new AbortController();
        pending.files ??= await fetchAndroidShareFiles(pending.share, androidShareAbort.signal);
        if (androidShareDisconnected) return;
        const event: WebDragDropEvent = { payload: {
          type: "drop", text: pending.share.text, files: pending.files, intakeId: pending.share.id,
          complete: (persist) => { pending.persist = persist; },
        } };
        let claimed = false;
        for (const callback of webDragDropCallbacks) {
          const handled = callback(event);
          if (handled) { claimed = true; await handled; break; }
        }
        if (!claimed) { androidShareNeedsReceiver = true; return; }
        if (!pending.persist) throw new Error("Android share draft intake did not complete");
      }
      if (androidShareDisconnected) return;
      if (findImageDraftIntake(pending.share.id) === undefined) pending.persist?.();
      if (findImageDraftIntake(pending.share.id) === undefined) throw new Error("Android share draft receipt was not persisted");
      await callAndroid("acknowledgeShare", { id: pending.share.id });
      seen.add(pending.share.id);
      androidSharePending = undefined;
      androidShareStatus = { error: null, busy: true };
      // Drain only after success. A failure stops here until an explicit retry or ready event.
    }
  } catch (error) {
    androidShareReadyPending = false;
    androidShareStatus = { error: error instanceof Error ? error.message : String(error), busy: true };
    console.error("Android share intake failed; retry on the next share intake", error);
  } finally {
    androidShareAbort = undefined;
    androidShareRunning = false;
    androidShareStatus = { ...androidShareStatus, busy: false };
    publishAndroidShareStatus();
    // A ready event during a receiver gap is a new request, not a retry of a failed intake.
    if (androidShareReadyPending && !androidSharePending) void intakeAndroidShare();
  }
}

function onAndroidShareReady(): void {
  androidShareReadyPending = true;
  void intakeAndroidShare(true);
}

async function discardPendingAndroidShare(): Promise<void> {
  if (!isAndroidLocal || androidShareDisconnected || androidShareRunning) return;
  const target = androidSharePending;
  let advance = false;
  androidShareRunning = true;
  androidShareStatus = { ...androidShareStatus, busy: true };
  publishAndroidShareStatus();
  try {
    const discarded = await discardAndroidShare(target?.share.id);
    if (androidShareDisconnected) return;
    if (discarded && androidSharePending === target) {
      androidSharePending = undefined;
      androidShareNeedsReceiver = false;
      androidShareStatus = { error: null, busy: true };
      advance = true;
    }
  } catch (error) {
    androidShareReadyPending = false;
    androidShareStatus = { error: error instanceof Error ? error.message : String(error), busy: true };
  } finally {
    androidShareRunning = false;
    androidShareStatus = { ...androidShareStatus, busy: false };
    publishAndroidShareStatus();
  }
  if (advance) await intakeAndroidShare(true);
}

if (isAndroidLocal) {
  window.addEventListener("jupiter:android-share-ready", onAndroidShareReady);
  window.addEventListener("jupiter:android-share-retry", onAndroidShareReady);
  window.addEventListener("jupiter:android-share-discard", () => { void discardPendingAndroidShare(); });
  window.addEventListener("jupiter:android-share-status-request", publishAndroidShareStatus);
  window.addEventListener("pagehide", () => {
    androidShareDisconnected = true;
    androidShareAbort?.abort();
  });
}

function dispatchWebDragDrop(event: WebDragDropEvent): void {
  for (const callback of webDragDropCallbacks) callback(event);
}

function onWebDragEnter(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  webDragDropDepth += 1;
  if (webDragDropDepth === 1) dispatchWebDragDrop({ payload: { type: "enter" } });
}

function onWebDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function onWebDragLeave(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes("Files")) return;
  webDragDropDepth = Math.max(0, webDragDropDepth - 1);
  if (webDragDropDepth === 0) dispatchWebDragDrop({ payload: { type: "leave" } });
}

async function onWebDrop(event: DragEvent): Promise<void> {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  webDragDropDepth = 0;
  dispatchWebDragDrop({ payload: { type: "drop", files: Array.from(event.dataTransfer.files) } });
}

function installWebDragDropListeners(): void {
  window.addEventListener("dragenter", onWebDragEnter);
  window.addEventListener("dragover", onWebDragOver);
  window.addEventListener("dragleave", onWebDragLeave);
  window.addEventListener("drop", onWebDrop);
}

function removeWebDragDropListeners(): void {
  window.removeEventListener("dragenter", onWebDragEnter);
  window.removeEventListener("dragover", onWebDragOver);
  window.removeEventListener("dragleave", onWebDragLeave);
  window.removeEventListener("drop", onWebDrop);
  webDragDropDepth = 0;
}

export function getCurrentWebview(): {
  onDragDropEvent(callback: WebDragDropCallback): Promise<UnlistenFn>;
} {
  return {
    onDragDropEvent: async (callback: WebDragDropCallback): Promise<UnlistenFn> => {
      if (webDragDropCallbacks.size === 0) installWebDragDropListeners();
      webDragDropCallbacks.add(callback);
      if (isAndroidLocal) publishAndroidShareStatus();
      void intakeAndroidShare();
      return () => {
        webDragDropCallbacks.delete(callback);
        if (webDragDropCallbacks.size === 0) removeWebDragDropListeners();
      };
    },
  };
}

export type WebWindowHandle = {
  label: string;
  isFocused(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  isFullscreen(): Promise<boolean>;
  minimize(): Promise<void>;
  close(): Promise<void>;
  toggleMaximize(): Promise<void>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  unminimize(): Promise<void>;
  show(): Promise<void>;
  hide(): Promise<void>;
  setFocus(): Promise<void>;
  listen<T = unknown>(event: string, callback: EventCallback<T>): Promise<UnlistenFn>;
};

const webWindow: WebWindowHandle = {
  label: "main",
  isFocused: async () => document.hasFocus(),
  isMaximized: async () => false,
  isFullscreen: async () => Boolean(document.fullscreenElement),
  minimize: async () => {},
  close: async () => {},
  toggleMaximize: async () => {},
  setFullscreen: async (fullscreen: boolean) => {
    if (fullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    else if (!fullscreen && document.fullscreenElement) await document.exitFullscreen();
  },
  unminimize: async () => {},
  show: async () => {},
  hide: async () => {},
  setFocus: async () => window.focus(),
  listen: async () => () => {},
};

export type Window = WebWindowHandle;

export function getCurrentWindow(): WebWindowHandle {
  return webWindow;
}

export async function currentMonitor(): Promise<null> {
  return null;
}

export class LogicalPosition {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

export class PhysicalPosition extends LogicalPosition {}

export class LogicalSize {
  constructor(
    public width: number,
    public height: number,
  ) {}
}

type WebviewEvent<T = unknown> = { payload: T };

export class Webview {
  constructor(
    _window: WebWindowHandle,
    _label: string,
    _options: Record<string, unknown>,
  ) {}

  async once<T = unknown>(
    event: string,
    callback: (event: WebviewEvent<T>) => void,
  ): Promise<UnlistenFn> {
    if (event === "tauri://created") queueMicrotask(() => callback({ payload: undefined as T }));
    return () => {};
  }

  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {}
  async setPosition(_position: LogicalPosition): Promise<void> {}
  async setSize(_size: LogicalSize): Promise<void> {}
}

export async function emitTo<T = unknown>(
  _target: string,
  event: string,
  payload?: T,
): Promise<void> {
  emitRuntimeEvent(event, payload);
}

export function convertFileSrc(path: string): string {
  if (/^jupiter-image:[a-f0-9]{64}$/.test(path)) return `/api/images/${path.slice(14)}?thumbnail=1`;
  if (/^(?:https?:|data:|blob:)/i.test(path)) return path;
  const fileId = webFileId(path);
  if (fileId) return `/api/files/${encodeURIComponent(fileId)}`;
  return path;
}

class WebMenuResource {
  static async new<T extends typeof WebMenuResource>(
    this: T,
    _options: Record<string, unknown>,
  ): Promise<InstanceType<T>> {
    return new this() as InstanceType<T>;
  }

  async close(): Promise<void> {}
}

export class MenuItem extends WebMenuResource {
  async setText(_text: string): Promise<void> {}
  async setEnabled(_enabled: boolean): Promise<void> {}
}

export class PredefinedMenuItem extends WebMenuResource {}

export class Menu extends WebMenuResource {
  async popup(_position?: unknown, _window?: WebWindowHandle): Promise<void> {}
}

export async function isPermissionGranted(): Promise<boolean> {
  return (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted" &&
    localStorage.getItem("jupiter.web.notifications") === "enabled"
  );
}

export async function requestPermission(): Promise<NotificationPermission> {
  if (typeof Notification === "undefined") return "denied";
  if (localStorage.getItem("jupiter.web.notifications") !== "enabled") return "default";
  if (!navigator.userActivation?.isActive) return Notification.permission;
  return Notification.requestPermission();
}

export function sendNotification(options: string | { title: string; body?: string }): void {
  if (isAndroidLocal) {
    const args = typeof options === "string" ? { title: options } : options;
    void callAndroid("notify", args).catch(() => undefined);
    return;
  }
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted" ||
    localStorage.getItem("jupiter.web.notifications") !== "enabled"
  )
    return;
  const title = typeof options === "string" ? options : options.title;
  const notificationOptions = typeof options === "string" ? undefined : { body: options.body };
  new Notification(title, notificationOptions);
}

export async function check(): Promise<null> {
  return null;
}

export async function open(options?: any): Promise<any> {
  if (options?.directory) return pickApprovedWorkspace();
  const files = await pickBrowserFiles(options);
  const uploaded = await Promise.all(files.map((file) => uploadWebFile(file, file.name)));
  const tokens = uploaded.map((file) => file.token);
  return options?.multiple ? tokens : (tokens[0] ?? "");
}

export async function save(options?: any): Promise<any> {
  const suggested = String(options?.defaultPath || "jupiter-export.md").split(/[\\/]/).pop();
  return `jupiter-download:${encodeURIComponent(suggested || "jupiter-export.md")}`;
}

export async function openUrl(url: string): Promise<void> {
  if (isAndroidLocal) { await callAndroid("openExternal", { url }); return; }
  console.log(`[tauri-bridge] open url -> ${url}`);
  window.open(url, "_blank", "noopener,noreferrer");
  return Promise.resolve();
}

export async function openPath(path: string, _openWith?: string): Promise<void> {
  const fileId = webFileId(path);
  if (isAndroidLocal && fileId) { await downloadAndroidFile(fileId, "jupiter-export"); return; }
  if (isAndroidLocal) {
    const file = await resolveWebWorkspaceFile(path);
    await downloadAndroidFile(file.id, file.name);
    return;
  }
  if (fileId) window.open(`/api/files/${encodeURIComponent(fileId)}`, "_blank", "noopener,noreferrer");
  return Promise.resolve();
}

export async function revealItemInDir(path: string): Promise<void> {
  console.log(`[tauri-bridge] reveal path -> ${path}`);
}

export async function relaunch(): Promise<void> {
  console.log("[tauri-bridge] process relaunch (reload page)");
  window.location.reload();
  return Promise.resolve();
}

export const shellServices = Object.freeze({
  getCurrentWebview,
  getCurrentWindow,
  open,
  save,
  openUrl,
  openPath,
  revealItemInDir,
  relaunch,
});

function webFileId(path: string): string | null {
  return /^jupiter-file:([0-9a-f-]{36})$/i.exec(path)?.[1] ?? null;
}

function pickBrowserFiles(options: any): Promise<File[]> {
  return new Promise<File[]>((resolveFiles) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options?.multiple === true;
    input.accept = Array.isArray(options?.filters)
      ? options.filters
          .flatMap((filter: { extensions?: string[] }) => filter.extensions ?? [])
          .map((extension: string) => `.${extension.replace(/^\./, "")}`)
          .join(",")
      : "";
    input.style.display = "none";
    document.body.appendChild(input);
    let settled = false;
    let focusTimer: number | undefined;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      if (focusTimer !== undefined) window.clearTimeout(focusTimer);
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
      input.remove();
      resolveFiles(files);
    };
    const onFocus = () => { focusTimer = window.setTimeout(() => finish(Array.from(input.files ?? [])), 300); };
    const onChange = () => finish(Array.from(input.files ?? []));
    const onCancel = () => finish([]);
    input.addEventListener("change", onChange, { once: true });
    input.addEventListener("cancel", onCancel, { once: true });
    window.addEventListener("focus", onFocus, { once: true });
    input.click();
  });
}

async function pickApprovedWorkspace(): Promise<string> {
  if (isAndroidLocal) {
    const workspace = await callAndroid<{ id: string } | null>("chooseWorkspace");
    if (!workspace?.id) return "";
    await getWebWorkspaceChoices(true);
    return `workspace://${workspace.id}`;
  }
  const workspaces = await getWebWorkspaceChoices();
  if (workspaces.length === 0) return "";
  return new Promise<string>((resolveChoice) => {
    const dialog = document.createElement("dialog");
    dialog.className = "web-workspace-dialog";
    const heading = document.createElement("h2");
    heading.textContent = "Choose workspace";
    dialog.appendChild(heading);
    const list = document.createElement("div");
    list.className = "web-workspace-dialog-list";
    for (const workspace of workspaces) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = workspace.name;
      button.addEventListener("click", () => {
        dialog.returnValue = `workspace://${workspace.id}`;
        dialog.close();
      });
      list.appendChild(button);
    }
    dialog.appendChild(list);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "web-workspace-dialog-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => dialog.close());
    dialog.appendChild(cancel);
    dialog.addEventListener(
      "close",
      () => {
        const value = dialog.returnValue;
        dialog.remove();
        resolveChoice(value);
      },
      { once: true },
    );
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}
