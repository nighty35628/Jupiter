import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type LoadedFeishuConfig, loadFeishuConfig } from "../config.js";
import { loadDotenv } from "../env.js";
import { FeishuSDKBotClient } from "./bot.js";
import { buildFeishuMarkdownCard, splitFeishuMarkdown } from "./format.js";
import type { FeishuBotClient, FeishuInboundMessage } from "./types.js";

const FEISHU_LOCK_FILE = join(homedir(), ".jupiter", "feishu-channel.pid");
const FEISHU_MAX_CHARS = 1500;
const FEISHU_AT_RE = /<at\b[^>]*>.*?<\/at>/giu;

export function splitFeishuMessage(text: string, maxChars = FEISHU_MAX_CHARS): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxChars));
    remaining = remaining.slice(maxChars);
  }
  return chunks;
}

export function normalizeFeishuTextMessage(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    if (typeof parsed.text !== "string") return null;
    const text = parsed.text.replace(FEISHU_AT_RE, "").trim();
    return text ? text : null;
  } catch {
    return null;
  }
}

export class FeishuChannel {
  private client: FeishuBotClient | null;
  private latestChatId: string | null = null;
  private processedEventIds = new Set<string>();
  private processedEventQueue: string[] = [];
  private lockAcquired = false;

  constructor(
    private args: {
      client?: FeishuBotClient;
      config?: LoadedFeishuConfig;
      onSubmitMessage: (text: string) => void;
      onError?: (msg: string) => void;
      onInfo?: (msg: string) => void;
    },
  ) {
    this.client = args.client ?? null;
  }

  private get config(): LoadedFeishuConfig {
    return this.args.config ?? loadFeishuConfig();
  }

  private rememberEvent(id: string): boolean {
    if (this.processedEventIds.has(id)) return false;
    this.processedEventIds.add(id);
    this.processedEventQueue.push(id);
    if (this.processedEventQueue.length > 200) {
      const oldest = this.processedEventQueue.shift();
      if (oldest) this.processedEventIds.delete(oldest);
    }
    return true;
  }

  private acquireLock(): void {
    try {
      const existing = Number(readFileSync(FEISHU_LOCK_FILE, "utf8").trim());
      if (Number.isInteger(existing) && existing > 0 && existing !== process.pid) {
        try {
          process.kill(existing, 0);
          throw new Error(`Feishu channel is already running in process ${existing}.`);
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code !== "ESRCH") throw err;
        }
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }

    mkdirSync(dirname(FEISHU_LOCK_FILE), { recursive: true });
    writeFileSync(FEISHU_LOCK_FILE, String(process.pid), "utf8");
    this.lockAcquired = true;
  }

  private releaseLock(): void {
    if (!this.lockAcquired) return;
    try {
      const existing = Number(readFileSync(FEISHU_LOCK_FILE, "utf8").trim());
      if (existing === process.pid) unlinkSync(FEISHU_LOCK_FILE);
    } catch {}
    this.lockAcquired = false;
  }

  handleInboundMessage(msg: FeishuInboundMessage): void {
    if (msg.eventId && !this.rememberEvent(msg.eventId)) return;
    if (msg.messageType !== "text") return;
    if (this.config.requireMentionInGroup && msg.chatType !== "p2p" && msg.mentions.length === 0) {
      return;
    }
    const text = normalizeFeishuTextMessage(msg.content);
    if (!text) return;

    this.latestChatId = msg.chatId;
    this.args.onSubmitMessage(`[Feishu] ${text}`);
  }

  async start(): Promise<void> {
    loadDotenv();
    this.acquireLock();
    const config = this.config;
    if (!config.appId) {
      this.releaseLock();
      throw new Error("Feishu App ID is required.");
    }
    if (!config.appSecret) {
      this.releaseLock();
      throw new Error("Feishu App Secret is required.");
    }
    const client =
      this.client ??
      new FeishuSDKBotClient({
        appId: config.appId,
        appSecret: config.appSecret,
      });
    client.onMessage((msg) => this.handleInboundMessage(msg));
    this.client = client;
    try {
      await client.start();
      this.args.onInfo?.("Feishu bot connected.");
    } catch (err) {
      this.releaseLock();
      throw err;
    }
  }

  async sendResponse(text: string): Promise<void> {
    if (!this.client || !this.latestChatId) return;
    for (const chunk of splitFeishuMarkdown(text)) {
      if (!chunk) continue;
      try {
        await this.client.sendInteractiveMessage(this.latestChatId, buildFeishuMarkdownCard(chunk));
      } catch {
        await this.client.sendTextMessage(this.latestChatId, chunk);
      }
    }
  }

  async sendTurnReceipt(): Promise<void> {
    if (!this.client || !this.latestChatId) return;
    await this.client.sendTextMessage(this.latestChatId, "Jupiter 已收到请求，开始处理。");
  }

  async stop(): Promise<void> {
    try {
      await this.client?.stop();
    } finally {
      this.releaseLock();
    }
  }
}
