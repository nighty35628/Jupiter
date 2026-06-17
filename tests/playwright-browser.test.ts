import { describe, expect, it } from "vitest";
import { resolvePlaywrightBrowser } from "../src/desktop/playwright-browser.js";

describe("resolvePlaywrightBrowser", () => {
  it("uses Chrome executable path when Chrome is available", () => {
    expect(
      resolvePlaywrightBrowser([
        {
          id: "browser-chrome",
          name: "Google Chrome",
          capability: "browser-automation",
          state: "available",
          executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          recommended: true,
        },
      ]),
    ).toEqual({
      browser: "chrome",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      launchMode: "system",
    });
  });

  it("falls back to Edge before Chromium", () => {
    const result = resolvePlaywrightBrowser([
      {
        id: "browser-chromium",
        name: "Chromium",
        capability: "browser-automation",
        state: "available",
        executablePath: "/usr/bin/chromium",
      },
      {
        id: "browser-edge",
        name: "Microsoft Edge",
        capability: "browser-automation",
        state: "available",
        executablePath: "/usr/bin/msedge",
      },
    ]);

    expect(result?.browser).toBe("edge");
  });
});
