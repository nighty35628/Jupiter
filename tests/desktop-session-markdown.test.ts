import { describe, expect, it } from "vitest";
import {
  type SessionMarkdownMessage,
  assistantTextForTurn,
  formatSessionMarkdown,
} from "../src/desktop/session-markdown.js";

const labels = {
  user: "You",
  assistant: "Jupiter",
  reasoning: "Reasoning",
  tool: "Tool",
};

describe("desktop full-session markdown", () => {
  const messages: SessionMarkdownMessage[] = [
    { kind: "user", turn: 1, text: "hello" },
    {
      kind: "assistant",
      turn: 1,
      segments: [
        { kind: "reasoning", text: "think" },
        { kind: "tool", name: "read_file", args: '{"path":"a.ts"}', result: "ok" },
        { kind: "text", text: "answer" },
      ],
    },
  ];

  it("exports reasoning and tools from the full backend transcript", () => {
    const markdown = formatSessionMarkdown(messages, labels);
    expect(markdown).toContain("### You\n\nhello");
    expect(markdown).toContain("<summary>Reasoning</summary>");
    expect(markdown).toContain("Tool · `read_file`");
    expect(markdown).toContain("### Jupiter\n\n");
  });

  it("copies only final assistant text for a folded response", () => {
    expect(assistantTextForTurn(messages, 1)).toBe("answer");
  });
});
