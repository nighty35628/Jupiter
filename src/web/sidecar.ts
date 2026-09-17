import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export type WebDownlinkPacket =
  | { channel: "rpc:event"; payload: { data: string } }
  | { channel: "rpc:stderr"; payload: { data: string } }
  | { channel: "rpc:exit"; payload: { code: number | null } };

export interface SequencedWebPacket {
  sequence: number;
  packet: WebDownlinkPacket;
}

export interface ReplayResult {
  status: "ok" | "gap";
  packets: SequencedWebPacket[];
}

export interface WebSidecar {
  readonly runtimeEpoch: string;
  readonly latestSequence: number;
  send(command: Record<string, unknown>): Promise<void>;
  subscribe(listener: (packet: SequencedWebPacket) => void): () => void;
  replayAfter(sequence: number, through?: number): ReplayResult;
  close(): Promise<void>;
}

export interface PacketBufferOptions {
  maxPackets?: number;
  maxBytes?: number;
}

/** Bounded replay log used to bridge short browser disconnects without duplicating events. */
export class SequencedPacketBuffer {
  private readonly maxPackets: number;
  private readonly maxBytes: number;
  private readonly packets: Array<SequencedWebPacket & { bytes: number }> = [];
  private readonly listeners = new Set<(packet: SequencedWebPacket) => void>();
  private sequence = 0;
  private totalBytes = 0;

  constructor(opts: PacketBufferOptions = {}) {
    this.maxPackets = opts.maxPackets ?? 10_000;
    this.maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
  }

  get latestSequence(): number {
    return this.sequence;
  }

  append(packet: WebDownlinkPacket): SequencedWebPacket {
    const sequence = ++this.sequence;
    const normalized = normalizePacketWatermark(packet, sequence);
    const item = {
      sequence,
      packet: normalized,
      bytes: Buffer.byteLength(JSON.stringify(normalized), "utf8"),
    };
    this.packets.push(item);
    this.totalBytes += item.bytes;
    while (
      this.packets.length > 1 &&
      (this.packets.length > this.maxPackets || this.totalBytes > this.maxBytes)
    ) {
      const removed = this.packets.shift();
      if (removed) this.totalBytes -= removed.bytes;
    }
    const publicItem = { sequence: item.sequence, packet: item.packet };
    for (const listener of this.listeners) listener(publicItem);
    return publicItem;
  }

  subscribe(listener: (packet: SequencedWebPacket) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  replayAfter(sequence: number, through = this.sequence): ReplayResult {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > through) {
      return { status: "gap", packets: [] };
    }
    const oldest = this.packets[0]?.sequence ?? this.sequence + 1;
    if (sequence < oldest - 1) return { status: "gap", packets: [] };
    return {
      status: "ok",
      packets: this.packets
        .filter((item) => item.sequence > sequence && item.sequence <= through)
        .map((item) => ({ sequence: item.sequence, packet: item.packet })),
    };
  }
}

function normalizePacketWatermark(packet: WebDownlinkPacket, sequence: number): WebDownlinkPacket {
  if (packet.channel !== "rpc:event") return packet;
  try {
    const event = JSON.parse(packet.payload.data) as Record<string, unknown>;
    if (event.type !== "$resync_complete") return packet;
    return {
      channel: "rpc:event",
      payload: { data: JSON.stringify({ ...event, watermark: sequence }) },
    };
  } catch {
    return packet;
  }
}

export interface DesktopSidecarOptions extends PacketBufferOptions {
  dir: string;
  model?: string;
  budgetUsd?: number;
  cliEntry?: string;
  child?: ChildProcessWithoutNullStreams;
  inheritEnvironment?: boolean;
  accessMode?: "local" | "lan" | "public";
  highRiskEnabled?: boolean;
  runtimeEpoch?: string;
}

export interface SupervisedSidecarOptions extends PacketBufferOptions {
  create: () => WebSidecar;
  maxRestarts?: number;
  restartWindowMs?: number;
  restartBaseDelayMs?: number;
}

