import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("desktop/src/styles.css", "utf8");

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(css);
  return match?.groups?.body ?? "";
}

describe("desktop main transcript overflow", () => {
  it("prevents wide message content from creating a main horizontal scrollbar", () => {
    expect(cssRule(".main")).toContain("overflow-x: hidden");
    expect(cssRule(".thread")).toContain("overflow-x: hidden");
    expect(cssRule(".thread-inner")).toContain("min-width: 0");
    expect(cssRule(".thread-inner")).toContain("max-width: min(100%");
    expect(cssRule(".msg")).toContain("max-width: 100%");
    expect(cssRule(".msg .body")).toContain("max-width: 100%");
  });
});
