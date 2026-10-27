import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { SessionMeta } from "./session.js";

export interface PendingSharedCommit {
  version: 1;
  sessionId: string;
  turnId: string;
  baseBytes: number;
  baseSha256: string;
  payload: string;
  meta: Partial<SessionMeta>;
}

export function sharedCommitPath(path: string): string {
  return path.endsWith(".jsonl")
    ? path.replace(/\.jsonl$/, ".shared-commit.json")
    : `${path}.shared-commit.json`;
}

export function readPendingSharedCommit(path: string): PendingSharedCommit | undefined {
  const pendingPath = sharedCommitPath(path);
  if (!existsSync(pendingPath)) return undefined;
  const value = JSON.parse(readFileSync(pendingPath, "utf8")) as PendingSharedCommit;
  if (
    value.version !== 1 ||
    typeof value.sessionId !== "string" ||
    typeof value.turnId !== "string" ||
    !Number.isSafeInteger(value.baseBytes) ||
    value.baseBytes < 0 ||
    typeof value.payload !== "string" ||
    typeof value.baseSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.baseSha256) ||
    !value.meta ||
    typeof value.meta !== "object" ||
    Array.isArray(value.meta)
  ) {
    throw new Error("Invalid shared-session commit record; recovery is required");
  }
  if (!value.payload.endsWith("\n")) throw new Error("Invalid shared-session payload boundary");
  const records = value.payload
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { role?: string; turnId?: string });
  if (
    !records.length ||
    records.some(
      (record) =>
        !["user", "assistant", "tool", "system"].includes(record.role ?? "") ||
        record.turnId !== value.turnId,
    )
  ) {
    throw new Error("Invalid shared-session payload identity");
  }
  return value;
}

/** An interrupted append must never expose a complete-looking prefix of a private turn. */
export function committedSessionSize(path: string, physicalSize: number): number {
  const pending = readPendingSharedCommit(path);
  if (!pending) return physicalSize;
  if (pending.baseBytes > physicalSize)
    throw new Error("Shared-session history is shorter than its committed boundary");
  return pending.baseBytes;
}

export function writePendingSharedCommit(path: string, pending: PendingSharedCommit): void {
  const target = sharedCommitPath(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(pending), { mode: 0o600, flush: true });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function publishSharedCommit(path: string): void {
  unlinkSync(sharedCommitPath(path));
}
