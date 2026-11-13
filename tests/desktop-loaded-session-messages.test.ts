import { describe, expect, it } from "vitest";
import { buildLoadedMessages } from "../src/cli/commands/desktop.js";
import type { ChatMessage } from "../src/types.js";

describe("desktop loaded session messages", () => {
  it("keeps a bounded history page complete when reopened", () => {
    const text = "history paragraph\n".repeat(15_000);
    const loaded = buildLoadedMessages(
      [
        { role: "user", content: "previous question" },
        { role: "assistant", content: text },
        { role: "user", content: "latest question" },
        { role: "assistant", content: "latest answer" },
      ],
      { startTurn: 40 },
    );

    const oldAnswer = loaded[1];
    expect(oldAnswer).toMatchObject({ kind: "assistant", turn: 41 });
    expect(
      oldAnswer?.kind === "assistant" &&
        oldAnswer.segments.length === 1 &&
        oldAnswer.segments[0]?.kind === "text" &&
        oldAnswer.segments[0].text === text,
    ).toBe(true);
    expect(loaded.every((message) => message.displayTruncated === undefined)).toBe(true);
  });

  it("groups multiple assistant records from one user turn under the user turn", () => {
    const records: ChatMessage[] = [
      { role: "user", content: "inspect repo" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "file contents" },
      { role: "assistant", content: "done" },
      { role: "user", content: "next" },
      { role: "assistant", content: "second" },
    ];
    const loaded = buildLoadedMessages(records);

    expect(loaded).toHaveLength(4);
    expect(loaded[0]).toMatchObject({ kind: "user", text: "inspect repo" });
    expect(loaded[1]).toMatchObject({ kind: "assistant", turn: 1 });
    expect(loaded[1]?.kind === "assistant" ? loaded[1].segments : []).toMatchObject([
      {
        kind: "tool",
        callId: "call-1",
        name: "read_file",
        result: "file contents",
      },
      { kind: "text", text: "done" },
    ]);
    expect(loaded[2]).toMatchObject({ kind: "user", text: "next" });
    expect(loaded[3]).toMatchObject({ kind: "assistant", turn: 2 });
  });
});