/** Keeps the HTTP/browser session alive while replacing a failed desktop runtime. */
export class SupervisedSidecar implements WebSidecar {
  private child: WebSidecar;
  private buffer: SequencedPacketBuffer;
  private readonly listeners = new Set<(packet: SequencedWebPacket) => void>();
  private childUnsubscribe: (() => void) | null = null;
  private readonly restartTimes: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restarting = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly opts: SupervisedSidecarOptions) {
    this.buffer = new SequencedPacketBuffer(opts);
    this.child = opts.create();
    this.attachChild(this.child, false);
  }

  get runtimeEpoch(): string {
    return this.child.runtimeEpoch;
  }

  get latestSequence(): number {
    return this.buffer.latestSequence;
  }

  send(command: Record<string, unknown>): Promise<void> {
    if (this.closing) return Promise.reject(new Error("desktop sidecar is shutting down"));
    if (this.restarting) return Promise.reject(new Error("desktop sidecar is restarting"));
    return this.child.send(command);
  }

  subscribe(listener: (packet: SequencedWebPacket) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  replayAfter(sequence: number, through?: number): ReplayResult {
    return this.buffer.replayAfter(sequence, through);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.childUnsubscribe?.();
    this.childUnsubscribe = null;
    this.closePromise = this.child.close();
    return this.closePromise;
  }

  private attachChild(child: WebSidecar, restarted: boolean): void {
    const barrier = child.latestSequence;
    const pending: SequencedWebPacket[] = [];
    let replaying = true;
    this.childUnsubscribe = child.subscribe((packet) => {
      if (packet.sequence <= barrier) return;
      if (replaying) pending.push(packet);
      else this.acceptChildPacket(packet);
    });
    const replay = child.replayAfter(0, barrier);
    if (replay.status === "ok") {
      for (const packet of replay.packets) this.acceptChildPacket(packet);
    }
    replaying = false;
    pending.sort((a, b) => a.sequence - b.sequence);
    for (const packet of pending) this.acceptChildPacket(packet);

    if (restarted) {
      this.append({
        channel: "rpc:event",
        payload: {
          data: JSON.stringify({ type: "$runtime_restarted", runtimeEpoch: child.runtimeEpoch }),
        },
      });
      void child.send({ cmd: "desktop_resync", requestId: randomUUID() }).catch((error) => {
        this.append({
          channel: "rpc:stderr",
          payload: { data: `[web] runtime resync failed: ${(error as Error).message}` },
        });
      });
    }
  }

  private acceptChildPacket(item: SequencedWebPacket): void {
    if (item.packet.channel === "rpc:exit") {
      this.scheduleRestart(item.packet.payload.code);
      return;
    }
    this.append(item.packet);
  }

  private scheduleRestart(code: number | null): void {
    if (this.closing || this.restarting) return;
    this.restarting = true;
    this.childUnsubscribe?.();
    this.childUnsubscribe = null;
    const now = Date.now();
    const windowMs = this.opts.restartWindowMs ?? 60_000;
    while (this.restartTimes.length > 0 && now - this.restartTimes[0]! > windowMs) {
      this.restartTimes.shift();
    }
    const maxRestarts = this.opts.maxRestarts ?? 5;
    if (this.restartTimes.length >= maxRestarts) {
      this.restarting = false;
      this.append({ channel: "rpc:exit", payload: { code } });
      return;
    }
    const attempt = this.restartTimes.length + 1;
    this.restartTimes.push(now);
    const delay = Math.min((this.opts.restartBaseDelayMs ?? 250) * 2 ** (attempt - 1), 5_000);
    this.append({
      channel: "rpc:stderr",
      payload: { data: `[web] runtime exited; restarting (${attempt}/${maxRestarts})...` },
    });
    this.restartTimer = setTimeout(() => this.restart(), delay);
    this.restartTimer.unref();
  }

  private restart(): void {
    this.restartTimer = null;
    if (this.closing) return;
    try {
      const next = this.opts.create();
      this.child = next;
      this.buffer = new SequencedPacketBuffer(this.opts);
      this.restarting = false;
      this.attachChild(next, true);
    } catch (error) {
      this.restarting = false;
      this.append({
        channel: "rpc:stderr",
        payload: { data: `[web] runtime restart failed: ${(error as Error).message}` },
      });
      this.scheduleRestart(null);
    }
  }

  private append(packet: WebDownlinkPacket): void {
    const item = this.buffer.append(packet);
    for (const listener of this.listeners) listener(item);
  }
}

export class DesktopSidecar implements WebSidecar {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly buffer: SequencedPacketBuffer;
  private writeChain = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private exited = false;
  readonly runtimeEpoch: string;

