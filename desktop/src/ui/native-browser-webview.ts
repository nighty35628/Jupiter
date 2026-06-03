import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type NativeBrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function normalizeBounds(bounds: NativeBrowserBounds): NativeBrowserBounds {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}

function formatWebviewError(payload: unknown): Error {
  if (payload instanceof Error) return payload;
  if (typeof payload === "string") return new Error(payload);
  try {
    return new Error(JSON.stringify(payload));
  } catch {
    return new Error(String(payload));
  }
}

async function waitForWebviewCreated(webview: Webview): Promise<void> {
  let unlistenCreated: (() => void) | null = null;
  let unlistenError: (() => void) | null = null;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      unlistenCreated?.();
      unlistenError?.();
      unlistenCreated = null;
      unlistenError = null;
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    void webview.once("tauri://created", () => settle(resolve)).then((unlisten) => {
      unlistenCreated = unlisten;
      if (settled) cleanup();
    });
    void webview.once<unknown>("tauri://error", (event) => {
      settle(() => reject(formatWebviewError(event.payload)));
    }).then((unlisten) => {
      unlistenError = unlisten;
      if (settled) cleanup();
    });
  });
}

export class NativeBrowserWebview {
  private webview: Webview | null = null;
  private currentUrl: string | null = null;
  private ready: Promise<void> | null = null;
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly label: string) {}

  async open(
    url: string,
    bounds: NativeBrowserBounds,
    options: { forceReload?: boolean } = {},
  ): Promise<void> {
    return this.enqueue(() => this.openNow(url, bounds, options));
  }

  async setBounds(bounds: NativeBrowserBounds): Promise<void> {
    return this.enqueue(() => this.setBoundsNow(bounds));
  }

  async hide(): Promise<void> {
    return this.enqueue(async () => {
      const current = this.webview;
      if (!current) return;
      await this.ready;
      if (this.webview !== current) return;
      await current.hide();
    });
  }

  async close(): Promise<void> {
    return this.enqueue(() => this.closeNow());
  }

  private async enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.operation.then(task, task);
    this.operation = run.catch(() => undefined);
    return run;
  }

  private async openNow(
    url: string,
    bounds: NativeBrowserBounds,
    options: { forceReload?: boolean } = {},
  ): Promise<void> {
    const nextBounds = normalizeBounds(bounds);
    if (this.webview && this.currentUrl === url && !options.forceReload) {
      const current = this.webview;
      await this.ready;
      if (this.webview !== current) return;
      await this.setBoundsNow(nextBounds);
      await current.show();
      return;
    }

    await this.closeNow();
    this.currentUrl = url;
    const nextWebview = new Webview(getCurrentWindow(), this.label, {
      url,
      ...nextBounds,
      focus: false,
      dragDropEnabled: false,
    });
    this.webview = nextWebview;
    this.ready = waitForWebviewCreated(nextWebview).catch((error) => {
      if (this.webview === nextWebview) {
        this.webview = null;
        this.currentUrl = null;
        this.ready = null;
      }
      throw error;
    });
    await this.ready;
    if (this.webview !== nextWebview) return;
    await nextWebview.show();
  }

  private async setBoundsNow(bounds: NativeBrowserBounds): Promise<void> {
    const current = this.webview;
    if (!current) return;
    await this.ready;
    if (this.webview !== current) return;
    const nextBounds = normalizeBounds(bounds);
    await current.setPosition(new LogicalPosition(nextBounds.x, nextBounds.y));
    await current.setSize(new LogicalSize(nextBounds.width, nextBounds.height));
  }

  private async closeNow(): Promise<void> {
    const current = this.webview;
    const ready = this.ready;
    this.webview = null;
    this.currentUrl = null;
    this.ready = null;
    await ready?.catch(() => undefined);
    await current?.close();
  }
}
