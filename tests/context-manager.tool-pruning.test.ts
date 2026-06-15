import { describe, expect, it } from "vitest";
import {
  OLD_TOOL_RESULT_ELIDED_MARKER,
  pruneOldToolResultsForModelContext,
} from "../src/context-manager.js";
import type { ChatMessage } from "../src/types.js";

describe("old tool result pruning for model context", () => {
  it("elides old large tool results without touching recent turns or persisted source messages", () => {
    const oldResult = "large output ".repeat(80);
    const messages: ChatMessage[] = [
      { role: "user", content: "old task" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-old",
            type: "function",
            function: { name: "run_command", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-old", name: "run_command", content: oldResult },
      { role: "user", content: "current task" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-new",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-new", name: "read_file", content: oldResult },
    ];

    const pruned = pruneOldToolResultsForModelContext(messages, { maxToolResultChars: 120 });

    expect(pruned[1]?.role).toBe("assistant");
    expect(pruned[2]).toEqual({
      role: "tool",
      tool_call_id: "call-old",
      name: "run_command",
      content: OLD_TOOL_RESULT_ELIDED_MARKER,
    });
    expect(pruned[5]?.content).toBe(oldResult);
    expect(messages[2]?.content).toBe(oldResult);
  });
});
