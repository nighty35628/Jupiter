import { describe, expect, it } from "vitest";
import { buildFeishuMarkdownCard, splitFeishuMarkdown } from "../src/feishu/format.js";

describe("buildFeishuMarkdownCard", () => {
  it("wraps assistant markdown in a Feishu interactive card", () => {
    const card = buildFeishuMarkdownCard("## Title\n\n- [Docs](https://example.com)");

    expect(card.header?.title.content).toBe("Jupiter");
    expect(card.elements).toEqual([
      {
        tag: "markdown",
        content: "## Title\n\n- [Docs](https://example.com)",
      },
    ]);
  });

  it("uses a plain fallback when markdown is empty", () => {
    const card = buildFeishuMarkdownCard("   ");

    expect(card.elements[0]?.content).toBe("(empty response)");
  });
});

describe("splitFeishuMarkdown", () => {
  it("keeps card markdown chunks within budget", () => {
    const chunks = splitFeishuMarkdown("a".repeat(12), 5);

    expect(chunks).toEqual(["aaaaa", "aaaaa", "aa"]);
  });
});
