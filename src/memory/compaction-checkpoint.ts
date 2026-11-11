import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isImageAttachment } from "../attachments/types.js";
import type { ChatMessage } from "../types.js";
import type { LoopSessionStorage, SemanticFold } from "./loop-session-storage.js";
import { SessionWriterLease } from "./session-writer-lock.js";
import {
  type SessionMeta,
  appendSessionMessage,
  loadSessionMessages,
  loadSessionMeta,
  patchSessionMeta,
  rewriteSession,
  sessionPath,
} from "./session.js";
import { committedSessionSize, readPendingSharedCommit } from "./shared-session-boundary.js";
import { type ToolExecutionJournal, openToolExecutionJournal } from "./tool-execution-journal.js";

interface RawSnapshot {
  bytes: Buffer;
  records: ChatMessage[];
  ends: number[];
}

interface Checkpoint {
  schema: 1;
  sessionId: string;
  rules: string;
  coveredRecords: number;
  coveredBytes: number;
  prefixSha256: string;
  summary: ChatMessage;
}

interface Source {
  start: number;
  end: number;
}
interface Row {
  message: ChatMessage;
  source: Source | null;
  semantic?: boolean;
}
interface Candidate {
  coveredRecords: number;
  summary: ChatMessage;
  rules: string;
  signal?: AbortSignal;
}

export function compactionCheckpointPath(name: string): string {
  return sessionPath(name).replace(/\.jsonl$/, ".compaction.json");
}

function hash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function diagnostic(reason: string): void {
  // Deliberately omit transcript bodies, filenames and exception text.
  process.stderr.write(`[compaction] ${reason}; using raw history\n`);
}

/** Strict live-file reader. Never bind a cache to a backup or a skipped malformed row. */
function rawSnapshot(name: string): RawSnapshot | undefined {
  try {
    const path = sessionPath(name);
    const physical = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    const bytes = physical.subarray(0, committedSessionSize(path, physical.length));
    const records: ChatMessage[] = [];
    const ends: number[] = [];
    let offset = 0;
    for (const line of bytes.toString("utf8").split(/(?<=\n)/)) {
      offset += Buffer.byteLength(line);
      if (!line.trim()) continue;
      const value = JSON.parse(line) as ChatMessage;
      if (!value || !["user", "assistant", "system", "tool"].includes(value.role)) return undefined;
      records.push(value);
      ends.push(offset);
    }
    return { bytes, records, ends };
  } catch {
    return undefined;
  }
}

function readCheckpoint(
  name: string,
  sessionId: string,
  rules: string,
  raw: readonly ChatMessage[],
  serialized?: string | null,
): Checkpoint | undefined {
  const path = compactionCheckpointPath(name);
  if (serialized === null || (serialized === undefined && !existsSync(path))) return undefined;
  try {
    const cp = JSON.parse(serialized ?? readFileSync(path, "utf8")) as Checkpoint;
    const snapshot = rawSnapshot(name);
    let reason: string | undefined;
    if (cp?.schema !== 1) reason = "unsupported checkpoint schema";
    else if (cp.sessionId !== sessionId || loadSessionMeta(name).sessionId !== sessionId)
      reason = "checkpoint identity mismatch";
    else if (cp.rules !== rules) reason = "checkpoint rules changed";
    else if (
      !snapshot ||
      !Number.isSafeInteger(cp.coveredRecords) ||
      cp.coveredRecords <= 0 ||
      cp.coveredRecords > raw.length ||
      snapshot.ends[cp.coveredRecords - 1] !== cp.coveredBytes ||
      !isDeepStrictEqual(
        snapshot.records.slice(0, cp.coveredRecords),
        raw.slice(0, cp.coveredRecords),
      ) ||
      hash(snapshot.bytes.subarray(0, cp.coveredBytes)) !== cp.prefixSha256
    )
      reason = "checkpoint prefix mismatch";
    else if (!validSummary(cp.summary)) reason = "invalid checkpoint summary";
    if (reason) {
      diagnostic(reason);
      return undefined;
    }
    return cp;
  } catch {
    diagnostic("unreadable checkpoint");
    return undefined;
  }
}

function validSummary(summary: ChatMessage): boolean {
  return (
    !!summary &&
    summary.role === "assistant" &&
    typeof summary.content === "string" &&
    summary.content.trim().length > 0 &&
    !summary.tool_calls?.length &&
    !summary.attachments?.length &&
    !summary.prefix &&
    (!summary.sourceAttachments || summary.sourceAttachments.every(isImageAttachment))
  );
}

