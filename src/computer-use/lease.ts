import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface LeaseRecord {
  token: string;
  owner: string;
  heartbeatAt: number;
}

export interface ComputerUseLeaseHandle {
  readonly token: string;
  readonly owner: string;
  renew(): Promise<void>;
  release(): Promise<void>;
}

export interface ComputerUseLeaseOptions {
  path?: string;
  /** Compatibility only: old locks are never automatically taken over. */
  staleAfterMs?: number;
  now?: () => number;
  randomId?: () => string;
}

export class ComputerUseLeaseBusyError extends Error {
  readonly owner?: string;

  constructor(owner?: string) {
    super(
      owner
        ? `Computer Use is already controlled by ${owner}`
        : "Computer Use is already controlled",
    );
    this.name = "ComputerUseLeaseBusyError";
    this.owner = owner;
  }
}

export class ComputerUseLease {
  private readonly path: string;
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(options: ComputerUseLeaseOptions = {}) {
    this.path = options.path ?? defaultComputerUseLeasePath();
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
  }

  async acquire(owner: string): Promise<ComputerUseLeaseHandle> {
    const record: LeaseRecord = {
      token: this.randomId(),
      owner,
      heartbeatAt: this.now(),
    };
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await mkdir(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.readRecord();
      throw new ComputerUseLeaseBusyError(existing?.owner);
    }
    // mkdir is the atomic acquisition. Failed initialization leaves a conservative lock.
    await writeFile(this.recordPath(), JSON.stringify(record), { mode: 0o600, flag: "wx" });

    let released = false;
    let tail = Promise.resolve();
    const serial = (operation: () => Promise<void>): Promise<void> => {
      const next = tail.then(operation);
      tail = next.catch(() => undefined);
      return next;
    };
    const ownsLease = async (): Promise<boolean> => {
      const current = await this.readRecord();
      return current?.token === record.token;
    };
    return {
      token: record.token,
      owner,
      renew: () =>
        serial(async () => {
          if (released || !(await ownsLease()))
            throw new Error("Computer Use lease is no longer active");
          // Readers must never mistake a partially-written heartbeat for a lost lease.
          const temporary = join(this.path, `${record.token}-${randomUUID()}.tmp`);
          try {
            await writeFile(temporary, JSON.stringify({ ...record, heartbeatAt: this.now() }), {
              mode: 0o600,
            });
            if (!(await ownsLease())) throw new Error("Computer Use lease is no longer active");
            await rename(temporary, this.recordPath());
          } finally {
            await rm(temporary, { force: true });
          }
        }),
      release: () =>
        serial(async () => {
          if (released) return;
          if (await ownsLease()) await rm(this.path, { recursive: true, force: true });
          released = true;
        }),
    };
  }

  private recordPath(): string {
    return join(this.path, "owner.json");
  }

  private async readRecord(): Promise<LeaseRecord | undefined> {
    try {
      const value = JSON.parse(await readFile(this.recordPath(), "utf8")) as Partial<LeaseRecord>;
      if (
        typeof value.token !== "string" ||
        typeof value.owner !== "string" ||
        !Number.isFinite(value.heartbeatAt)
      )
        return undefined;
      return value as LeaseRecord;
    } catch {
      return undefined;
    }
  }
}

export function defaultComputerUseLeasePath(): string {
  return join(homedir(), ".jupiter", "computer-use", "desktop.lock");
}
