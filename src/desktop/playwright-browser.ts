import type { OptionalComponentStatus } from "./optional-components.js";

export type PlaywrightBrowserResolution = {
  browser: "chrome" | "edge" | "chromium";
  executablePath: string;
  launchMode: "system";
} | null;

const ORDER = ["browser-chrome", "browser-edge", "browser-chromium"] as const;

export function resolvePlaywrightBrowser(
  components: readonly OptionalComponentStatus[],
): PlaywrightBrowserResolution {
  for (const id of ORDER) {
    const found = components.find((component) => component.id === id);
    if (found?.state === "available" && found.executablePath) {
      return {
        browser: id === "browser-chrome" ? "chrome" : id === "browser-edge" ? "edge" : "chromium",
        executablePath: found.executablePath,
        launchMode: "system",
      };
    }
  }
  return null;
}