  constructor(opts: DesktopSidecarOptions) {
    this.runtimeEpoch = opts.runtimeEpoch ?? randomUUID();
    this.buffer = new SequencedPacketBuffer(opts);
    this.child = opts.child ?? spawnDesktopProcess({ ...opts, runtimeEpoch: this.runtimeEpoch });

    const stdout = createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        this.buffer.append({
          channel: "rpc:event",
          payload: { data: JSON.stringify(event) },
        });
      } catch {
        this.buffer.append({
          channel: "rpc:stderr",
          payload: { data: `[web] invalid sidecar JSON: ${trimmed.slice(0, 200)}` },
        });
      }
    });

    const stderr = createInterface({ input: this.child.stderr });
    stderr.on("line", (line) => {
      this.buffer.append({ channel: "rpc:stderr", payload: { data: line } });
    });

    this.child.on("error", (err) => {
      this.buffer.append({
        channel: "rpc:stderr",
        payload: { data: `[web] sidecar error: ${err.message}` },
      });
    });
    this.child.on("exit", (code) => {
      this.exited = true;
      this.buffer.append({ channel: "rpc:exit", payload: { code } });
    });
  }

  get latestSequence(): number {
    return this.buffer.latestSequence;
  }

  subscribe(listener: (packet: SequencedWebPacket) => void): () => void {
    return this.buffer.subscribe(listener);
  }

  replayAfter(sequence: number, through?: number): ReplayResult {
    return this.buffer.replayAfter(sequence, through);
  }

  send(command: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(command)}\n`;
    if (Buffer.byteLength(line, "utf8") > 256 * 1024) {
      return Promise.reject(new Error("RPC command exceeds 256 KiB"));
    }
    const operation = this.writeChain.then(
      () =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          if (this.exited || !this.child.stdin.writable) {
            rejectWrite(new Error("desktop sidecar is not running"));
            return;
          }
          this.child.stdin.write(line, "utf8", (err) => {
            if (err) rejectWrite(err);
            else resolveWrite();
          });
        }),
    );
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = new Promise<void>((resolveClose) => {
      if (this.exited) {
        resolveClose();
        return;
      }
      const forceTimer = setTimeout(() => {
        if (!this.exited) this.child.kill("SIGKILL");
      }, 3000);
      forceTimer.unref();
      this.child.once("exit", () => {
        clearTimeout(forceTimer);
        resolveClose();
      });
      this.child.kill("SIGTERM");
    });
    return this.closePromise;
  }
}

function spawnDesktopProcess(opts: DesktopSidecarOptions): ChildProcessWithoutNullStreams {
  const cliEntry = resolve(opts.cliEntry ?? currentCliEntry());
  const nodeArgs = cliEntry.endsWith(".ts")
    ? process.execArgv.filter((arg) => !arg.startsWith("--inspect"))
    : [];
  const args = [...nodeArgs, cliEntry, "desktop", "--dir", resolve(opts.dir)];
  if (opts.model) args.push("--model", opts.model);
  if (opts.budgetUsd !== undefined) args.push("--budget", String(opts.budgetUsd));
  return spawn(process.execPath, args, {
    cwd: resolve(opts.dir),
    env: {
      ...(opts.inheritEnvironment === false ? sanitizedRuntimeEnvironment() : process.env),
      JUPITER_RUNTIME_SURFACE: "web-beta",
      JUPITER_WEB_ACCESS_MODE: opts.accessMode ?? "local",
      JUPITER_WEB_HIGH_RISK: opts.highRiskEnabled ? "1" : "0",
      JUPITER_WEB_RUNTIME_ID: randomUUID(),
      JUPITER_WEB_RUNTIME_EPOCH: opts.runtimeEpoch,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function sanitizedRuntimeEnvironment(): NodeJS.ProcessEnv {
  const allowedNames = new Set([
    "APPDATA",
    "COMSPEC",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "SHELL",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USER",
    "USERPROFILE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]);
  const blockedNames = new Set(["JUPITER_WEB_PROXY_SECRET", "JUPITER_WEB_PROXY_SECRET_FILE"]);
  const allowedPrefixes = ["JUPITER_", "DEEPSEEK_", "OPENAI_", "ANTHROPIC_", "OLLAMA_"];
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      !blockedNames.has(name) &&
      (allowedNames.has(name) || allowedPrefixes.some((prefix) => name.startsWith(prefix)))
    ) {
      env[name] = value;
    }
  }
  return env;
}

export function currentCliEntry(): string {
  return cliEntryForModulePath(fileURLToPath(import.meta.url));
}

export function cliEntryForModulePath(here: string): string {
  if (here.endsWith(".ts")) return resolve(dirname(here), "..", "cli", "index.ts");
  const directory = dirname(here);
  return basename(directory) === "cli"
    ? resolve(directory, "index.js")
    : resolve(directory, "..", "cli", "index.js");
}
