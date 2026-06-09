import { describe, expect, it } from "vitest";
import { detectBrowserAutomation } from "../src/desktop/browser-automation";

describe("detectBrowserAutomation", () => {
  it("prefers Chrome over Edge on macOS", () => {
    const status = detectBrowserAutomation({
      platform: "darwin",
      env: { HOME: "/Users/jrc" },
      exists: (path) =>
        path === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ||
        path === "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    });

    expect(status).toEqual({
      state: "available",
      browser: "chrome",
      name: "Google Chrome",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
  });

  it("prefers Edge over Chrome on Windows", () => {
    const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const status = detectBrowserAutomation({
      platform: "win32",
      env: {
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        ProgramFiles: "C:\\Program Files",
        LOCALAPPDATA: "C:\\Users\\jrc\\AppData\\Local",
      },
      exists: (path) => path === edgePath || path === chromePath,
    });

    expect(status).toEqual({
      state: "available",
      browser: "edge",
      name: "Microsoft Edge",
      executablePath: edgePath,
    });
  });

  it("uses PATH candidates on Linux", () => {
    const status = detectBrowserAutomation({
      platform: "linux",
      env: {},
      exists: () => false,
      which: (command) => (command === "google-chrome" ? "/usr/bin/google-chrome" : null),
    });

    expect(status).toEqual({
      state: "available",
      browser: "chrome",
      name: "Google Chrome",
      executablePath: "/usr/bin/google-chrome",
    });
  });

  it("falls back to WebView when no supported browser is installed", () => {
    const status = detectBrowserAutomation({
      platform: "darwin",
      env: { HOME: "/Users/jrc" },
      exists: () => false,
      which: () => null,
    });

    expect(status).toEqual({ state: "unavailable" });
  });
});
