import { describe, expect, it, vi } from "vitest";
import { Usage } from "../src/client.js";
import { runDesktopLightAsk } from "../src/desktop/ask-light.js";
import type { ChatMessage } from "../src/types.js";

describe("desktop lightweight ask", () => {
  it("uses a minimal no-tool request, persists the visible exchange, and emits transcript events", async () => {
    const persisted: ChatMessage[] = [];
    const events: unknown[] = [];
    const client = {
      chat: vi.fn(async () => ({
        content: "你好，直接回答。",
        reasoningContent: null,
        toolCalls: [],
        usage: new Usage(31, 7, 38, 0, 31),
        raw: {},
      })),
    };

    const result = await runDesktopLightAsk({
      client,
      model: "deepseek-v4-flash",
      text: "你好",
      turn: 3,
      clientId: "ask-1",
      appendAndPersist: (message) => persisted.push(message),
      emit: (event) => events.push(event),
    });

    expect(result.content).toBe("你好，直接回答。");
    expect(client.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek-v4-flash",
        tools: [],
        messages: [expect.objectContaining({ role: "system" }), { role: "user", content: "你好" }],
      }),
    );
    expect(JSON.stringify(client.chat.mock.calls[0]?.[0])).not.toContain("codeSystemPrompt");
    expect(persisted).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，直接回答。" },
    ]);
    expect(events).toEqual([
      expect.objectContaining({ type: "user.message", text: "你好", clientId: "ask-1" }),
      expect.objectContaining({ type: "model.turn.started", turn: 3 }),
      expect.objectContaining({ type: "model.final", turn: 3, content: "你好，直接回答。" }),
      expect.objectContaining({ type: "$turn_complete" }),
    ]);
  });
});
