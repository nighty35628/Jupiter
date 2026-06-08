export interface FeishuMention {
  key?: string;
  name?: string;
  openId?: string;
  userId?: string;
  unionId?: string;
}

export interface FeishuInboundMessage {
  eventId?: string;
  messageId: string;
  chatId: string;
  chatType: string;
  messageType: string;
  content: string;
  senderOpenId?: string;
  mentions: FeishuMention[];
}

export interface FeishuBotClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendTextMessage(chatId: string, text: string): Promise<void>;
  sendInteractiveMessage(chatId: string, card: Record<string, unknown>): Promise<void>;
  onMessage(handler: (message: FeishuInboundMessage) => void): void;
}
