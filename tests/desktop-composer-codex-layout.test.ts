import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const composer = readFileSync("desktop/src/ui/composer.tsx", "utf8");
const css = readFileSync("desktop/src/styles.css", "utf8");

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(css);
  return match?.groups?.body ?? "";
}

function lastCssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, "g"))];
  return matches.at(-1)?.groups?.body ?? "";
}

describe("desktop composer Codex-style lower tools", () => {
  it("removes the hint row above the input and moves controls into the composer footer", () => {
    expect(composer).not.toContain('className="hint-row"');
    expect(composer).toContain('className="composer-left-tools"');
    expect(composer).toContain('className="composer-plus-btn"');
    expect(composer).toContain('className="composer-plus-menu"');
    expect(composer).toContain("function PermissionModeMenu");
    expect(composer).toContain('className="composer-permission"');
    expect(composer).toContain('className="composer-mode-menu"');
    expect(composer).toContain("fmtElapsed(busyElapsedMs ?? 0)");
  });

  it("keeps the plus and permission controls compact enough for narrow windows", () => {
    expect(cssRule(".composer-left-tools")).toContain("display: inline-flex");
    expect(cssRule(".composer-plus-btn")).toContain("width: 30px");
    expect(cssRule(".composer-plus-btn")).toContain("border-radius: 999px");
    expect(cssRule(".composer-permission")).toContain("height: 30px");
    expect(cssRule(".composer-permission")).toContain("max-width: 148px");
    expect(cssRule(".composer-foot .composer-busy-status")).toContain("border-radius: 999px");
    expect(css).toContain(".composer-plus-menu,\n.composer-mode-menu");
    expect(css).toContain("@container composer (max-width: 520px)");
    expect(css).toContain(".composer-foot .composer-busy-status {\n    display: none;");
  });

  it("does not fade transcript content behind the composer", () => {
    expect(lastCssRule(".composer-wrap")).not.toContain("linear-gradient");
    expect(lastCssRule(".composer-wrap::before")).toContain("content: none");
  });
});
