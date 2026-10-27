import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../types.js";
import type { LoopSessionStorage } from "./loop-session-storage.js";
import { SessionWriterLease } from "./session-writer-lock.js";
import {
  type SessionMeta,
  loadSessionMessages,
  loadSessionMeta,
  patchSessionMeta,
  rewriteSession,
  sessionPath,
  sessionsDir,
} from "./session.js";
import {
  committedSessionSize,
  publishSharedCommit,
  readPendingSharedCommit,
  writePendingSharedCommit,
} from "./shared-session-boundary.js";
import { ToolExecutionJournal } from "./tool-execution-journal.js";

interface StagedTurn {
  version: 1;
  sessionId: string;
  viewId: string;
  turnId: string;
  baseBytes: number;
  baseVersion: number;
  baseSha256: string;
  records: ChatMessage[];
  state: "running" | "failed" | "cancelled" | "committed";
}

function safeId(value: string): string {
  return value.replace(/[^\w-]/g, "_").slice(0, 100);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function strictMeta(name: string): SessionMeta {
  const path = sessionPath(name).replace(/\.jsonl$/, ".meta.json");
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid session metadata; recovery is required");
  return value as SessionMeta;
}

function writePrivate(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flush: true });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** A private raw turn and an independently compressible model projection. */
export class SharedTurnStorage implements LoopSessionStorage {
  readonly journal: ToolExecutionJournal;
  readonly path: string;
  private projection: ChatMessage[];
  private metaPatch: Partial<SessionMeta> = {};
  readonly staged: StagedTurn;
  private baseMeta: SessionMeta;

  constructor(
    readonly owner: SharedSessionCoordinator,
    viewId: string,
    turnId: string,
    base: ChatMessage[],
    restored?: StagedTurn,
  ) {
    this.path = join(owner.stagingDir, `${safeId(viewId)}-${safeId(turnId)}.json`);
    this.baseMeta = loadSessionMeta(owner.name);
    this.staged = restored ?? {
      version: 1,
      sessionId: owner.sessionId,
      viewId,
      turnId,
      baseBytes: owner.committedBytes,
      baseVersion: owner.version,
      baseSha256: owner.historySha256,
      records: [],
      state: "running",
    };
    this.projection = [...base, ...this.staged.records];
    this.journal = new ToolExecutionJournal({
      path: this.path.replace(/\.json$/, ".tool-executions.v2.journal"),
      sessionId: owner.sessionId,
      runId: turnId,
    });
  }

  get turnId(): string {
    return this.staged.turnId;
  }
  get viewId(): string {
    return this.staged.viewId;
  }
  get hasRecords(): boolean {
    return this.staged.records.length > 0;
  }
  loadMessages(): ChatMessage[] {
    return structuredClone(this.projection);
  }
  loadMeta(): SessionMeta {
    return { ...this.baseMeta, ...this.metaPatch };
  }
  patchMeta(patch: Partial<SessionMeta>): void {
    if (patch.provider) {
      const existing = loadSessionMeta(this.owner.name).provider;
      if (
        existing &&
        (existing.endpointIdentity !== patch.provider.endpointIdentity ||
          existing.dialect !== patch.provider.dialect)
      ) {
        throw new Error(
          "This shared session is bound to another provider. Start a new session to change providers.",
        );
      }
      if (!existing) patchSessionMeta(this.owner.name, { provider: patch.provider });
    }
    this.metaPatch = { ...this.metaPatch, ...patch };
  }

  appendMessage(message: ChatMessage): ChatMessage {
    const retained = structuredClone({
      ...message,
      turnId: this.turnId,
      conversationViewId: this.viewId,
    });
    writePrivate(this.path, { ...this.staged, records: [...this.staged.records, retained] });
    this.staged.records.push(retained);
    this.projection.push(retained);
    return retained;
  }

  rewriteMessages(messages: ChatMessage[], reason: "context" | "history"): void {
    const projection = structuredClone(messages);
    if (reason === "history") {
      const records = messages
        .filter((m) => m.turnId === this.turnId)
        .map((m) => structuredClone(m));
      writePrivate(this.path, { ...this.staged, records });
      this.staged.records = records;
    }
    this.projection = projection;
  }

