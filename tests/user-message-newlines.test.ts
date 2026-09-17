import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("user message rendering", () => {
  it("preserves whitespace and wraps long text in the shared Desktop/Web bubbles", () => {
    const css = readFileSync("desktop/src/styles.css", "utf8");
    expect(css).toContain(".msg-text {");
    expect(css).toContain("white-space: pre-wrap");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain(".msg-text .markdown");
    expect(css).toContain("white-space: normal");
  });
});
