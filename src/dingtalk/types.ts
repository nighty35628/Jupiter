export interface DingTalkTextPayload {
  content?: string;
}

export interface DingTalkInboundMessage {
  messageId: string;
  conversationId: string;
  conversationType: string;
  msgtype: string;
  text?: DingTalkTextPayload;
  senderId?: string;
  senderNick?: string;
  sessionWebhook: string;
  isInAtList?: boolean;
}

export interface DingTalkBotClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendTextMessage(sessionWebhook: string, text: string): Promise<void>;
  sendMarkdownMessage(sessionWebhook: string, title: string, text: string): Promise<void>;
  onMessage(handler: (message: DingTalkInboundMessage) => void): void;
}
