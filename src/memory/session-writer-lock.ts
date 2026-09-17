import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sessionsDir } from "./session.js";

interface LockOwner {
  pid: number;
  processInstanceId: string;
  ownerId: string;
  label: string;
  acquiredAt: number;
}

interface ActiveLock {
  ownerId: string;
  refs: number;
  path: string;
}

const PROCESS_INSTANCE_ID = randomUUID();
const activeLocks = new Map<string, ActiveLock>();
let exitHookInstalled = false;

export class SessionWriterConflictError extends Error {
  readonly code = "SESSION_WRITER_CONFLICT";

  constructor(
    readonly sessionLabel: string,
    readonly owner: LockOwner | null,
  ) {
    const ownerText = owner ? `process ${owner.pid}` : "another Jupiter process";
    super(`Session "${sessionLabel}" is already writable in ${ownerText}.`);
    this.name = "SessionWriterConflictError";
  }
}

export class SessionWriterLease {
  private released = false;

  private constructor(
    private readonly key: string,
    private readonly ownerId: string,
    private readonly path: string,
  ) {}

  static acquire(opts: { key: string; ownerId: string; label: string }): SessionWriterLease {
    const key = opts.key.trim();
    if (!key) throw new Error("Session writer key cannot be empty.");
    const existing = activeLocks.get(key);
    if (existing) {
      if (existing.ownerId !== opts.ownerId) {
        throw new SessionWriterConflictError(opts.label, readOwner(existing.path));
      }
      existing.refs += 1;
      return new SessionWriterLease(key, opts.ownerId, existing.path);
    }

    const locksDir = join(sessionsDir(), ".writer-locks");
    mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    const digest = createHash("sha256").update(key).digest("hex");
    const lockPath = join(locksDir, `${digest}.lock`);
    const owner: LockOwner = {
      pid: process.pid,
      processInstanceId: PROCESS_INSTANCE_ID,
      ownerId: opts.ownerId,
      label: opts.label,
      acquiredAt: Date.now(),
    };

    acquireDirectory(lockPath, owner, opts.label);
    activeLocks.set(key, { ownerId: opts.ownerId, refs: 1, path: lockPath });
    installExitHook();
    return new SessionWriterLease(key, opts.ownerId, lockPath);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    const active = activeLocks.get(this.key);
    if (!active || active.ownerId !== this.ownerId) return;
    active.refs -= 1;
    if (active.refs > 0) return;
    activeLocks.delete(this.key);
    removeOwnedLock(this.path, this.ownerId);
  }
}

function acquireDirectory(lockPath: string, owner: LockOwner, label: string): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readOwner(lockPath);
      if (!isStale(lockPath, current)) throw new SessionWriterConflictError(label, current);
      quarantineStaleLock(lockPath);
    }
  }
  throw new SessionWriterConflictError(label, readOwner(lockPath));
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as LockOwner;
    if (
      !Number.isInteger(parsed.pid) ||
      typeof parsed.processInstanceId !== "string" ||
      typeof parsed.ownerId !== "string" ||
      typeof parsed.label !== "string" ||
      typeof parsed.acquiredAt !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isStale(lockPath: string, owner: LockOwner | null): boolean {
  if (owner) return !isProcessAlive(owner.pid);
  try {
    return Date.now() - statSync(lockPath).mtimeMs > 30_000;
  } catch {
    return true;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function quarantineStaleLock(lockPath: string): void {
  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  rmSync(stalePath, { recursive: true, force: true });
}

function removeOwnedLock(lockPath: string, ownerId: string): void {
  const owner = readOwner(lockPath);
  if (
    owner?.pid !== process.pid ||
    owner.processInstanceId !== PROCESS_INSTANCE_ID ||
    owner.ownerId !== ownerId
  ) {
    return;
  }
  rmSync(lockPath, { recursive: true, force: true });
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const lock of activeLocks.values()) removeOwnedLock(lock.path, lock.ownerId);
    activeLocks.clear();
  });
}

export function sessionWriterLockExists(key: string): boolean {
  const digest = createHash("sha256").update(key.trim()).digest("hex");
  return existsSync(join(sessionsDir(), ".writer-locks", `${digest}.lock`));
}
