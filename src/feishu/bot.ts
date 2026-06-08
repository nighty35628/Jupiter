import * as lark from "@larksuiteoapi/node-sdk";
import type { FeishuBotClient, FeishuInboundMessage } from "./types.js";

type ReceiveEvent = Parameters<NonNullable<lark.EventHandles["im.message.receive_v1"]>>[0];

function toInboundMessage(data: ReceiveEvent): FeishuInboundMessage {
  return {
    eventId: data.event_id,
    messageId: data.message.message_id,
    chatId: data.message.chat_id,
    chatType: data.message.chat_type,
    messageType: data.message.message_type,
    content: data.message.content,
    senderOpenId: data.sender.sender_id?.open_id,
    mentions: (data.message.mentions ?? []).map((mention) => ({
      key: mention.key,
      name: mention.name,
      openId: mention.id.open_id,
      userId: mention.id.user_id,
      unionId: mention.id.union_id,
    })),
  };
}

export class FeishuSDKBotClient implements FeishuBotClient {
  private client: lark.Client;
  private wsClient: lark.WSClient;
  private dispatcher = new lark.EventDispatcher({});
  private handlers: Array<(message: FeishuInboundMessage) => void> = [];

  constructor(config: { appId: string; appSecret: string }) {
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });
    this.wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      autoReconnect: true,
      source: "jupiter",
    });
    this.dispatcher.register({
      "im.message.receive_v1": (data) => {
        const msg = toInboundMessage(data);
        for (const handler of this.handlers) handler(msg);
      },
    });
  }

  onMessage(handler: (message: FeishuInboundMessage) => void): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    await this.wsClient.start({ eventDispatcher: this.dispatcher });
  }

  async stop(): Promise<void> {
    this.wsClient.close({ force: true });
  }

  async sendTextMessage(chatId: string, text: string): Promise<void> {
    await this.client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  }

  async sendInteractiveMessage(chatId: string, card: Record<string, unknown>): Promise<void> {
    await this.client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
  }
}
