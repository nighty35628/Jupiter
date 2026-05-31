import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("desktop/src/styles.css", "utf8");

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, "g"))];
  return matches.at(-1)?.groups?.body ?? "";
}

describe("desktop top tab layout", () => {
  it("lets regular tabs prefer a stable width but shrink before hiding the new-tab button", () => {
    expect(cssRule(".tabbar")).toContain("overflow: hidden");
    expect(cssRule(".tab:not(.newtab)")).toContain("flex: 1 1 var(--top-tab-width");
    expect(cssRule(".tab:not(.newtab)")).toContain("min-width: var(--top-tab-min-width");
    expect(cssRule(".tab:not(.newtab)")).toContain("max-width: var(--top-tab-width");
    expect(cssRule(".tab .label")).toContain("text-overflow: ellipsis");
    expect(cssRule(".tab .label")).toContain("min-width: 0");
    expect(cssRule(".tab.newtab")).toContain("flex: 0 0 auto");
  });
});