function sameHealedRow(a: ChatMessage, b: ChatMessage): boolean {
  const envelope = (message: ChatMessage) => {
    const { reasoning_content, ...rest } = message;
    if (rest.role === "tool") rest.content = undefined;
    if (rest.tool_calls)
      rest.tool_calls = rest.tool_calls.map((call) => ({
        ...call,
        function: { ...call.function, arguments: "" },
      }));
    return rest;
  };
  return isDeepStrictEqual(envelope(a), envelope(b));
}

/** A run-local lineage map. Summary rows cover raw ranges, never compressed-array indices. */
export class CompactionProjection {
  private rows: Row[];
  private previous: Row[] | undefined;
  private initial: Row[];
  private candidate: Candidate | undefined;
  private rules: string | undefined;
  private configured = false;
  private base: ChatMessage[];
  private raw: ChatMessage[];
  private checkpointAtStart: string | null = null;
  private baseline: Pick<RawSnapshot, "bytes" | "ends"> | undefined;

  constructor(base: ChatMessage[], name: string) {
    this.base = structuredClone(base);
    this.raw = [...this.base];
    this.rows = this.rawRows();
    this.initial = this.rows.filter((row) => row.source && row.source.end <= this.base.length);
    this.captureBaseline(name);
    try {
      this.checkpointAtStart = readFileSync(compactionCheckpointPath(name), "utf8");
    } catch {
      // An absent cache is normal. A present unreadable cache is reported on configuration.
      if (existsSync(compactionCheckpointPath(name))) diagnostic("unreadable checkpoint");
    }
  }

  get rawUserTurns(): number {
    return this.raw.filter((m) => m.role === "user").length;
  }

  beginRules(name: string, sessionId: string, fingerprint: string): void {
    const rules = hash(fingerprint);
    if (this.rules === rules) return;
    this.candidate = undefined;
    this.rules = rules;
    // A new checkpoint must never retroactively change an active turn's snapshot.
    if (this.configured) this.rows = this.rawRows();
    const cp = readCheckpoint(name, sessionId, rules, this.base, this.checkpointAtStart);
    if (cp)
      this.rows = [
        {
          message: structuredClone(cp.summary),
          source: { start: 0, end: cp.coveredRecords },
          semantic: true,
        },
        ...this.rows.slice(cp.coveredRecords),
      ];
    this.initial = this.rows.filter((row) => row.source && row.source.end <= this.base.length);
    this.configured = true;
    this.previous = undefined;
  }

  loadMessages(): ChatMessage[] {
    return structuredClone(this.rows.map((row) => row.message));
  }

  append(message: ChatMessage): void {
    const index = this.raw.length;
    this.raw.push(structuredClone(message));
    this.rows.push({ message: structuredClone(message), source: { start: index, end: index + 1 } });
    this.previous = undefined;
  }

  rewrite(messages: ChatMessage[]): void {
    const previous = this.rows;
    this.previous = previous;
    // Healing may thin tool payloads or reasoning, but only recordFold creates a summary span.
    let cursor = 0;
    this.rows = messages.map((message) => {
      let index = cursor;
      while (index < previous.length && !sameHealedRow(previous[index]!.message, message)) index++;
      if (index === previous.length) index = -1;
      const source = index >= 0 ? previous[index]!.source : null;
      if (index >= 0) cursor = index + 1;
      return {
        message: structuredClone(message),
        source,
        semantic: index >= 0 ? previous[index]!.semantic : undefined,
      };
    });
  }

  recordFold({ before, head, summary, signal }: SemanticFold): boolean {
    if (
      signal?.aborted ||
      !this.rules ||
      !validSummary(summary) ||
      !head.length ||
      head.length > before.length ||
      !isDeepStrictEqual(head, before.slice(0, head.length))
    )
      return false;
    const sourceRows = this.previous;
    if (
      !sourceRows ||
      !isDeepStrictEqual(
        sourceRows.map((row) => row.message),
        before,
      ) ||
      !isDeepStrictEqual(this.loadMessages(), [summary, ...before.slice(head.length)])
    )
      return false;
    let end = 0;
    for (const row of sourceRows.slice(0, head.length)) {
      if (!row.source || row.source.start !== end) return false;
      end = row.source.end;
    }
    this.rows = [
      { message: structuredClone(summary), source: { start: 0, end }, semantic: true },
      ...sourceRows.slice(head.length),
    ];
    this.previous = undefined;
    this.candidate = {
      coveredRecords: end,
      summary: structuredClone(summary),
      rules: this.rules,
      signal,
    };
    return true;
  }

  discardCandidate(): void {
    this.candidate = undefined;
  }

