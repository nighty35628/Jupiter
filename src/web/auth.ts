import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";

const DEFAULT_PAIRING_TTL_MS = 5 * 60_000;
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_LEASE_TTL_MS = 30_000;
const MAX_DEVICE_SESSIONS = 32;

export interface DeviceSession {
  id: string;
  name: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

export type DeviceSummary = Omit<DeviceSession, "csrfToken">;

interface StoredDeviceSession extends DeviceSession {
  cookieHash: string;
}

interface PairingToken {
  hash: string;
  expiresAt: number;
}

export interface WriterLease {
  id: string;
  deviceId: string;
  fence: number;
  expiresAt: number;
}

interface StoredWriterLease extends WriterLease {
  deadline: number;
}

export class DeviceSessionStore {
  private readonly sessionsByCookie = new Map<string, StoredDeviceSession>();
  private readonly sessionsById = new Map<string, StoredDeviceSession>();
  private readonly pairingTokens = new Map<string, PairingToken>();

  constructor(
    initialPairingToken: string,
    private readonly pairingTtlMs = DEFAULT_PAIRING_TTL_MS,
    private readonly sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  ) {
    this.addPairingToken(initialPairingToken);
  }

  issuePairingToken(): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString("hex");
    const expiresAt = this.addPairingToken(token);
    return { token, expiresAt };
  }

  consumePairingToken(
    token: string,
    requestedName?: string,
  ): { cookieToken: string; session: DeviceSession } | null {
    this.prune();
    const hash = hashToken(token);
    const record = this.pairingTokens.get(hash);
    if (!record || record.expiresAt <= Date.now() || !safeEqual(record.hash, hash)) return null;
    this.pairingTokens.delete(hash);

    while (this.sessionsByCookie.size >= MAX_DEVICE_SESSIONS) {
      const oldest = Array.from(this.sessionsByCookie.values()).sort(
        (a, b) => a.lastSeenAt - b.lastSeenAt,
      )[0];
      if (!oldest) break;
      this.revoke(oldest.id);
    }

    const cookieToken = randomBytes(32).toString("hex");
    const now = Date.now();
    const stored: StoredDeviceSession = {
      id: randomUUID(),
      name: sanitizeDeviceName(requestedName),
      csrfToken: randomBytes(32).toString("hex"),
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
      lastSeenAt: now,
      cookieHash: hashToken(cookieToken),
    };
    this.sessionsByCookie.set(stored.cookieHash, stored);
    this.sessionsById.set(stored.id, stored);
    return { cookieToken, session: publicSession(stored) };
  }

  authenticate(cookieToken: string): DeviceSession | null {
    this.prune();
    if (!cookieToken) return null;
    const stored = this.sessionsByCookie.get(hashToken(cookieToken));
    if (!stored || stored.expiresAt <= Date.now()) return null;
    stored.lastSeenAt = Date.now();
    return publicSession(stored);
  }

  list(): DeviceSummary[] {
    this.prune();
    return Array.from(this.sessionsById.values(), publicDeviceSummary).sort(
      (a, b) => b.lastSeenAt - a.lastSeenAt,
    );
  }

  revoke(deviceId: string): boolean {
    const stored = this.sessionsById.get(deviceId);
    if (!stored) return false;
    this.sessionsById.delete(deviceId);
    this.sessionsByCookie.delete(stored.cookieHash);
    return true;
  }

  private addPairingToken(token: string): number {
    const expiresAt = Date.now() + this.pairingTtlMs;
    const hash = hashToken(token);
    this.pairingTokens.set(hash, { hash, expiresAt });
    return expiresAt;
  }

  private prune(): void {
    const now = Date.now();
    for (const [hash, token] of this.pairingTokens) {
      if (token.expiresAt <= now) this.pairingTokens.delete(hash);
    }
    for (const session of this.sessionsById.values()) {
      if (session.expiresAt <= now) this.revoke(session.id);
    }
  }
}

function publicDeviceSummary(session: StoredDeviceSession): DeviceSummary {
  const { id, name, createdAt, expiresAt, lastSeenAt } = session;
  return { id, name, createdAt, expiresAt, lastSeenAt };
}

export class WriterLeaseStore {
  private lease: StoredWriterLease | null = null;
  private nextFence = 1;

  constructor(private readonly ttlMs = DEFAULT_LEASE_TTL_MS) {}

  acquire(deviceId: string, force = false): WriterLease | null {
    const current = this.current();
    if (current && current.deviceId !== deviceId && !force) return null;
    if (current?.deviceId === deviceId && !force) {
      return this.renew(current.id, deviceId, current.fence);
    }
    const lease: StoredWriterLease = {
      id: randomUUID(),
      deviceId,
      fence: this.nextFence++,
      deadline: performance.now() + this.ttlMs,
      expiresAt: Date.now() + this.ttlMs,
    };
    this.lease = lease;
    return publicLease(lease);
  }

  renew(leaseId: string, deviceId: string, fence: number): WriterLease | null {
    const current = this.current();
    if (
      !current ||
      current.id !== leaseId ||
      current.deviceId !== deviceId ||
      current.fence !== fence
    ) {
      return null;
    }
    current.deadline = performance.now() + this.ttlMs;
    current.expiresAt = Date.now() + this.ttlMs;
    return publicLease(current);
  }

  validate(leaseId: string, deviceId: string, fence: number): WriterLease | null {
    const current = this.current();
    if (
      !current ||
      current.id !== leaseId ||
      current.deviceId !== deviceId ||
      current.fence !== fence
    ) {
      return null;
    }
    return publicLease(current);
  }

  releaseForDevice(deviceId: string): void {
    if (this.lease?.deviceId === deviceId) this.lease = null;
  }

  current(): StoredWriterLease | null {
    if (this.lease && this.lease.deadline <= performance.now()) this.lease = null;
    return this.lease;
  }
}

function publicSession(session: StoredDeviceSession): DeviceSession {
  const { cookieHash: _cookieHash, ...visible } = session;
  return { ...visible };
}

function publicLease(lease: StoredWriterLease): WriterLease {
  const { deadline: _deadline, ...visible } = lease;
  return { ...visible };
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function sanitizeDeviceName(value: string | undefined): string {
  const name = stripControlCharacters(value ?? "")
    .trim()
    .slice(0, 80);
  return name || "Browser";
}

function stripControlCharacters(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code > 0x1f && code !== 0x7f) output += character;
  }
  return output;
}