  replaceTailMessage(message: ChatMessage): ChatMessage {
    const retained = {
      ...structuredClone(message),
      turnId: this.turnId,
      conversationViewId: this.viewId,
    };
    const replace = (rows: ChatMessage[]) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]?.role === "assistant") {
          rows[i] = retained;
          return;
        }
      }
    };
    const records = [...this.staged.records];
    const projection = [...this.projection];
    replace(records);
    replace(projection);
    writePrivate(this.path, { ...this.staged, records });
    this.staged.records = records;
    this.projection = projection;
    return retained;
  }

  discardCurrentTurn(): void {
    writePrivate(this.path, { ...this.staged, records: [] });
    this.staged.records = [];
    this.projection = this.projection.filter((m) => m.turnId !== this.turnId);
  }

  markFailed(): void {
    writePrivate(this.path, { ...this.staged, state: "failed" });
    this.staged.state = "failed";
  }

  statsDelta(current: SessionMeta): Partial<SessionMeta> {
    const result: Partial<SessionMeta> = {};
    for (const key of [
      "totalCostUsd",
      "cacheHitTokens",
      "cacheMissTokens",
      "totalCompletionTokens",
    ] as const) {
      const value = this.metaPatch[key];
      if (typeof value === "number")
        result[key] = (current[key] ?? 0) + Math.max(0, value - (this.baseMeta[key] ?? 0));
    }
    if (this.metaPatch.lastPromptTokens !== undefined)
      result.lastPromptTokens = this.metaPatch.lastPromptTokens;
    if (this.metaPatch.provider) result.provider = this.metaPatch.provider;
    return result;
  }
}

/** One writer per logical session; model execution is never held behind this writer. */
export class SharedSessionCoordinator {
  private lease: SessionWriterLease;
  private history: ChatMessage[] = [];
  private stores = new Map<string, SharedTurnStorage>();
  private disposed = false;
  version = 0;
  historySha256 = digest(Buffer.alloc(0));
  constructor(
    public name: string,
    readonly sessionId: string,
  ) {
    this.lease = SessionWriterLease.acquire({
      key: sessionId,
      ownerId: `shared:${sessionId}`,
      label: name,
    });
    try {
      this.recover();
      this.history = loadSessionMessages(name);
      this.version = strictMeta(name).sharedHistoryVersion ?? 0;
      this.historySha256 = digest(
        existsSync(sessionPath(name))
          ? readFileSync(sessionPath(name)).subarray(0, this.committedBytes)
          : Buffer.alloc(0),
      );
    } catch (error) {
      this.lease.release();
      throw error;
    }
  }

  get stagingDir(): string {
    return join(sessionsDir(), ".shared-runs", safeId(this.sessionId));
  }
  get committedBytes(): number {
    const path = sessionPath(this.name);
    return committedSessionSize(path, existsSync(path) ? statSync(path).size : 0);
  }
  get activeTurns(): number {
    return [...this.stores.values()].filter((s) => s.hasRecords && s.staged.state !== "committed")
      .length;
  }

  releaseEmptyTurn(store: SharedTurnStorage | undefined): void {
    if (store?.owner === this && !store.hasRecords) this.stores.delete(store.turnId);
  }

  hasCommitted(turnId: string): boolean {
    return this.history.some((m) => m.turnId === turnId || m.clientId === turnId);
  }

  replaceHistory(messages: ChatMessage[], expectedVersion: number): void {
    if (this.activeTurns || this.version !== expectedVersion)
      throw new Error(
        "Shared history changed or has an unfinished turn; reload before modifying it",
      );
    rewriteSession(this.name, messages);
    this.history = structuredClone(messages);
    this.historySha256 = digest(readFileSync(sessionPath(this.name)));
    this.version++;
    patchSessionMeta(this.name, { sharedHistoryVersion: this.version });
  }

  beginTurn(viewId: string, turnId: string = randomUUID()): SharedTurnStorage {
    if (this.disposed) throw new Error("Shared session has been disposed");
    const existing = this.stores.get(turnId);
    if (existing) {
      if (existing.viewId !== viewId)
        throw new Error("Submission identity belongs to a different conversation view");
      return existing;
    }
    const store = new SharedTurnStorage(this, viewId, turnId, this.history);
    this.stores.set(turnId, store);
    return store;
  }

