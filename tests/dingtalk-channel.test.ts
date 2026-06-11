import { describe, expect, it, vi } from "vitest";
import {
  DingTalkChannel,
  normalizeDingTalkTextMessage,
  splitDingTalkMessage,
} from "../src/dingtalk/channel.js";
import type { DingTalkBotClient, DingTalkInboundMessage } from "../src/dingtalk/types.js";

function message(overrides: Partial<DingTalkInboundMessage> = {}): DingTalkInboundMessage {
  return {
    messageId: "msg-1",
    conversationId: "conv-1",
    conversationType: "1",
    msgtype: "text",
    text: { content: "hello" },
    senderId: "sender-1",
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=1",
    ...overrides,
  };
}

describe("normalizeDingTalkTextMessage", () => {
  it("extracts text content and removes a leading bot mention", () => {
    expect(normalizeDingTalkTextMessage({ content: "@Jupiter  hello" })).toBe("hello");
  });

  it("returns null for empty or non-text payloads", () => {
    expect(normalizeDingTalkTextMessage({ content: "   " })).toBeNull();
    expect(normalizeDingTalkTextMessage(undefined)).toBeNull();
  });
});

describe("splitDingTalkMessage", () => {
  it("keeps chunks within the configured character budget", () => {
    const chunks = splitDingTalkMessage("a".repeat(4500), 2000);

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
  });
});

describe("DingTalkChannel inbound policy", () => {
  it("submits direct text messages to Jupiter", () => {
    const onSubmitMessage = vi.fn();
    const client: DingTalkBotClient = {
      start: vi.fn(),
      stop: vi.fn(),
      sendTextMessage: vi.fn(),
      sendMarkdownMessage: vi.fn(),
      onMessage: vi.fn(),
    };
    const channel = new DingTalkChannel({
      client,
      config: { clientId: "app", clientSecret: "secret", requireMentionInGroup: true },
      onSubmitMessage,
    });

    channel.handleInboundMessage(message());

    expect(onSubmitMessage).toHaveBeenCalledWith("[DingTalk] hello");
  });

  it("ignores duplicate message ids", () => {
    const onSubmitMessage = vi.fn();
    const client: DingTalkBotClient = {
      start: vi.fn(),
      stop: vi.fn(),
      sendTextMessage: vi.fn(),
      sendMarkdownMessage: vi.fn(),
      onMessage: vi.fn(),
    };
    const channel = new DingTalkChannel({
      client,
      config: { clientId: "app", clientSecret: "secret", requireMentionInGroup: true },
      onSubmitMessage,
    });

    channel.handleInboundMessage(message());
    channel.handleInboundMessage(message());

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
  });

  it("accepts group messages with a leading bot mention when explicit mention metadata is absent", () => {
    const onSubmitMessage = vi.fn();
    const client: DingTalkBotClient = {
      start: vi.fn(),
      stop: vi.fn(),
      sendTextMessage: vi.fn(),
      sendMarkdownMessage: vi.fn(),
      onMessage: vi.fn(),
    };
    const channel = new DingTalkChannel({
      client,
      config: { clientId: "app", clientSecret: "secret", requireMentionInGroup: true },
      onSubmitMessage,
    });

    channel.handleInboundMessage(
      message({ conversationType: "2", text: { content: "@Jupiter  hello" } }),
    );

    expect(onSubmitMessage).toHaveBeenCalledWith("[DingTalk] hello");
  });
});

describe("DingTalkChannel.sendResponse", () => {
  it("replies to the latest session webhook as DingTalk markdown", async () => {
    const client: DingTalkBotClient = {
      start: vi.fn(),
      stop: vi.fn(),
      sendTextMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn(),
    };
    const channel = new DingTalkChannel({
      client,
      config: { clientId: "app", clientSecret: "secret", requireMentionInGroup: true },
      onSubmitMessage: () => undefined,
    });
    channel.handleInboundMessage(message());

    await channel.sendResponse("**ok**");

    expect(client.sendMarkdownMessage).toHaveBeenCalledWith(
      "https://oapi.dingtalk.com/robot/sendBySession?session=1",
      "Jupiter",
      "**ok**",
    );
    expect(client.sendTextMessage).not.toHaveBeenCalled();
  });

  it("falls back to text when DingTalk rejects markdown", async () => {
    const client: DingTalkBotClient = {
      start: vi.fn(),
      stop: vi.fn(),
      sendTextMessage: vi.fn().mockResolvedValue(undefined),
      sendMarkdownMessage: vi.fn().mockRejectedValue(new Error("bad markdown")),
      onMessage: vi.fn(),
    };
    const channel = new DingTalkChannel({
      client,
      config: { clientId: "app", clientSecret: "secret", requireMentionInGroup: true },
      onSubmitMessage: () => undefined,
    });
    channel.handleInboundMessage(message());

    await channel.sendResponse("**ok**");

    expect(client.sendTextMessage).toHaveBeenCalledWith(
      "https://oapi.dingtalk.com/robot/sendBySession?session=1",
      "**ok**",
    );
  });
});
