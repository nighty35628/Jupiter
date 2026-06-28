import { describe, expect, it, vi } from "vitest";
import { detectOptionalComponents, installHintFor } from "../src/desktop/optional-components.js";

describe("detectOptionalComponents", () => {
  it("marks Chrome available when a Chrome executable exists", () => {
    const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const components = detectOptionalComponents({
      platform: "darwin",
      env: { HOME: "/Users/test", PATH: "/usr/bin" },
      exists: (path) => path === chromePath,
      which: () => null,
      runVersion: () => null,
    });

    expect(components.find((c) => c.id === "browser-chrome")).toMatchObject({
      state: "available",
      executablePath: chromePath,
      capability: "browser-automation",
      recommended: true,
    });
  });

  it("detects command-line tools through PATH", () => {
    const components = detectOptionalComponents({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      exists: () => false,
      which: (command) => (command === "ffmpeg" ? "/usr/bin/ffmpeg" : null),
      runVersion: (path) => (path === "/usr/bin/ffmpeg" ? "ffmpeg version 6.1" : null),
    });

    expect(components.find((c) => c.id === "ffmpeg")).toMatchObject({
      state: "available",
      version: "ffmpeg version 6.1",
      executablePath: "/usr/bin/ffmpeg",
    });
  });

  it("does not execute browser binaries while detecting availability", () => {
    const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const ffmpegPath = "C:\\Tools\\ffmpeg.exe";
    const runVersion = vi.fn((path: string) =>
      path === ffmpegPath ? "ffmpeg version 6.1" : "unexpected browser probe",
    );

    const components = detectOptionalComponents({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files", PATH: "C:\\Tools" },
      exists: (path) => path === chromePath,
      which: (command) => (command === "ffmpeg" ? ffmpegPath : null),
      runVersion,
    });

    expect(components.find((c) => c.id === "browser-chrome")).toMatchObject({
      state: "available",
      executablePath: chromePath,
      version: undefined,
    });
    expect(components.find((c) => c.id === "ffmpeg")).toMatchObject({
      state: "available",
      executablePath: ffmpegPath,
      version: "ffmpeg version 6.1",
    });
    expect(runVersion).toHaveBeenCalledTimes(1);
    expect(runVersion).toHaveBeenCalledWith(ffmpegPath, undefined);
  });

  it("returns platform-specific install hints", () => {
    expect(installHintFor("ffmpeg", "darwin")).toContain("brew install ffmpeg");
    expect(installHintFor("ffmpeg", "win32")).toContain("winget install");
    expect(installHintFor("ffmpeg", "linux")).toContain("apt install ffmpeg");
  });

  it("returns stable component ids for the settings UI", () => {
    const ids = detectOptionalComponents({
      platform: "linux",
      env: { PATH: "" },
      exists: () => false,
      which: () => null,
      runVersion: () => null,
    }).map((component) => component.id);

    expect(ids).toEqual([
      "browser-chrome",
      "browser-edge",
      "browser-chromium",
      "libreoffice",
      "ffmpeg",
      "tesseract",
      "pandoc",
    ]);
  });
});