  prepareCommit(store: SharedTurnStorage): boolean {
    if (store.owner !== this) throw new Error("Turn belongs to another session");
    if (store.staged.state === "committed" || this.history.some((m) => m.turnId === store.turnId))
      return false;
    if (!store.hasRecords) return false;
    const path = sessionPath(this.name);
    if (readPendingSharedCommit(path))
      throw new Error("A shared-session commit requires recovery before another commit");
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600, flush: true });
    const records = completeToolPairs(store.staged.records);
    const meta = strictMeta(this.name);
    writePendingSharedCommit(path, {
      version: 1,
      sessionId: this.sessionId,
      turnId: store.turnId,
      baseBytes: this.committedBytes,
      baseSha256: this.historySha256,
      payload: `${records.map((m) => JSON.stringify(m)).join("\n")}\n`,
      meta: {
        ...meta,
        ...store.statsDelta(meta),
        sessionId: this.sessionId,
        sharedHistoryVersion: this.version + 1,
        turnCount: (meta.turnCount ?? 0) + 1,
        lastAssistantCompletedAt: Date.now(),
      },
    });
    return true;
  }

  commit(store: SharedTurnStorage): boolean {
    const pending = readPendingSharedCommit(sessionPath(this.name));
    if (pending) {
      this.recover();
      if (pending.turnId === store.turnId) return true;
    }
    if (!this.prepareCommit(store)) return false;
    this.recover();
    store.staged.state = "committed";
    rmSync(store.path, { force: true });
    this.stores.delete(store.turnId);
    this.history = loadSessionMessages(this.name);
    this.version = loadSessionMeta(this.name).sharedHistoryVersion ?? this.version + 1;
    return true;
  }

  /** Must run with the writer lease, before opening the recovered history to writers. */
  recover(): void {
    const path = sessionPath(this.name);
    const pending = readPendingSharedCommit(path);
    if (!pending) return;
    if (pending.sessionId !== this.sessionId)
      throw new Error("Shared-session recovery identity mismatch");
    const bytes = readFileSync(path);
    if (bytes.length < pending.baseBytes)
      throw new Error("Shared-session history is shorter than its committed boundary");
    if (digest(bytes.subarray(0, pending.baseBytes)) !== pending.baseSha256)
      throw new Error("Shared-session base prefix changed; automatic recovery refused");
    const tail = bytes.subarray(pending.baseBytes);
    const payload = Buffer.from(pending.payload);
    if (tail.length > payload.length || !tail.equals(payload.subarray(0, tail.length))) {
      throw new Error("Shared-session append changed externally; automatic recovery refused");
    }
    truncateSync(path, pending.baseBytes);
    appendFileSync(path, payload, { flush: true, mode: 0o600 });
    patchSessionMeta(this.name, pending.meta);
    publishSharedCommit(path);
    this.history = loadSessionMessages(this.name);
    this.version = pending.meta.sharedHistoryVersion ?? this.version + 1;
    this.historySha256 = digest(readFileSync(path));
    const completed = this.stores.get(pending.turnId);
    if (completed) {
      completed.staged.state = "committed";
      rmSync(completed.path, { force: true });
      this.stores.delete(pending.turnId);
    }
  }

  restoreTurn(viewId: string): SharedTurnStorage | undefined {
    if (!existsSync(this.stagingDir)) return undefined;
    for (const file of readdirSync(this.stagingDir)) {
      if (!file.endsWith(".json")) continue;
      const staged = JSON.parse(readFileSync(join(this.stagingDir, file), "utf8")) as StagedTurn;
      if (
        staged.sessionId !== this.sessionId ||
        staged.viewId !== viewId ||
        !staged.records?.length
      )
        continue;
      if (this.history.some((m) => m.turnId === staged.turnId)) {
        rmSync(join(this.stagingDir, file));
        continue;
      }
      const path = sessionPath(this.name);
      const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
      if (
        !Number.isSafeInteger(staged.baseBytes) ||
        staged.baseBytes < 0 ||
        bytes.length < staged.baseBytes ||
        digest(bytes.subarray(0, staged.baseBytes)) !== staged.baseSha256
      )
        throw new Error("Recovered turn snapshot prefix changed");
      const prefix = bytes.subarray(0, staged.baseBytes).toString("utf8");
      const base = prefix
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ChatMessage);
      const store = new SharedTurnStorage(this, viewId, staged.turnId, base, staged);
      store.journal.recoverIncompleteExecutions();
      this.stores.set(store.turnId, store);
      return store;
    }
    return undefined;
  }

  reload(): void {
    this.history = loadSessionMessages(this.name);
    this.historySha256 = digest(
      existsSync(sessionPath(this.name)) ? readFileSync(sessionPath(this.name)) : Buffer.alloc(0),
    );
    this.version++;
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.lease.release();
    }
  }
}

export function hasSharedTurnRecovery(sessionId: string): boolean {
  const path = join(sessionsDir(), ".shared-runs", safeId(sessionId));
  return existsSync(path) && readdirSync(path).some((name) => name.endsWith(".json"));
}

function completeToolPairs(records: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = structuredClone(records[i]!);
    out.push(record);
    if (record.role !== "assistant" || !record.tool_calls?.length) continue;
    const results = new Set<string>();
    for (let j = i + 1; j < records.length && records[j]?.role === "tool"; j++) {
      if (records[j]?.tool_call_id) results.add(records[j]!.tool_call_id!);
    }
    for (const call of record.tool_calls) {
      if (call.id && !results.has(call.id))
        out.push({
          role: "tool",
          tool_call_id: call.id,
          turnId: record.turnId,
          conversationViewId: record.conversationViewId,
          content: JSON.stringify({
            error:
              "Turn interrupted. Tool outcome is unknown; do not automatically retry side effects.",
            executionOutcome: "unknown_after_cancel",
          }),
        });
    }
  }
  return out;
}
