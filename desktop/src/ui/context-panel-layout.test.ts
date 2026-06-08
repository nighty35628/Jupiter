import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body ?? "";
}

describe("context panel home layout CSS", () => {
  it("keeps sidebar cards scrollable without visible scrollbars", () => {
    const homeRule = rule(".ctx-home");

    expect(homeRule).toContain("overflow-y: auto");
    expect(homeRule).toContain("scrollbar-width: none");
    expect(css).toContain(".ctx-home::-webkit-scrollbar");
    expect(css).toContain("display: none;");
  });

  it("switches sidebar cards between one and two columns based on sidebar width", () => {
    expect(rule(".ctx-home")).toContain("grid-template-columns: 1fr");
    expect(css).toContain("@container ctx (min-width: 440px)");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
  });

  it("keeps bottom bar cards in one horizontal row with sideways scrolling", () => {
    const bottomRule = rule('.ctx[data-placement="bottom"] .ctx-home');

    expect(bottomRule).toContain("grid-template-columns: none");
    expect(bottomRule).toContain("grid-auto-flow: column");
    expect(bottomRule).toContain("overflow-x: auto");
    expect(bottomRule).toContain("overflow-y: hidden");
  });
});
