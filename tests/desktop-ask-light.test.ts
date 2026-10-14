import { describe, expect, it, vi } from "vitest";
import { Usage } from "../src/client.js";
import { LIGHT_ASK_SYSTEM_PROMPT, runDesktopLightAsk } from "../src/desktop/ask-light.js";
import type { ChatMessage } from "../src/types.js";

describe("desktop lightweight ask", () => {
  it("injects host help with runtime capabilities, tools empty, and persists no help", async () => {
    const requests: Array<{ messages: ChatMessage[]; tools: [] }> = [];
    const persisted: ChatMessage[] = [];
    const onHelpTopic = vi.fn();
    await runDesktopLightAsk({
      client: {
        chat: async (request) => {
          requests.push(request);
          return { content: "answer", usage: new Usage(2, 1, 3, 0, 2) };
        },
      },
      model: "fake-model",
      text: "你是谁？",
      turn: 1,
      emit: () => {},
      helpContext: () => ({ surface: "desktop", model: "fake-model", provider: "third-party" }),
      onHelpTopic,
      appendAndPersist: (message) => persisted.push(message),
    });
    expect(requests[0]?.tools).toEqual([]);
    expect(JSON.stringify(requests[0]?.messages)).toContain("third-party");
    expect(JSON.stringify(requests[0]?.messages)).toContain("nightytech");
    expect(requests[0]?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "system",
    ]);
    expect(requests[0]?.messages[0]?.content).toBe(LIGHT_ASK_SYSTEM_PROMPT);
    expect(onHelpTopic).toHaveBeenCalledWith("identity");
    expect(persisted).toEqual([
      { role: "user", content: "你是谁？" },
      { role: "assistant", content: "answer" },
    ]);
  });
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

  it("can suppress the optimistic user echo when the caller already persisted and acknowledged it", async () => {
    const events: Array<{ type: string }> = [];
    await runDesktopLightAsk({
      client: {
        chat: vi.fn(async () => ({
          content: "answer",
          reasoningContent: null,
          usage: new Usage(2, 1, 3, 0, 2),
        })),
      },
      model: "deepseek-chat",
      text: "question",
      turn: 1,
      emitUserMessage: false,
      emit: (event) => events.push(event),
    });

    expect(events.some((event) => event.type === "user.message")).toBe(false);
    expect(events.map((event) => event.type)).toEqual([
      "model.turn.started",
      "model.final",
      "$turn_complete",
    ]);
  });
});
