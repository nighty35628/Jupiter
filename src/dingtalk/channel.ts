import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type LoadedDingTalkConfig, loadDingTalkConfig } from "../config.js";
import { loadDotenv } from "../env.js";
import { DingTalkStreamBotClient } from "./bot.js";
import type { DingTalkBotClient, DingTalkInboundMessage, DingTalkTextPayload } from "./types.js";

const DINGTALK_LOCK_FILE = join(homedir(), ".jupiter", "dingtalk-channel.pid");
const DINGTALK_MAX_CHARS = 2000;
const LEADING_AT_RE = /^@\S+\s*/u;

export function splitDingTalkMessage(text: string, maxChars = DINGTALK_MAX_CHARS): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxChars));
    remaining = remaining.slice(maxChars);
  }
  return chunks.length > 0 ? chunks : ["(empty response)"];
}

export function normalizeDingTalkTextMessage(
  payload: DingTalkTextPayload | undefined,
): string | null {
  const raw = typeof payload?.content === "string" ? payload.content : "";
  const text = raw.replace(LEADING_AT_RE, "").trim();
  return text ? text : null;
}

function isDirectConversation(msg: DingTalkInboundMessage): boolean {
  return msg.conversationType === "1";
}

function mentionsBot(msg: DingTalkInboundMessage): boolean {
  return msg.isInAtList === true || LEADING_AT_RE.test(msg.text?.content ?? "");
}

export class DingTalkChannel {
  private client: DingTalkBotClient | null;
  private latestSessionWebhook: string | null = null;
  private processedMessageIds = new Set<string>();
  private processedMessageQueue: string[] = [];
  private lockAcquired = false;

  constructor(
    private args: {
      client?: DingTalkBotClient;
      config?: LoadedDingTalkConfig;
      onSubmitMessage: (text: string) => void;
      onError?: (msg: string) => void;
      onInfo?: (msg: string) => void;
    },
  ) {
    this.client = args.client ?? null;
  }

  private get config(): LoadedDingTalkConfig {
    return this.args.config ?? loadDingTalkConfig();
  }

  private rememberMessage(id: string): boolean {
    if (this.processedMessageIds.has(id)) return false;
    this.processedMessageIds.add(id);
    this.processedMessageQueue.push(id);
    if (this.processedMessageQueue.length > 200) {
      const oldest = this.processedMessageQueue.shift();
      if (oldest) this.processedMessageIds.delete(oldest);
    }
    return true;
  }

  private acquireLock(): void {
    try {
      const existing = Number(readFileSync(DINGTALK_LOCK_FILE, "utf8").trim());
      if (Number.isInteger(existing) && existing > 0 && existing !== process.pid) {
        try {
          process.kill(existing, 0);
          throw new Error(`DingTalk channel is already running in process ${existing}.`);
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code !== "ESRCH") throw err;
        }
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }

    mkdirSync(dirname(DINGTALK_LOCK_FILE), { recursive: true });
    writeFileSync(DINGTALK_LOCK_FILE, String(process.pid), "utf8");
    this.lockAcquired = true;
  }

  private releaseLock(): void {
    if (!this.lockAcquired) return;
    try {
      const existing = Number(readFileSync(DINGTALK_LOCK_FILE, "utf8").trim());
      if (existing === process.pid) unlinkSync(DINGTALK_LOCK_FILE);
    } catch {}
    this.lockAcquired = false;
  }

  handleInboundMessage(msg: DingTalkInboundMessage): void {
    if (!this.rememberMessage(msg.messageId)) return;
    if (msg.msgtype !== "text") return;
    if (this.config.requireMentionInGroup && !isDirectConversation(msg) && !mentionsBot(msg)) {
      return;
    }
    const text = normalizeDingTalkTextMessage(msg.text);
    if (!text) return;

    this.latestSessionWebhook = msg.sessionWebhook;
    this.args.onSubmitMessage(`[DingTalk] ${text}`);
  }

  async start(): Promise<void> {
    loadDotenv();
    this.acquireLock();
    const config = this.config;
    if (!config.clientId) {
      this.releaseLock();
      throw new Error("DingTalk Client ID is required.");
    }
    if (!config.clientSecret) {
      this.releaseLock();
      throw new Error("DingTalk Client Secret is required.");
    }
    const client =
      this.client ??
      new DingTalkStreamBotClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      });
    client.onMessage((msg) => this.handleInboundMessage(msg));
    this.client = client;
    try {
      await client.start();
      this.args.onInfo?.("DingTalk bot connected.");
    } catch (err) {
      this.releaseLock();
      throw err;
    }
  }

  async sendResponse(text: string): Promise<void> {
    if (!this.client || !this.latestSessionWebhook) return;
    for (const chunk of splitDingTalkMessage(text)) {
      if (!chunk) continue;
      try {
        await this.client.sendMarkdownMessage(this.latestSessionWebhook, "Jupiter", chunk);
      } catch {
        await this.client.sendTextMessage(this.latestSessionWebhook, chunk);
      }
    }
  }

  async sendTurnReceipt(): Promise<void> {
    if (!this.client || !this.latestSessionWebhook) return;
    await this.client.sendTextMessage(this.latestSessionWebhook, "Jupiter 已收到请求，开始处理。");
  }

  async stop(): Promise<void> {
    try {
      await this.client?.stop();
    } finally {
      this.releaseLock();
    }
  }
}
