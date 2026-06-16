import { existsSync } from "node:fs";
import { type SessionMeta, sanitizeName, sessionPath, timestampSuffix } from "./memory/session.js";
import type { ChatMessage, ChatRequestOptions } from "./types.js";

const TITLE_MODEL_MAX_TOKENS = 32;
const TITLE_MAX_CHARS = 48;
export const SESSION_TITLE_MODEL = "deepseek-v4-flash";
export const SESSION_TITLE_REASONING_EFFORT = "low";

export interface SessionTitleInput {
  workspace?: string;
  userText: string;
  assistantText?: string;
}

export interface SessionTitleClient {
  chat(opts: ChatRequestOptions): Promise<{ content: string }>;
}

export function buildSessionTitleMessages(input: SessionTitleInput): ChatMessage[] {
  const workspace = input.workspace?.trim();
  const assistant = input.assistantText?.trim();
  const parts = [
    workspace ? `Workspace: ${workspace}` : "",
    `User request:\n${truncateForPrompt(input.userText, 1600)}`,
    assistant ? `Assistant answer:\n${truncateForPrompt(assistant, 1600)}` : "",
  ].filter(Boolean);
  return [
    {
      role: "system",
      content:
        "Generate a short session title for a coding/chat transcript. Output only the title, no quotes, no markdown, no prefix. Use the user's language when obvious. Keep it under 6 words or 18 CJK characters. Avoid punctuation.",
    },
    { role: "user", content: parts.join("\n\n") },
  ];
}

export async function generateSessionTitle(
  client: SessionTitleClient,
  model: string,
  input: SessionTitleInput,
): Promise<string | null> {
  const messages = buildSessionTitleMessages(input);
  const models = [SESSION_TITLE_MODEL, model]
    .map((name) => name.trim())
    .filter((name, index, all) => name && all.indexOf(name) === index);
  for (const titleModel of models) {
    try {
      const resp = await client.chat({
        model: titleModel,
        messages,
        temperature: 0.2,
        maxTokens: TITLE_MODEL_MAX_TOKENS,
        thinking: "disabled",
        reasoningEffort: SESSION_TITLE_REASONING_EFFORT,
      });
      const title = normalizeGeneratedSessionTitle(resp.content);
      if (title) return title;
    } catch {
      // Title generation is display-only. Try the active chat model next,
      // then fall back to a local title so sessions do not stay timestamped.
    }
  }
  return fallbackSessionTitle(input.userText);
}

export function normalizeGeneratedSessionTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let title = raw.trim();
  title = title.replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/\s*```$/, "");
  title = title.split(/\r?\n/)[0]?.trim() ?? "";
  title = title.replace(/^(title|session title|name)\s*[:：-]\s*/i, "");
  title = title.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "");
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/[。.!?！？；;，,、]+$/g, "").trim();
  if (!title) return null;
  return title.length > TITLE_MAX_CHARS ? title.slice(0, TITLE_MAX_CHARS).trim() : title;
}

export function makeSessionNameFromTitle(
  title: string | null | undefined,
  opts: {
    currentName?: string;
    exists?: (name: string) => boolean;
    suffix?: () => string;
  } = {},
): string | null {
  const normalized = normalizeGeneratedSessionTitle(title);
  if (!normalized) return null;
  const base = sanitizeName(
    normalized
      .replace(/[\s_]+/g, "-")
      .replace(/[^\w\-\u4e00-\u9fa5]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, ""),
  );
  if (!base) return null;
  const current = opts.currentName ? sanitizeName(opts.currentName) : "";
  const exists = opts.exists ?? ((name: string) => existsSync(sessionPath(name)));
  if (base === current || !exists(base)) return base;
  for (let i = 2; i <= 9; i++) {
    const candidate = `${base}-${i}`;
    if (candidate === current || !exists(candidate)) return candidate;
  }
  return `${base}-${opts.suffix?.() ?? timestampSuffix()}`;
}

export function shouldAutoNameSession(
  sessionName: string | undefined,
  meta: SessionMeta,
  completedTurns: number,
): boolean {
  if (!sessionName || completedTurns !== 1 || meta.autoTitleGenerated) return false;
  const name = sanitizeName(sessionName);
  return (
    /^default(?:-\d{12,14})?$/.test(name) ||
    /^desktop-\d{12,17}-\d+(?:-\d+)?$/.test(name) ||
    /^\d{12,17}$/.test(name) ||
    /^\d{12,17}-\d+(?:-\d+)?$/.test(name)
  );
}

function truncateForPrompt(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

function fallbackSessionTitle(userText: string): string | null {
  const cleaned = userText
    .replace(/@[^\s]+/g, " ")
    .replace(/\b\d{8,}\b/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\\/][^\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const firstClause = cleaned.split(/[。.!?！？；;，,\n\r]/)[0]?.trim() || cleaned;
  const cjk = firstClause.match(/[\u4e00-\u9fa5]/g);
  if (cjk && cjk.length >= 4) return cjk.slice(0, 7).join("");
  const words = firstClause
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");
  return normalizeGeneratedSessionTitle(words);
}
