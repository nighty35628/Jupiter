import * as webviewApi from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeBrowserWebview } from "./native-browser-webview";

const Webview = webviewApi.Webview as unknown as ReturnType<typeof vi.fn>;
const webviewMockState = webviewApi as unknown as {
  webviewInstances: Array<Record<string, any>>;
  webviewCreationEvents: Array<{
    event: "tauri://created" | "tauri://error";
    payload?: unknown;
  }>;
};
const webviewInstances = webviewMockState.webviewInstances;

describe("NativeBrowserWebview", () => {
  beforeEach(() => {
    webviewInstances.length = 0;
    webviewMockState.webviewCreationEvents.length = 0;
    vi.mocked(getCurrentWindow).mockClear();
  });

  it("creates a Tauri child webview at the requested bounds", async () => {
    const browser = new NativeBrowserWebview("sidebar-browser-test");

    await browser.open("https://example.com/", {
      x: 10,
      y: 20,
      width: 320,
      height: 240,
    });

    expect(Webview).toHaveBeenCalledWith(
      expect.objectContaining({ label: "main" }),
      "sidebar-browser-test",
      expect.objectContaining({
        url: "https://example.com/",
        x: 10,
        y: 20,
        width: 320,
        height: 240,
        focus: false,
        dragDropEnabled: false,
      }),
    );
    expect(webviewInstances[0]?.show).toHaveBeenCalled();
  });

  it("can create a native webview for a local html file", async () => {
    const browser = new NativeBrowserWebview("sidebar-browser-test");

    await browser.open("file:///repo/reports/index.html", {
      x: 10,
      y: 20,
      width: 320,
      height: 240,
    });

    expect(webviewInstances[0]?.options.url).toBe(
      "file:///repo/reports/index.html",
    );
    expect(webviewInstances[0]?.show).toHaveBeenCalled();
  });

  it("recreates the native webview when navigating to a new URL", async () => {
    const browser = new NativeBrowserWebview("sidebar-browser-test");

    await browser.open("https://example.com/", {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    await browser.open("https://openai.com/", {
      x: 1,
      y: 2,
      width: 300,
      height: 200,
    });

    expect(webviewInstances).toHaveLength(2);
    expect(webviewInstances[0]?.close).toHaveBeenCalled();
    expect(webviewInstances[1]?.options.url).toBe("https://openai.com/");
  });

  it("updates bounds without recreating when the URL is unchanged", async () => {
    const browser = new NativeBrowserWebview("sidebar-browser-test");

    await browser.open("https://example.com/", {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    await browser.open("https://example.com/", {
      x: 8,
      y: 9,
      width: 400,
      height: 300,
    });

    expect(webviewInstances).toHaveLength(1);
    expect(webviewInstances[0]?.setPosition).toHaveBeenCalledWith(
      expect.objectContaining({ x: 8, y: 9 }),
    );
    expect(webviewInstances[0]?.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 400, height: 300 }),
    );
  });

  it("waits for creation before applying concurrent same-url bounds updates", async () => {
    const browser = new NativeBrowserWebview("sidebar-browser-test");

    await Promise.all([
      browser.open("https://example.com/", {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      }),
      browser.open("https://example.com/", {
        x: 8,
        y: 9,
        width: 400,
        height: 300,
      }),
    ]);

    expect(webviewInstances).toHaveLength(1);
    expect(webviewInstances[0]?.setPosition).toHaveBeenCalledWith(
      expect.objectContaining({ x: 8, y: 9 }),
    );
    expect(webviewInstances[0]?.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 400, height: 300 }),
    );
    expect(webviewInstances[0]?.show).toHaveBeenCalledTimes(2);
  });

  it("closes the native webview when disposed", async () => {
    const browser = new NativeBrowserWebview("sidebar-browser-test");

    await browser.open("https://example.com/", {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    await browser.close();

    expect(webviewInstances[0]?.close).toHaveBeenCalled();
  });

  it("rejects with the native creation error", async () => {
    webviewMockState.webviewCreationEvents.push({
      event: "tauri://error",
      payload: "invalid webview label",
    });
    const browser = new NativeBrowserWebview("sidebar-browser-test");

    await expect(
      browser.open("https://example.com/", {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      }),
    ).rejects.toThrow("invalid webview label");
    expect(webviewInstances[0]?.show).not.toHaveBeenCalled();
  });
});
