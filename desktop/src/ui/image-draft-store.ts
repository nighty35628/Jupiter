import { invoke } from "@tauri-apps/api/core";
import { type MessageDraft, isImageAttachment } from "../../../src/attachments/types";
import type { ComposerSendPayload, QueuedComposerDraft } from "./composer";

const PREFIX = "jupiter.image-draft.v1:";
export interface ImageDraftRecord extends MessageDraft {
  shareIntakeIds?: string[];
  queue?: (string | QueuedComposerDraft)[];
  pending?: { clientId: string; draft: MessageDraft; ask: boolean; plan: boolean };
}
const cache = new Map<string, ImageDraftRecord>();
const listeners = new Map<string, Set<() => void>>();
const textRevisions = new Map<string, number>();

/** Runtime-only revision catches ABA edits without changing the persisted draft format. */
export function imageDraftTextRevision(key: string): number {
  return textRevisions.get(key) ?? 0;
}
type IntakeBinding = { key: string; next?: IntakeBinding };
// Live setter generations follow handoffs; a reused new-tab key gets a fresh generation.
const intakeBindings = new Map<string, IntakeBinding>();

function intakeBinding(key: string): IntakeBinding {
  let binding = intakeBindings.get(key);
  if (!binding) { binding = { key }; intakeBindings.set(key, binding); }
  return binding;
}

function resolveIntakeBinding(binding: IntakeBinding): string {
  let target = binding;
  while (target.next) target = target.next;
  return target.key;
}

function forwardIntakeBinding(sourceKey: string, targetKey: string): void {
  const source = intakeBindings.get(sourceKey);
  if (source) source.next = intakeBinding(targetKey);
  intakeBindings.delete(sourceKey);
}

export function conversationDraftKey(sessionId: string, conversationViewId: string): string {
  return `conversation:${JSON.stringify([sessionId, conversationViewId])}`;
}

function hasDraftPayload(draft: ImageDraftRecord): boolean {
  return !!(draft.text || draft.attachments?.length || draft.queue?.length || draft.pending);
}

function hasDraftContent(draft: ImageDraftRecord): boolean {
  return hasDraftPayload(draft) || !!draft.shareIntakeIds?.length;
}

function sameDraftPayload(source: ImageDraftRecord, target: ImageDraftRecord): boolean {
  return JSON.stringify({ ...source, shareIntakeIds: undefined }) === JSON.stringify({ ...target, shareIntakeIds: undefined });
}

function mergeDraftReceipts(source: ImageDraftRecord, target: ImageDraftRecord): ImageDraftRecord | undefined {
  if (hasDraftPayload(source) && hasDraftPayload(target) && !sameDraftPayload(source, target)) return undefined;
  const value = hasDraftPayload(source) ? source : target;
  const ids = [...new Set([...(source.shareIntakeIds ?? []), ...(target.shareIntakeIds ?? [])])];
  return ids.length ? { ...value, shareIntakeIds: ids } : value;
}

/** A new tab's local draft belongs to that tab, not to the legacy default view. */
export function handoffImageDraft(sourceKey: string, targetKey: string): boolean {
  if (sourceKey === targetKey) return true;
  const sourceDraft = readImageDraft(sourceKey);
  if (!hasDraftContent(sourceDraft)) {
    forwardIntakeBinding(sourceKey, targetKey);
    return true;
  }
  const targetDraft = readImageDraft(targetKey);
  const merged = mergeDraftReceipts(sourceDraft, targetDraft);
  if (!merged) return false;
  try {
    localStorage.setItem(PREFIX + targetKey, JSON.stringify(merged));
    cache.set(targetKey, merged);
    localStorage.removeItem(PREFIX + sourceKey);
    cache.delete(sourceKey);
    forwardIntakeBinding(sourceKey, targetKey);
    syncImageDraftReferences();
    return true;
  } catch {
    return false;
  }
}

