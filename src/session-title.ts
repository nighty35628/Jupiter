import { existsSync } from "node:fs";
import { type SessionMeta, sanitizeName, sessionPath, timestampSuffix } from "./memory/session.js";
import type { ChatRequestOptions } from "./types.js";

const TITLE_MAX_CHARS = 48;

export interface SessionTitleInput {
  workspace?: string;
  userText: string;
  assistantText?: string;
}

export interface SessionTitleClient {
  chat(opts: ChatRequestOptions): Promise<{ content: string }>;
}

export async function generateSessionTitle(
  client: SessionTitleClient,
  model: string,
  input: SessionTitleInput,
): Promise<string | null> {
  void client;
  void model;
  return titleFromFirstSentence(input.userText);
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
  return title.length > TITLE_MAX_CHARS ? truncateTitle(title, TITLE_MAX_CHARS) : title;
}

export function titleFromFirstSentence(userText: string | null | undefined): string | null {
  if (!userText) return null;
  const trimmed = userText.trim();
  if (!trimmed) return null;
  const end = firstSentenceEnd(trimmed);
  const first = (end === -1 ? trimmed : trimmed.slice(0, end)).replace(/\s+/g, " ").trim();
  return normalizeGeneratedSessionTitle(first);
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

function firstSentenceEnd(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "\n" || char === "\r" || /[。！？；]/.test(char)) return i;
    if (char === "." && isAsciiSentenceBoundary(text, i)) return i;
    if ((char === "?" || char === "!" || char === ";") && isAsciiSentenceBoundary(text, i))
      return i;
  }
  return -1;
}

function isAsciiSentenceBoundary(text: string, index: number): boolean {
  const next = text[index + 1];
  return next === undefined || /\s|["'”’)\]}]/.test(next);
}

function truncateTitle(title: string, max: number): string {
  const sliced = title.slice(0, max).trim();
  if (!sliced.includes(" ")) return sliced;
  const atWordBoundary = title.length === max || /\s/.test(title[max] ?? "");
  if (atWordBoundary) return sliced;
  return sliced.replace(/\s+\S*$/, "").trim() || sliced;
}
