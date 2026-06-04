import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("markdown code block rendering", () => {
  it("disables font ligatures in desktop and dashboard code blocks", () => {
    const desktopCss = readFileSync("desktop/src/styles.css", "utf8");
    const dashboardCss = readFileSync("dashboard/src/styles.css", "utf8");

    for (const css of [desktopCss, dashboardCss]) {
      expect(css).toContain(".markdown .codeview");
      expect(css).toContain("font-variant-ligatures: none");
      expect(css).toContain("font-feature-settings");
      expect(css).toContain('"liga" 0');
      expect(css).toContain('"calt" 0');
    }
  });
});
