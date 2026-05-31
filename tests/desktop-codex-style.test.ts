import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("desktop/src/styles.css", "utf8");
const theme = readFileSync("desktop/src/theme.ts", "utf8");
const main = readFileSync("desktop/src/main.tsx", "utf8");
const app = readFileSync("desktop/src/App.tsx", "utf8");

describe("desktop Codex-style visual defaults", () => {
  it("defaults new installs to the quiet porcelain light style", () => {
    expect(theme).toContain("light: THEME_STYLE.PORCELAIN");
    expect(main).toContain("const theme = THEME.LIGHT");
    expect(app).toContain("return isTheme(v) ? v : THEME.LIGHT");
    expect(css).toContain(':root,\n[data-theme-style="porcelain"]');
  });

  it("keeps the shell visually lightweight like Codex", () => {
    expect(css).toContain("Codex visual pass");
    expect(css).toContain(".side-head .new-btn {\n  height: 34px;");
    expect(css).toContain("background: transparent;");
    expect(css).toContain(".composer {\n  border-color: var(--border);");
    expect(css).toContain("border-radius: 18px;");
    expect(css).toContain(".send-btn {\n  border-radius: 999px;");
    expect(css).toContain("background: var(--fg);");
  });
});
