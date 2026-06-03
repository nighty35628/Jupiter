import { vi } from "vitest";

export const webviewInstances: Webview[] = [];
export const webviewCreationEvents: Array<{
  event: "tauri://created" | "tauri://error";
  payload?: unknown;
}> = [];

export const Webview = vi.fn(function WebviewMock(
  this: Webview,
  window: unknown,
  label: string,
  options: Record<string, unknown>,
) {
  this.window = window;
  this.label = label;
  this.options = options;
  this.created = false;
  this.listeners = {};
  this.once = vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    this.listeners[event] = this.listeners[event] ?? [];
    this.listeners[event].push(handler);
    return Promise.resolve(() => {
      this.listeners[event] =
        this.listeners[event]?.filter((listener) => listener !== handler) ?? [];
    });
  });
  this.emit = vi.fn((event: string, payload?: unknown) => {
    if (event === "tauri://created") this.created = true;
    for (const listener of this.listeners[event] ?? []) listener({ payload });
    return Promise.resolve();
  });
  const requireCreated = () =>
    this.created ? Promise.resolve() : Promise.reject(new Error("webview not found"));
  this.show = vi.fn(requireCreated);
  this.hide = vi.fn(requireCreated);
  this.close = vi.fn(requireCreated);
  this.setPosition = vi.fn(requireCreated);
  this.setSize = vi.fn(requireCreated);
  this.setFocus = vi.fn(() => Promise.resolve());
  webviewInstances.push(this);
  queueMicrotask(() => {
    const creationEvent = webviewCreationEvents.shift() ?? { event: "tauri://created" as const };
    void this.emit(creationEvent.event, creationEvent.payload);
  });
});

export const getCurrentWebview = vi.fn(() => ({
  setZoomScale: vi.fn(),
}));

export const getAllWebviews = vi.fn(() => Promise.resolve(webviewInstances));

export type Webview = {
  window: unknown;
  label: string;
  options: Record<string, unknown>;
  created: boolean;
  listeners: Record<string, Array<(event: { payload: unknown }) => void>>;
  once: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
  setSize: ReturnType<typeof vi.fn>;
  setFocus: ReturnType<typeof vi.fn>;
};
