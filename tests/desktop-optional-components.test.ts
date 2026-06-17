import { describe, expect, it } from "vitest";
import { detectOptionalComponents } from "../src/desktop/optional-components.js";
import { resolvePlaywrightBrowser } from "../src/desktop/playwright-browser.js";

describe("desktop optional component payload", () => {
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

  it("resolves browser automation from optional component status", () => {
    const components = detectOptionalComponents({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      exists: () => false,
      which: (command) => (command === "microsoft-edge" ? "/usr/bin/microsoft-edge" : null),
      runVersion: () => null,
    });

    expect(resolvePlaywrightBrowser(components)).toEqual({
      browser: "edge",
      executablePath: "/usr/bin/microsoft-edge",
      launchMode: "system",
    });
  });
});
