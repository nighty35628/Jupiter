import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ChatMessage } from "../types.js";
import { loadSessionMeta, patchSessionMeta, sessionPath } from "./session.js";

export const TOOL_EXECUTION_JOURNAL_VERSION = 2 as const;
export const TOOL_EXECUTION_JOURNAL_SUFFIX = ".tool-executions.v2.journal";

type ToolExecutionOutcome =
  | "returned"
  | "rejected_before_execution"
  | "blocked_before_execution"
  | "interrupted_before_execution"
  | "unknown_after_restart";

interface ToolExecutionRecordBase {
  version: typeof TOOL_EXECUTION_JOURNAL_VERSION;
  sessionId: string;
  seq: number;
  ts: string;
  runId: string;
  executionId: string;
  turn: number;
  callId: string;
  toolName: string;
}

export type ToolExecutionJournalRecord =
  | (ToolExecutionRecordBase & {
      state: "intent";
      argsSha256: string;
    })
  | (ToolExecutionRecordBase & {
      state: "execution_started";
    })
  | (ToolExecutionRecordBase & {
      state: "result";
      outcome: ToolExecutionOutcome;
      resultSha256?: string;
    });

type ToolExecutionAppendRecord =
  | Omit<
      Extract<ToolExecutionJournalRecord, { state: "intent" }>,
      "version" | "seq" | "ts" | "runId"
    >
  | Omit<
      Extract<ToolExecutionJournalRecord, { state: "execution_started" }>,
      "version" | "seq" | "ts" | "runId"
    >
  | Omit<
      Extract<ToolExecutionJournalRecord, { state: "result" }>,
      "version" | "seq" | "ts" | "runId"
    >;

interface ExecutionState {
  base: Omit<ToolExecutionRecordBase, "version" | "seq" | "ts" | "runId">;
  latest: ToolExecutionJournalRecord;
}

export interface ToolExecutionIntent {
  turn: number;
  callId: string;
  toolName: string;
  args: string;
}

export interface ToolExecutionJournalOptions {
  path: string;
  sessionId: string;
  runId?: string;
  now?: () => Date;
  randomId?: () => string;
  appendLine?: (path: string, line: string) => void;
}

export interface ToolExecutionRecovery {
  executionId: string;
  sessionId: string;
  turn: number;
  callId: string;
  toolName: string;
  outcome: "interrupted_before_execution" | "unknown_after_restart";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function durableAppendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  trimPartialTail(path);
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* chmod is not available on every platform/filesystem. */
  }
}

function trimPartialTail(path: string): void {
  if (!existsSync(path)) return;
  const fd = openSync(path, "r+");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return;
    const tailLength = Math.min(size, 64 * 1024);
    const buffer = Buffer.allocUnsafe(tailLength);
    readSync(fd, buffer, 0, tailLength, size - tailLength);
    if (buffer[tailLength - 1] === 0x0a) return;
    const lastNewline = buffer.lastIndexOf(0x0a);
    const keepBytes = lastNewline < 0 ? size - tailLength : size - tailLength + lastNewline + 1;
    ftruncateSync(fd, keepBytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isRecord(value: unknown): value is ToolExecutionJournalRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== TOOL_EXECUTION_JOURNAL_VERSION ||
    typeof record.sessionId !== "string" ||
    !Number.isSafeInteger(record.seq) ||
    typeof record.ts !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.executionId !== "string" ||
    !Number.isSafeInteger(record.turn) ||
    typeof record.callId !== "string" ||
    typeof record.toolName !== "string"
  ) {
    return false;
  }
  if (record.state === "intent") return typeof record.argsSha256 === "string";
  if (record.state === "execution_started") return true;
  if (record.state !== "result") return false;
  return (
    record.outcome === "returned" ||
    record.outcome === "rejected_before_execution" ||
    record.outcome === "blocked_before_execution" ||
    record.outcome === "interrupted_before_execution" ||
    record.outcome === "unknown_after_restart"
  );
}

export function readToolExecutionJournal(path: string): ToolExecutionJournalRecord[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records: ToolExecutionJournalRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isRecord(value)) records.push(value);
    } catch {
      // A crash can leave one partial tail line. Earlier durable records remain usable.
    }
  }
  return records;
}

export function toolExecutionJournalPath(sessionName: string): string {
  return sessionPath(sessionName).replace(/\.jsonl$/, TOOL_EXECUTION_JOURNAL_SUFFIX);
}

export function openToolExecutionJournal(sessionName: string): ToolExecutionJournal {
  const path = toolExecutionJournalPath(sessionName);
  const records = readToolExecutionJournal(path);
  const meta = loadSessionMeta(sessionName);
  const existingJournalId = records.find((record) => record.sessionId)?.sessionId;
  const sessionId = meta.sessionId ?? existingJournalId ?? randomUUID();
  if (meta.sessionId !== sessionId) patchSessionMeta(sessionName, { sessionId });
  return new ToolExecutionJournal({ path, sessionId });
}

export class ToolExecutionJournal {
  private _path: string;
  private readonly sessionId: string;
  private readonly runId: string;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly appendLine: (path: string, line: string) => void;
  private nextSeq = 1;
  private readonly executions = new Map<string, ExecutionState>();

  constructor(opts: ToolExecutionJournalOptions) {
    this._path = opts.path;
    this.sessionId = opts.sessionId;
    this.runId = opts.runId ?? randomUUID();
    this.now = opts.now ?? (() => new Date());
    this.randomId = opts.randomId ?? randomUUID;
    this.appendLine = opts.appendLine ?? durableAppendLine;
    this.load();
  }

  get path(): string {
    return this._path;
  }

  rebindPath(path: string): void {
    this._path = path;
  }