  discardTurn(): void {
    this.raw = [...this.base];
    this.rows = [...this.initial];
    this.previous = undefined;
    this.discardCandidate();
  }

  /** History edits select raw sources; context-only thinning must never become raw content. */
  historyMessages(messages: ChatMessage[]): ChatMessage[] {
    const retained: ChatMessage[] = [];
    let cursor = 0;
    for (const message of messages) {
      const row = this.rows.find(
        (entry) =>
          entry.source && entry.source.start >= cursor && isDeepStrictEqual(entry.message, message),
      );
      const source = row?.source;
      if (
        source &&
        Number.isSafeInteger(source.start) &&
        Number.isSafeInteger(source.end) &&
        source.start >= cursor &&
        source.end > source.start &&
        source.end <= this.raw.length
      ) {
        retained.push(...structuredClone(this.raw.slice(source.start, source.end)));
        cursor = source.end;
        continue;
      }
      let index = cursor;
      while (index < this.raw.length && !isDeepStrictEqual(this.raw[index], message)) index++;
      if (index === this.raw.length)
        throw new Error("Cannot rewrite raw history from an unmapped projection source");
      retained.push(structuredClone(this.raw[index]!));
      cursor = index + 1;
    }
    return retained;
  }

  resetRaw(raw: ChatMessage[], projection: ChatMessage[] = raw, name?: string): void {
    const summaries = this.rows.filter(
      (row) =>
        row.semantic &&
        row.source &&
        isDeepStrictEqual(
          this.raw.slice(row.source.start, row.source.end),
          raw.slice(row.source.start, row.source.end),
        ),
    );
    this.raw = structuredClone(raw);
    this.rows = this.rawRows();
    this.rewrite(projection);
    this.rows = this.rows.map(
      (row) => summaries.find((summary) => isDeepStrictEqual(summary.message, row.message)) ?? row,
    );
    this.previous = undefined;
    this.discardCandidate();
    if (name) {
      this.base = structuredClone(raw);
      this.captureBaseline(name);
    }
  }

  publish(name: string, sessionId: string, signal?: AbortSignal): boolean {
    const candidate = this.candidate;
    const aborted = signal?.aborted || candidate?.signal?.aborted;
    if (aborted) this.discardCandidate();
    if (!candidate || aborted || !this.rules || candidate.rules !== this.rules) return false;
    try {
      if (
        loadSessionMeta(name).sessionId !== sessionId ||
        readPendingSharedCommit(sessionPath(name))
      )
        return false;
      const snapshot = rawSnapshot(name);
      const count = candidate.coveredRecords;
      const baselineCount = Math.min(count, this.base.length);
      const baselineEnd = this.baseline?.ends[baselineCount - 1] ?? 0;
      // Includes private records only once their exact contiguous raw prefix has committed.
      if (
        !snapshot ||
        !this.baseline ||
        count > snapshot.records.length ||
        !snapshot.bytes
          .subarray(0, baselineEnd)
          .equals(this.baseline.bytes.subarray(0, baselineEnd)) ||
        !isDeepStrictEqual(snapshot.records.slice(0, count), this.raw.slice(0, count))
      )
        return false;
      const old = readCheckpoint(name, sessionId, this.rules, snapshot.records);
      if (old && old.coveredRecords >= count) return false;
      const coveredBytes = snapshot.ends[count - 1]!;
      const cp: Checkpoint = {
        schema: 1,
        sessionId,
        rules: this.rules,
        coveredRecords: count,
        coveredBytes,
        prefixSha256: hash(snapshot.bytes.subarray(0, coveredBytes)),
        summary: candidate.summary,
      };
      const path = compactionCheckpointPath(name);
      const tmp = `${path}.${randomUUID()}.tmp`;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        // Same-directory rename only: copying over the old cache on EXDEV is not atomic.
        writeFileSync(tmp, JSON.stringify(cp), { mode: 0o600, flush: true });
        renameSync(tmp, path);
      } finally {
        rmSync(tmp, { force: true });
      }
      this.discardCandidate();
      return true;
    } catch {
      diagnostic("checkpoint publication failed");
      return false;
    }
  }

  private rawRows(): Row[] {
    return this.raw.map((message, index) => ({
      message,
      source: { start: index, end: index + 1 },
    }));
  }

  private captureBaseline(name: string): void {
    const snapshot = rawSnapshot(name);
    this.baseline = snapshot && { bytes: snapshot.bytes, ends: snapshot.ends };
  }
}

