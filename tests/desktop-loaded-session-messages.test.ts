import { describe, expect, it } from "vitest";
import { buildLoadedMessages } from "../src/cli/commands/desktop.js";
import type { ChatMessage } from "../src/types.js";

describe("desktop loaded session messages", () => {
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