  recordIntent(intent: ToolExecutionIntent): string {
    const executionId = this.randomId();
    const base = {
      sessionId: this.sessionId,
      executionId,
      turn: intent.turn,
      callId: intent.callId,
      toolName: intent.toolName,
    };
    const record = this.append({
      ...base,
      state: "intent",
      argsSha256: sha256(intent.args),
    });
    this.executions.set(executionId, { base, latest: record });
    return executionId;
  }

  recordExecutionStarted(executionId: string): void {
    const execution = this.requireOpen(executionId);
    const record = this.append({ ...execution.base, state: "execution_started" });
    execution.latest = record;
  }

  recordResult(executionId: string, outcome: ToolExecutionOutcome, result?: string): void {
    const execution = this.requireOpen(executionId);
    const record = this.append({
      ...execution.base,
      state: "result",
      outcome,
      ...(result === undefined ? {} : { resultSha256: sha256(result) }),
    });
    execution.latest = record;
  }

  recoverIncompleteExecutions(): ToolExecutionRecovery[] {
    const pending = [...this.executions.values()]
      .filter((execution) => execution.latest.state !== "result")
      .sort((a, b) => a.latest.seq - b.latest.seq);
    const recovered: ToolExecutionRecovery[] = [];
    for (const execution of pending) {
      const outcome =
        execution.latest.state === "execution_started"
          ? "unknown_after_restart"
          : "interrupted_before_execution";
      this.recordResult(execution.base.executionId, outcome);
      recovered.push({ ...execution.base, outcome });
    }
    return recovered;
  }

  repairDanglingToolCalls(messages: readonly ChatMessage[]): {
    messages: ChatMessage[];
    repairedCount: number;
  } {
    const out: ChatMessage[] = [];
    let repairedCount = 0;
    let turn = 0;

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!;
      if (message.role === "user") turn++;
      if (
        message.role !== "assistant" ||
        !Array.isArray(message.tool_calls) ||
        message.tool_calls.length === 0
      ) {
        out.push({ ...message });
        continue;
      }

      const existing = new Map<string, ChatMessage>();
      let cursor = i + 1;
      while (cursor < messages.length && messages[cursor]!.role === "tool") {
        const toolMessage = messages[cursor]!;
        if (toolMessage.tool_call_id) existing.set(toolMessage.tool_call_id, toolMessage);
        cursor++;
      }

      const missing = message.tool_calls.filter((call) => !call.id || !existing.has(call.id));
      const recoverable = missing.every(
        (call) => Boolean(call.id) && this.latestForCall(turn, call.id!) !== undefined,
      );
      if (!recoverable) {
        out.push({ ...message });
        continue;
      }

      out.push({ ...message });
      for (const call of message.tool_calls) {
        const callId = call.id!;
        const persisted = existing.get(callId);
        if (persisted) {
          out.push({ ...persisted });
          continue;
        }
        const latest = this.latestForCall(turn, callId)!;
        out.push({
          role: "tool",
          tool_call_id: callId,
          name: call.function?.name ?? latest.toolName,
          content: recoveryToolResult(latest),
        });
        repairedCount++;
      }
      i = cursor - 1;
    }

    return { messages: out, repairedCount };
  }

  private load(): void {
    const records = readToolExecutionJournal(this._path).filter(
      (record) => record.sessionId === this.sessionId,
    );
    for (const record of records) {
      this.nextSeq = Math.max(this.nextSeq, record.seq + 1);
      const current = this.executions.get(record.executionId);
      if (!current) {
        this.executions.set(record.executionId, {
          base: {
            sessionId: record.sessionId,
            executionId: record.executionId,
            turn: record.turn,
            callId: record.callId,
            toolName: record.toolName,
          },
          latest: record,
        });
      } else if (record.seq > current.latest.seq) {
        current.latest = record;
      }
    }
  }

  private append(record: ToolExecutionAppendRecord): ToolExecutionJournalRecord {
    const full = {
      ...record,
      version: TOOL_EXECUTION_JOURNAL_VERSION,
      seq: this.nextSeq,
      ts: this.now().toISOString(),
      runId: this.runId,
    } as ToolExecutionJournalRecord;
    this.appendLine(this._path, `${JSON.stringify(full)}\n`);
    this.nextSeq++;
    return full;
  }

  private requireOpen(executionId: string): ExecutionState {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`unknown tool execution: ${executionId}`);
    if (execution.latest.state === "result") {
      throw new Error(`tool execution is already terminal: ${executionId}`);
    }
    return execution;
  }

  private latestForCall(turn: number, callId: string): ToolExecutionJournalRecord | undefined {
    let latest: ToolExecutionJournalRecord | undefined;
    for (const execution of this.executions.values()) {
      const candidate = execution.latest;
      if (candidate.turn !== turn || candidate.callId !== callId) continue;
      if (!latest || candidate.seq > latest.seq) latest = candidate;
    }
    return latest;
  }
}

function recoveryToolResult(record: ToolExecutionJournalRecord): string {
  if (record.state !== "result") {
    return JSON.stringify({
      error: "Tool execution recovery state is incomplete. Do not retry automatically.",
      recovery: "unknown",
    });
  }
  if (record.outcome === "unknown_after_restart") {
    return JSON.stringify({
      error:
        "Jupiter restarted after this tool began. Its outcome is unknown. Do not retry automatically; inspect current state or ask the user before repeating side effects.",
      recovery: record.outcome,
    });
  }
  if (record.outcome === "returned") {
    return JSON.stringify({
      error:
        "The tool completed before restart, but its transcript result was not committed. Do not retry automatically; inspect current state.",
      recovery: record.outcome,
    });
  }
  return JSON.stringify({
    error: "The tool did not begin execution before Jupiter restarted.",
    recovery: record.outcome,
  });
}
