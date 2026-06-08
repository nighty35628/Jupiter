import { describe, expect, it } from "vitest";
import { highlightCode } from "./shiki-highlighter";

describe("highlightCode", () => {
  it("highlights TypeScript into token data", async () => {
    const lines = await highlightCode("const value: number = 1;", "typescript", "dark");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.flat().some((token) => token.color)).toBe(true);
  });

  it("falls back unknown languages to text", async () => {
    const lines = await highlightCode("<tag>", "definitely-unknown", "dark");
    expect(lines.flat().map((token) => token.content).join("")).toBe("<tag>");
  });

  it("uses different colors for light and dark themes", async () => {
    const dark = await highlightCode("const value = 1;", "typescript", "dark");
    const light = await highlightCode("const value = 1;", "typescript", "light");
    expect(dark.flat().find((token) => token.color)?.color).not.toBe(
      light.flat().find((token) => token.color)?.color,
    );
  });

  it("returns token content rather than html", async () => {
    const lines = await highlightCode("<script>alert(1)</script>", "html", "dark");
    expect(lines.flat().map((token) => token.content).join("")).toBe(
      "<script>alert(1)</script>",
    );
  });
});