/** Only the deterministic default view may claim a pre-view session draft. */
export function migrateConversationDraft(sessionId: string, conversationViewId: string, legacyKeys: string[] = [sessionId], defaultConversationViewId = "default"): boolean {
  if (conversationViewId !== defaultConversationViewId) return false;
  const key = conversationDraftKey(sessionId, conversationViewId);
  const marker = `jupiter.image-draft.migrated:${sessionId}`;
  let copied = false;
  try {
    if (localStorage.getItem(marker)) return false;
    const keys = [...new Set([sessionId, ...legacyKeys])].filter((old) => old !== key);
    const source = keys.find((old) => hasDraftContent(readImageDraft(old)));
    const target = readImageDraft(key);
    let value = source ? mergeDraftReceipts(readImageDraft(source), target) : target;
    // An empty placeholder is not a claimed draft. Conflicting real drafts
    // both survive; only successful migration consumes the legacy copy.
    if (!value) return false;
    const ids = new Set(value.shareIntakeIds);
    for (const old of keys) {
      const legacy = readImageDraft(old);
      if (hasDraftPayload(legacy) && !sameDraftPayload(legacy, value)) continue;
      for (const id of legacy.shareIntakeIds ?? []) ids.add(id);
    }
    if (ids.size) value = { ...value, shareIntakeIds: [...ids] };
    if (source || localStorage.getItem(PREFIX + key) === null) {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      cache.set(key, value);
      copied = !!source && JSON.stringify(target) !== JSON.stringify(value);
    }
    localStorage.setItem(marker, "1");
    for (const old of keys) {
      const legacy = readImageDraft(old);
      if (hasDraftPayload(legacy) && !sameDraftPayload(legacy, value)) continue;
      localStorage.removeItem(PREFIX + old);
      cache.delete(old);
    }
    syncImageDraftReferences();
  } catch {
    // Leave the legacy copy intact if persistence is unavailable.
  }
  return copied;
}
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
      if (Array.isArray(record.shareIntakeIds))
        draft.shareIntakeIds = [...new Set(record.shareIntakeIds.filter(
          (id) => typeof id === "string" && id.length > 0 && id.length <= 128,
        ))];
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
  options: { requirePersistence?: boolean } = {},
): void {
  const previous = readImageDraft(key);
  const next = change(previous);
  if (options.requirePersistence) localStorage.setItem(PREFIX + key, JSON.stringify(next));
  cache.set(key, next);
  if (next.text !== previous.text) textRevisions.set(key, imageDraftTextRevision(key) + 1);
  try {
    if (!options.requirePersistence) localStorage.setItem(PREFIX + key, JSON.stringify(next));
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

/** Commit the content and receipt in one storage write, before notifying live draft readers. */
export function writeImageDraftIntake(
  key: string, intakeId: string, change: (draft: ImageDraftRecord) => ImageDraftRecord,
): void {
  if (!intakeId || intakeId.length > 128) throw new Error("Invalid Android share intake id");
  writeImageDraft(key, (draft) => {
    if (draft.shareIntakeIds?.includes(intakeId)) return draft;
    const next = change(draft);
    if (!validDraft(next)) throw new Error("Android share draft is too large or invalid");
    return { ...next, shareIntakeIds: [...(draft.shareIntakeIds ?? []), intakeId] };
  }, { requirePersistence: true });
}

export function imageDraftIntakePersisted(key: string, intakeId: string): boolean {
  const serialized = localStorage.getItem(PREFIX + key);
  if (!serialized) return false;
  try {
    const value = JSON.parse(serialized) as ImageDraftRecord;
    return validDraft(value) && Array.isArray(value.shareIntakeIds) && value.shareIntakeIds.includes(intakeId);
  } catch {
    return false;
  }
}

/** Receipts travel with their draft, including when another tab owns the restored draft. */
export function findImageDraftIntake(intakeId: string): string | undefined {
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(PREFIX) && imageDraftIntakePersisted(key.slice(PREFIX.length), intakeId))
      return key.slice(PREFIX.length);
  }
  return undefined;
}

export function bindImageDraftIntake(key: string) {
  const binding = intakeBinding(key);
  return {
    setIntake: (id: string, change: (draft: ImageDraftRecord) => ImageDraftRecord) =>
      writeImageDraftIntake(resolveIntakeBinding(binding), id, change),
    intakePersisted: (id: string) => imageDraftIntakePersisted(resolveIntakeBinding(binding), id),
  };
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
