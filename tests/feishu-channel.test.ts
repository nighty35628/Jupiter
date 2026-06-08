import { describe, expect, it, vi } from "vitest";
import {
  FeishuChannel,
  normalizeFeishuTextMessage,
  splitFeishuMessage,
} from "../src/feishu/channel.js";
import type { FeishuBotClient, FeishuInboundMessage } from "../src/feishu/types.js";

function message(overrides: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
  return {
    eventId: "event-1",
    messageId: "msg-1",
    chatId: "chat-1",
    chatType: "p2p",
    messageType: "text",
    content: JSON.stringify({ text: "hello" }),
    senderOpenId: "ou_user",
    mentions: [],
    ...overrides,
  };
}

describe("normalizeFeishuTextMessage", () => {
  it("extracts text content and removes mention tokens", () => {
    expect(
      normalizeFeishuTextMessage(
        JSON.stringify({ text: '<at user_id="ou_bot">Jupiter</at>  hello' }),
      ),
    ).toBe("hello");
  });

  it("returns null for invalid or empty text payloads", () => {
    expect(normalizeFeishuTextMessage("{")).toBeNull();
    expect(normalizeFeishuTextMessage(JSON.stringify({ text: "   " }))).toBeNull();
  });
});

describe("splitFeishuMessage", () => {
  it("keeps chunks within the configured character budget", () => {
    const chunks = splitFeishuMessage("a".repeat(3100), 1500);

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= 1500)).toBe(true);
  });
});

describe("FeishuChannel inbound policy", () => {
  it("submits direct text messages to Jupiter", () => {
    const onSubmitMessage = vi.fn();
    const client: FeishuBotClient = {
      start: vi.fn(),
      stop: vi.fn(),
      sendTextMessage: vi.fn(),
      onMessage: vi.fn(),
    };
    const channel = new FeishuChannel({
      client,
      config: { appId: "app", appSecret: "secret", requireMentionInGroup: true },
      onSubmitMessage,
    });

    channel.handleInboundMessage(message());

    expect(onSubmitMessage).toHaveBeenCalledWith("[Feishu] hello");
  });

  it("ignores group messages that do not mention the bot when mention is required", () => {
    const onSubmitMessage = vi.fn();
    const client: FeishuBotClient = {
      start: vi.fn(),
      stop: vi.fn(),
      sendTextMessage: vi.fn(),
      onMessage: vi.fn(),
    };
    const channel = new FeishuChannel({
      client,
      config: { appId: "app", appSecret: "secret", requireMentionInGroup: true },
      onSubmitMessage,
    });

    channel.handleInboundMessage(message({ chatType: "group", mentions: [] }));

    expect(onSubmitMessage).not.toHaveBeenCalled();
  });

  it("accepts group messages that mention the bot", () => {
    const onSubmitMessage = vi.fn();
    const client: FeishuBotClient = {
      start: vi.fn(),
      stop: vi.fn(),
      sendTextMessage: vi.fn(),
      onMessage: vi.fn(),
    };
    const channel = new FeishuChannel({
      client,
      config: { appId: "app", appSecret: "secret", requireMentionInGroup: true },
      onSubmitMessage,
    });

    channel.handleInboundMessage(
      message({
        chatType: "group",
        mentions: [{ openId: "ou_bot", name: "Jupiter", key: "@_user_1" }],
      }),
    );

    expect(onSubmitMessage).toHaveBeenCalledWith("[Feishu] hello");
  });
});

describe("FeishuChannel.sendResponse", () => {
  it("replies to the latest chat as Feishu markdown cards", async () => {
    const client: FeishuBotClient = {
      start: vi.fn(),
      stop: vi.fn(),
      sendTextMessage: vi.fn().mockResolvedValue(undefined),
      sendInteractiveMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn(),
    };
    const channel = new FeishuChannel({
      client,
      config: { appId: "app", appSecret: "secret", requireMentionInGroup: true },
      onSubmitMessage: () => undefined,
    });
    channel.handleInboundMessage(message());

    await channel.sendResponse("ok");

    expect(client.sendInteractiveMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        elements: [{ tag: "markdown", content: "ok" }],
      }),
    );
    expect(client.sendTextMessage).not.toHaveBeenCalled();
  });

  it("falls back to text when Feishu rejects the card payload", async () => {
    const client: FeishuBotClient = {
      start: vi.fn(),
      stop: vi.fn(),
      sendTextMessage: vi.fn().mockResolvedValue(undefined),
      sendInteractiveMessage: vi.fn().mockRejectedValue(new Error("bad card")),
      onMessage: vi.fn(),
    };
    const channel = new FeishuChannel({
      client,
      config: { appId: "app", appSecret: "secret", requireMentionInGroup: true },
      onSubmitMessage: () => undefined,
    });
    channel.handleInboundMessage(message());

    await channel.sendResponse("**ok**");

    expect(client.sendTextMessage).toHaveBeenCalledWith("chat-1", "**ok**");
  });

  it("can acknowledge a turn without leaving a stale typing state", async () => {
    const client: FeishuBotClient = {
      start: vi.fn(),
      stop: vi.fn(),
      sendTextMessage: vi.fn().mockResolvedValue(undefined),
      sendInteractiveMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn(),
    };
    const channel = new FeishuChannel({
      client,
      config: { appId: "app", appSecret: "secret", requireMentionInGroup: true },
      onSubmitMessage: () => undefined,
    });
    channel.handleInboundMessage(message());

    await channel.sendTurnReceipt();

    expect(client.sendTextMessage).toHaveBeenCalledWith("chat-1", "Jupiter 已收到请求，开始处理。");
  });
});