/** Named CLI/TUI adapter using the existing lease primitive and journal format. */
export class PersistentLoopSessionStorage implements LoopSessionStorage {
  private projection: CompactionProjection;
  private sessionId: string;
  private rules: string | undefined;
  journal: ToolExecutionJournal;
  private lease: SessionWriterLease;
  private readonly ownerId: string;
  private disposed = false;

  constructor(
    private name: string,
    opts: { ownerId?: string } = {},
  ) {
    this.ownerId = opts.ownerId ?? `persistent:${randomUUID()}`;
    this.sessionId = this.identity(name);
    this.lease = this.acquire(name, this.sessionId);
    try {
      this.journal = openToolExecutionJournal(name);
      this.projection = this.recoverProjection(name, this.journal);
    } catch (error) {
      this.lease.release();
      throw error;
    }
  }

  get rawUserTurns(): number {
    return this.projection.rawUserTurns;
  }
  beginRules(fingerprint: string): void {
    this.assertActive();
    this.rules = fingerprint;
    this.projection.beginRules(this.name, this.sessionId, fingerprint);
  }
  loadMessages(): ChatMessage[] {
    return this.projection.loadMessages();
  }
  loadRawMessages(): ChatMessage[] {
    return loadSessionMessages(this.name);
  }
  loadMeta(): SessionMeta {
    return loadSessionMeta(this.name);
  }
  patchMeta(patch: Partial<SessionMeta>): void {
    this.assertActive();
    patchSessionMeta(this.name, patch);
  }
  recordFold(fold: SemanticFold): boolean {
    if (this.disposed) return false;
    return this.projection.recordFold(fold);
  }
  publishCompaction(signal?: AbortSignal): boolean {
    if (this.disposed) return false;
    return this.projection.publish(this.name, this.sessionId, signal);
  }
  appendMessage(message: ChatMessage): ChatMessage {
    this.assertActive();
    const retained = structuredClone(message);
    appendSessionMessage(this.name, retained);
    this.projection.append(retained);
    return retained;
  }
  rewriteMessages(messages: ChatMessage[], reason: "context" | "history"): void {
    this.assertActive();
    if (reason === "context") {
      this.projection.rewrite(messages);
      return;
    }
    const raw = this.projection.historyMessages(messages);
    rewriteSession(this.name, raw);
    this.projection.resetRaw(raw, messages, this.name);
  }
  replaceTailMessage(message: ChatMessage): ChatMessage {
    this.assertActive();
    const raw = loadSessionMessages(this.name);
    const index = raw.findLastIndex((row) => row.role === "assistant");
    if (index < 0) return message;
    raw[index] = structuredClone(message);
    const projection = this.loadMessages();
    const tail = projection.findLastIndex((row) => row.role === "assistant");
    if (tail >= 0) projection[tail] = structuredClone(message);
    rewriteSession(this.name, raw);
    this.projection.resetRaw(raw, projection, this.name);
    return message;
  }
  rebind(name: string): void {
    this.assertActive();
    const identity = this.identity(name);
    if (identity === this.sessionId) {
      this.name = name;
      this.journal.rebindPath(sessionPath(name).replace(/\.jsonl$/, ".tool-executions.v2.journal"));
      return;
    }
    const lease = this.acquire(name, identity);
    let projection: CompactionProjection;
    let journal: ToolExecutionJournal;
    try {
      journal = openToolExecutionJournal(name);
      projection = this.recoverProjection(name, journal);
    } catch (error) {
      lease.release();
      throw error;
    }
    this.projection.discardCandidate();
    this.lease.release();
    this.lease = lease;
    this.name = name;
    this.sessionId = identity;
    this.projection = projection;
    this.journal = journal;
    if (this.rules !== undefined) this.beginRules(this.rules);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.projection.discardCandidate();
    this.lease.release();
  }
  private assertActive(): void {
    if (this.disposed) throw new Error("Session storage has been disposed");
  }
  private acquire(name: string, sessionId: string): SessionWriterLease {
    return SessionWriterLease.acquire({ key: sessionId, ownerId: this.ownerId, label: name });
  }
  private recoverProjection(name: string, journal: ToolExecutionJournal): CompactionProjection {
    journal.recoverIncompleteExecutions();
    const repaired = journal.repairDanglingToolCalls(loadSessionMessages(name));
    if (repaired.repairedCount > 0) rewriteSession(name, repaired.messages);
    return new CompactionProjection(repaired.messages, name);
  }
  private identity(name: string): string {
    const meta = loadSessionMeta(name);
    if (meta.sessionId) return meta.sessionId;
    openToolExecutionJournal(name);
    return loadSessionMeta(name).sessionId!;
  }
}
