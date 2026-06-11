import {
  DWClient,
  type DWClientDownStream,
  EventAck,
  type RobotMessage,
  TOPIC_ROBOT,
} from "dingtalk-stream";
import type { DingTalkBotClient, DingTalkInboundMessage } from "./types.js";

function toInboundMessage(data: RobotMessage): DingTalkInboundMessage | null {
  if (data.msgtype !== "text") return null;
  const raw = data as RobotMessage & { isInAtList?: boolean };
  return {
    messageId: data.msgId,
    conversationId: data.conversationId,
    conversationType: data.conversationType,
    msgtype: data.msgtype,
    text: data.text,
    senderId: data.senderId,
    senderNick: data.senderNick,
    sessionWebhook: data.sessionWebhook,
    isInAtList: raw.isInAtList,
  };
}

function parseRobotMessage(event: DWClientDownStream): DingTalkInboundMessage | null {
  if (event.headers.topic !== TOPIC_ROBOT) return null;
  try {
    const data = JSON.parse(event.data) as RobotMessage;
    return toInboundMessage(data);
  } catch {
    return null;
  }
}

function validateSessionWebhook(rawUrl: string): string {
  const url = new URL(rawUrl);
  const trusted =
    url.protocol === "https:" &&
    (url.hostname === "oapi.dingtalk.com" ||
      url.hostname === "api.dingtalk.com" ||
      url.hostname.endsWith(".dingtalk.com"));
  if (!trusted || url.username || url.password) {
    throw new Error(`Unexpected DingTalk session webhook: ${rawUrl}`);
  }
  return url.toString();
}

export class DingTalkStreamBotClient implements DingTalkBotClient {
  private client: DWClient;
  private handlers: Array<(message: DingTalkInboundMessage) => void> = [];

  constructor(config: { clientId: string; clientSecret: string }) {
    this.client = new DWClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      ua: "jupiter",
    });
    this.client.registerAllEventListener((event) => {
      const msg = parseRobotMessage(event);
      if (msg) {
        for (const handler of this.handlers) handler(msg);
      }
      return { status: EventAck.SUCCESS };
    });
  }

  onMessage(handler: (message: DingTalkInboundMessage) => void): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    await this.client.connect();
  }

  async stop(): Promise<void> {
    this.client.disconnect();
  }

  private async sendWebhookMessage(
    sessionWebhook: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const url = validateSessionWebhook(sessionWebhook);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DingTalk send failed (${res.status}): ${text}`);
    }
  }

  async sendTextMessage(sessionWebhook: string, text: string): Promise<void> {
    await this.sendWebhookMessage(sessionWebhook, {
      msgtype: "text",
      text: { content: text },
    });
  }

  async sendMarkdownMessage(sessionWebhook: string, title: string, text: string): Promise<void> {
    await this.sendWebhookMessage(sessionWebhook, {
      msgtype: "markdown",
      markdown: { title, text },
    });
  }
}
