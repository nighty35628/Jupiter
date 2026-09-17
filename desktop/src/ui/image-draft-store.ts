import { invoke } from "@tauri-apps/api/core";
import { type MessageDraft, isImageAttachment } from "../../../src/attachments/types";
import type { ComposerSendPayload, QueuedComposerDraft } from "./composer";

const PREFIX = "jupiter.image-draft.v1:";
export interface ImageDraftRecord extends MessageDraft {
  queue?: (string | QueuedComposerDraft)[];
  pending?: { clientId: string; draft: MessageDraft; ask: boolean; plan: boolean };
}
const cache = new Map<string, ImageDraftRecord>();
const listeners = new Map<string, Set<() => void>>();
let retentionTab: string | undefined;
let retentionTimer: ReturnType<typeof setTimeout> | undefined;
let retentionRevision = 0;

export function syncImageDraftReferences(tabId?: string): void {
  if (tabId) retentionTab = tabId;
  if (!retentionTab) return;
  clearTimeout(retentionTimer);
  retentionTimer = setTimeout(() => {
    try {
      const ids = new Set<string>();
      const visit = (value: unknown): void => {
        if (isImageAttachment(value)) ids.add(value.id);
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") Object.values(value).forEach(visit);
      };
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(PREFIX)) visit(JSON.parse(localStorage.getItem(key) || "null"));
      }
      for (const draft of cache.values()) visit(draft);
      let owner = localStorage.getItem("jupiter.image-draft.owner");
      if (!owner) {
        owner = crypto.randomUUID();
        localStorage.setItem("jupiter.image-draft.owner", owner);
      }
      if (!ids.size && !localStorage.getItem("jupiter.image-draft.synced")) return;
      retentionRevision = Math.max(Date.now() * 1000, retentionRevision + 1);
      void invoke("rpc_send", {
        line: JSON.stringify({
          cmd: "attachment_draft_refs",
          tabId: retentionTab,
          owner,
          revision: retentionRevision,
          ids: [...ids],
        }),
      }).then(
        () => localStorage.setItem("jupiter.image-draft.synced", "1"),
        () => {
          /* Offline drafts retry retention on the next connection/update. */
        },
      );
    } catch {
      /* An unreadable draft must not clear previously retained references. */
    }
  }, 300);
}

function validDraft(value: unknown): value is MessageDraft {
  const draft = value as MessageDraft | null;
  return (
    !!draft &&
    typeof draft.text === "string" &&
    draft.text.length <= 2 * 1024 * 1024 &&
    (draft.attachments === undefined ||
      (Array.isArray(draft.attachments) &&
        draft.attachments.length <= 12 &&
        draft.attachments.every(isImageAttachment)))
  );
}

export function readImageDraft(key: string): ImageDraftRecord {
  const existing = cache.get(key);
  if (existing) return existing;
  let draft: ImageDraftRecord = { text: "", attachments: [] };
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + key) || "null");
    if (validDraft(value)) {
      draft = { text: value.text, attachments: value.attachments ?? [] };
      const record = value as ImageDraftRecord;
      if (Array.isArray(record.queue))
        draft.queue = record.queue.filter(
          (item) =>
            typeof item === "string" ||
            validDraft({ text: item?.text, attachments: item?.payload?.attachments }),
        );
      if (
        record.pending &&
        typeof record.pending.clientId === "string" &&
        record.pending.clientId.length <= 256 &&
        validDraft(record.pending.draft)
      )
        draft.pending = record.pending;
    }
  } catch {
    /* Keep composing when browser storage is unavailable. */
  }
  cache.set(key, draft);
  return draft;
}

export function writeImageDraft(
  key: string,
  change: (draft: ImageDraftRecord) => ImageDraftRecord,
): void {
  const next = change(readImageDraft(key));
  cache.set(key, next);
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(next));
  } catch {
    /* The live copy remains available. */
  }
  syncImageDraftReferences();
  for (const listener of listeners.get(key) ?? []) listener();
  for (const cachedKey of cache.keys()) {
    if (cache.size <= 64) break;
    if (cachedKey !== key && !listeners.get(cachedKey)?.size) cache.delete(cachedKey);
  }
}

export function subscribeImageDraft(key: string, listener: () => void): () => void {
  const subscribers = listeners.get(key) ?? new Set();
  subscribers.add(listener);
  listeners.set(key, subscribers);
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) listeners.delete(key);
  };
}

export function rememberImageSubmission(
  key: string,
  clientId: string,
  draft: MessageDraft,
  payload: ComposerSendPayload,
): void {
  if (!draft.attachments?.length) return;
  writeImageDraft(key, (value) => ({
    ...value,
    pending: { clientId, draft, ask: payload.ask === true, plan: payload.plan === true },
  }));
}

export function acknowledgeImageSubmission(clientId: string): void {
  const keys = new Set(cache.keys());
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.add(key.slice(PREFIX.length));
    }
  } catch {
    /* In-memory drafts still reconcile. */
  }
  for (const key of keys) {
    if (readImageDraft(key).pending?.clientId !== clientId) continue;
    writeImageDraft(key, (value) => {
      const { pending: _pending, ...rest } = value;
      return rest;
    });
  }
}

export function imageSubmissionId(key: string, draft: MessageDraft): string | undefined {
  const pending = readImageDraft(key).pending;
  return pending &&
    pending.draft.text === draft.text &&
    JSON.stringify(pending.draft.attachments?.map((image) => image.id)) ===
      JSON.stringify(draft.attachments?.map((image) => image.id))
    ? pending.clientId
    : undefined;
}
