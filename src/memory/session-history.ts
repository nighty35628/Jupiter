/** Bounded JSONL history reads. The disposable index contains offsets, never message bodies. */
import { type Hash, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type FileHandle, open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { ChatMessage } from "../types.js";
import { sessionPath } from "./session.js";
import { committedSessionSize } from "./shared-session-boundary.js";

export const SESSION_HISTORY_LIMITS = Object.freeze({
  defaultTurns: 20,
  maxTurns: 200,
  defaultBytes: 512 * 1024,
  maxBytes: 4 * 1024 * 1024,
  maxRecordBytes: 1024 * 1024,
  chunkBytes: 64 * 1024,
  maxCachedSessions: 8,
  maxIndexedTurns: 100_000,
  maxCachedTurns: 200_000,
  maxStreamDepth: 256,
});

export interface SessionHistoryOmission {
  kind: "oversized-turn";
  reason: "record" | "turn";
  turn: number;
  byteOffset: number;
  /** Entire omitted user/tool group, including delimiters and malformed lines. */
  byteLength: number;
  recordByteLength?: number;
  maxBytes: number;
  exportRequired: boolean;
  sourcePath: string;
  generation: string;
}

export type SessionHistoryRecord = ChatMessage & { historyOmission?: SessionHistoryOmission };

export interface SessionHistoryBounds {
  /** Raw source bytes for materialized groups; bounded omission metadata is additional. */
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface SessionHistoryPageOptions extends SessionHistoryBounds {
  cursor?: string;
  limitTurns?: number;
}

export interface SessionHistoryPage {
  records: SessionHistoryRecord[];
  omissions: SessionHistoryOmission[];
  /** Number of raw user records preceding these records, for buildLoadedMessages offsets. */
  startTurn: number;
  generation: string;
  beforeCursor?: string;
  hasMore: boolean;
  totalTurns: number;
  sourceSize: number;
  sourcePath: string;
  /** Actual bytes/read calls, including index/probe I/O. Shared work is charged to each waiter. */
  readBytes: number;
  readCount: number;
}

export type SessionHistoryErrorCode =
  | "INVALID_CURSOR"
  | "STALE_CURSOR"
  | "RECORD_TOO_LARGE"
  | "TURN_TOO_LARGE"
  | "TURN_NOT_FOUND"
  | "INDEX_LIMIT"
  | "INDEX_BUSY"
  | "SOURCE_CHANGED";

interface ErrorDetails {
  sourcePath: string;
  generation?: string;
  /** 1-based raw user turn. */
  turn?: number;
  turnExact?: boolean;
  byteOffset?: number;
  /** Exact record length (excluding LF) or exact complete group length, according to code. */
  byteLength?: number;
  maxBytes?: number;
  readBytes?: number;
  readCount?: number;
}

/** No partial messages escape. The caller may stream/export sourcePath at byteOffset separately. */
export class SessionHistoryError extends Error {
  override readonly name = "SessionHistoryError";
  readonly sourcePath: string;
  readonly generation?: string;
  readonly turn?: number;
  readonly turnExact?: boolean;
  readonly byteOffset?: number;
  readonly byteLength?: number;
  readonly maxBytes?: number;
  readonly readBytes?: number;
  readonly readCount?: number;

  constructor(
    readonly code: SessionHistoryErrorCode,
    details: ErrorDetails,
  ) {
    const guidance =
      code === "RECORD_TOO_LARGE"
        ? "JSONL record exceeds the 1 MiB history limit; export the original session instead of loading full history."
        : code === "TURN_TOO_LARGE"
          ? "Complete turn exceeds this byte budget; retry up to 4 MiB or export the original session."
          : `Session history ${code}`;
    super(`${guidance}: ${details.sourcePath}`);
    this.sourcePath = details.sourcePath;
    Object.assign(this, details);
  }
}

interface Meter {
  readBytes: number;
  readCount: number;
}
interface Witness {
  identity: string;
  stamp: string;
  size: number;
  probe: string;
}
interface Checkpoint {
  offset: number;
  totalTurns: number;
  records: number;
  groupsLength: number;
  hadContent: boolean;
  largeTail?: LargeRecord;
}
interface LargeRecord {
  byteOffset: number;
  byteLength: number;
}
interface HistoryIndex extends Witness {
  sourcePath: string;
  generation: string;
  digest: string;
  /** Starts of user groups; group zero also owns any leading system/assistant records. */
  groups: number[];
  largeGroups: Map<number, LargeRecord>;
  totalTurns: number;
  records: number;
  hadContent: boolean;
  resume: Checkpoint;
  missing?: boolean;
  liveWitness?: Witness;
}
interface Prepared {
  index: HistoryIndex;
  meter: Meter;
}
interface Pending {
  controller: AbortController;
  promise: Promise<Prepared>;
  waiters: number;
}
interface CacheEntry {
  index?: HistoryIndex;
  pending?: Pending;
}

const cache = new Map<string, CacheEntry>();
const cursorSecret = randomBytes(32);
const PROBE_BYTES = 256;

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Session history read cancelled", "AbortError");
}

function checkedInteger(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${label} must be an integer between 1 and ${max}`);
  }
  return value;
}

function pathKey(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

function cursorFor(path: string, generation: string, before: number): string {
  const data = Buffer.from(JSON.stringify([1, pathKey(path), generation, before])).toString(
    "base64url",
  );
  return `${data}.${createHmac("sha256", cursorSecret).update(data).digest("base64url")}`;
}

function decodeCursor(path: string, cursor: string): { generation: string; before: number } {
  const invalid = () => new SessionHistoryError("INVALID_CURSOR", { sourcePath: path });
  if (typeof cursor !== "string" || cursor.length > 1024) throw invalid();
  const parts = cursor.split(".");
  const [data, mac] = parts;
  if (parts.length !== 2 || !data || !mac || !/^[\w-]+$/.test(data) || !/^[\w-]+$/.test(mac)) {
    throw invalid();
  }
  const expected = createHmac("sha256", cursorSecret).update(data).digest("base64url");
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    throw invalid();
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 4 ||
      parsed[0] !== 1 ||
      parsed[1] !== pathKey(path) ||
      typeof parsed[2] !== "string" ||
      !Number.isSafeInteger(parsed[3]) ||
      parsed[3] < 1
    )
      throw invalid();
    return { generation: parsed[2], before: parsed[3] };
  } catch {
    throw invalid();
  }
}

async function witness(handle: FileHandle, path: string): Promise<Witness> {
  const s = await handle.stat({ bigint: true });
  if (!s.isFile() || s.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Session history source must be a regular, safely addressable file");
  }
  return {
    identity: `${s.dev}:${s.ino}:${s.birthtimeNs}`,
    stamp: `${s.ctimeNs}:${s.mtimeNs}`,
    size: committedSessionSize(path, Number(s.size)),
    probe: "",
  };
}

function same(a: Witness, b: Witness): boolean {
  return a.identity === b.identity && a.stamp === b.stamp && a.size === b.size;
}

async function readAt(
  handle: FileHandle,
  position: number,
  length: number,
  meter: Meter,
  signal?: AbortSignal,
): Promise<Buffer> {
  aborted(signal);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  meter.readCount++;
  meter.readBytes += bytesRead;
  aborted(signal);
  return buffer.subarray(0, bytesRead);
}

async function probe(
  handle: FileHandle,
  size: number,
  meter: Meter,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  for (const position of size > PROBE_BYTES
    ? [0, Math.max(PROBE_BYTES, size - PROBE_BYTES)]
    : [0]) {
    const length = Math.min(PROBE_BYTES, size - position);
    if (length > 0) hash.update(await readAt(handle, position, length, meter, signal));
  }
  return hash.digest("hex");
}

async function hashPrefix(
  handle: FileHandle,
  size: number,
  meter: Meter,
  signal?: AbortSignal,
): Promise<Hash> {
  const hash = createHash("sha256");
  let position = 0;
  while (position < size) {
    const part = await readAt(
      handle,
      position,
      Math.min(SESSION_HISTORY_LIMITS.chunkBytes, size - position),
      meter,
      signal,
    );
    if (!part.length) break;
    hash.update(part);
    position += part.length;
    await yieldImmediate();
    aborted(signal);
  }
  return hash;
}

function parseMessage(line: Buffer): ChatMessage | undefined {
  const trimmed = line.toString("utf8").trim();
  if (!trimmed) return;
  try {
    const value = JSON.parse(trimmed) as ChatMessage;
    if (value && typeof value === "object" && "role" in value) return value;
  } catch {
    /* Same malformed-line semantics as loadSessionMessages. */
  }
}

interface JsonFrame {
  object: boolean;
  state: "keyOrEnd" | "key" | "colon" | "value" | "valueOrEnd" | "commaOrEnd";
  role: boolean;
}

/** Validates an oversized JSON value without retaining its body; only top-level role is decoded.
 * Token capture (256 chars) and nesting (256 frames) are independently bounded.
 */
class StreamingRole {
  private decoder = new StringDecoder("utf8");
  private stack: JsonFrame[] = [];
  private rootDone = false;
  private rootObject = false;
  private invalid = false;
  private mode: "string" | "number" | "literal" | undefined;
  private stringKind: "key" | "role" | undefined;
  private capture: string | undefined;
  private escaped = false;
  private unicodeLeft = 0;
  private numberState = "";
  private literal = "";
  private literalPosition = 0;
  hasRole = false;
  role: unknown;
  hadContent = false;
  tooDeep = false;

  feed(bytes: Buffer): void {
    for (const char of this.decoder.write(bytes)) this.step(char);
  }

  finish(): { role: unknown } | undefined {
    for (const char of this.decoder.end()) this.step(char);
    if (this.mode === "number") this.endNumber();
    return !this.invalid && !this.mode && this.rootDone && this.rootObject && this.hasRole
      ? { role: this.role }
      : undefined;
  }

  private valueDone(): void {
    const parent = this.stack.at(-1);
    if (parent) parent.state = "commaOrEnd";
    else this.rootDone = true;
  }

  private endNumber(): void {
    if (!["zero", "int", "frac", "expDigits"].includes(this.numberState)) this.invalid = true;
    this.mode = undefined;
    this.valueDone();
  }

  private step(char: string): void {
    if (char.trim()) this.hadContent = true;
    if (this.invalid) return;
    if (this.mode === "string") {
      if (this.capture !== undefined) {
        this.capture += char;
        if (this.capture.length > 256) this.capture = undefined;
      }
      if (this.unicodeLeft) {
        if (!/^[\da-f]$/i.test(char)) this.invalid = true;
        this.unicodeLeft--;
      } else if (this.escaped) {
        this.escaped = false;
        if (char === "u") this.unicodeLeft = 4;
        else if (!'"\\/bfnrt'.includes(char)) this.invalid = true;
      } else if (char === "\\") this.escaped = true;
      else if (char === '"') {
        let value: unknown;
        if (this.capture !== undefined) {
          try {
            value = JSON.parse(this.capture);
          } catch {
            this.invalid = true;
          }
        }
        if (this.stringKind === "key") {
          const parent = this.stack.at(-1)!;
          parent.role = this.stack.length === 1 && value === "role";
          parent.state = "colon";
        } else {
          if (this.stringKind === "role") this.role = value;
          this.valueDone();
        }
        this.mode = undefined;
      } else if (char.charCodeAt(0) < 32) this.invalid = true;
      return;
    }
    if (this.mode === "literal") {
      if (char !== this.literal[this.literalPosition++]) this.invalid = true;
      if (this.literalPosition === this.literal.length) {
        this.mode = undefined;
        this.valueDone();
      }
      return;
    }
    if (this.mode === "number") {
      const digit = char >= "0" && char <= "9";
      const state = this.numberState;
      if (state === "minus" && char === "0") this.numberState = "zero";
      else if (state === "minus" && digit) this.numberState = "int";
      else if ((state === "int" || state === "frac" || state === "expDigits") && digit) {
        /* stay */
      } else if ((state === "zero" || state === "int") && char === ".") this.numberState = "dot";
      else if (state === "dot" && digit) this.numberState = "frac";
      else if (["zero", "int", "frac"].includes(state) && (char === "e" || char === "E"))
        this.numberState = "exp";
      else if (state === "exp" && (char === "+" || char === "-")) this.numberState = "expSign";
      else if ((state === "exp" || state === "expSign") && digit) this.numberState = "expDigits";
      else {
        this.endNumber();
        this.step(char);
      }
      return;
    }
    const parent = this.stack.at(-1);
    // JSON.parse(line.trim()) also permits Unicode whitespace around the root value.
    if (" \t\r\n".includes(char) || (!parent && !char.trim())) return;
    if (this.rootDone) {
      this.invalid = true;
      return;
    }
    if (parent?.state === "colon") {
      if (char === ":") parent.state = "value";
      else this.invalid = true;
      return;
    }
    if (parent?.state === "commaOrEnd") {
      if (char === ",") parent.state = parent.object ? "key" : "value";
      else if (char === (parent.object ? "}" : "]")) {
        this.stack.pop();
        this.valueDone();
      } else this.invalid = true;
      return;
    }
    if (parent?.state === "keyOrEnd" || parent?.state === "key") {
      if (char === "}" && parent.state === "keyOrEnd") {
        this.stack.pop();
        this.valueDone();
      } else if (char === '"') {
        this.mode = "string";
        this.stringKind = "key";
        this.capture = this.stack.length === 1 ? '"' : undefined;
      } else this.invalid = true;
      return;
    }
    if (parent?.state === "valueOrEnd" && char === "]") {
      this.stack.pop();
      this.valueDone();
      return;
    }
    const roleValue = this.stack.length === 1 && !!parent?.role;
    if (roleValue) {
      this.hasRole = true;
      this.role = undefined;
    }
    if (!parent) this.rootObject = char === "{";
    if (char === "{" || char === "[") {
      if (this.stack.length >= SESSION_HISTORY_LIMITS.maxStreamDepth) {
        this.tooDeep = true;
        this.invalid = true;
        return;
      }
      this.stack.push({
        object: char === "{",
        state: char === "{" ? "keyOrEnd" : "valueOrEnd",
        role: false,
      });
    } else if (char === '"') {
      this.mode = "string";
      this.stringKind = roleValue ? "role" : undefined;
      this.capture = roleValue ? '"' : undefined;
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      this.mode = "number";
      this.numberState = char === "-" ? "minus" : char === "0" ? "zero" : "int";
    } else if (char === "t" || char === "f" || char === "n") {
      this.mode = "literal";
      this.literal = char === "t" ? "true" : char === "f" ? "false" : "null";
      this.literalPosition = 1;
    } else this.invalid = true;
  }
}

async function assertUnchanged(
  path: string,
  handle: FileHandle,
  snapshot: Witness,
  generation: string,
  signal?: AbortSignal,
): Promise<void> {
  aborted(signal);
  let bound = false;
  try {
    const current = await stat(path, { bigint: true });
    bound = `${current.dev}:${current.ino}:${current.birthtimeNs}` === snapshot.identity;
  } catch {
    /* Disappearance/rebinding is a stale snapshot, not an empty page. */
  }
  if (!bound || !same(await witness(handle, path), snapshot)) {
    throw new SessionHistoryError("SOURCE_CHANGED", { sourcePath: path, generation });
  }
  aborted(signal);
}

async function scanIndex(
  path: string,
  handle: FileHandle,
  snapshot: Witness,
  generation: string,
  meter: Meter,
  signal: AbortSignal,
  previous?: HistoryIndex,
  verifiedPrefix?: Hash,
): Promise<HistoryIndex> {
  const resume = previous?.resume;
  const index: HistoryIndex = {
    ...snapshot,
    sourcePath: path,
    generation,
    digest: "",
    groups: previous ? previous.groups.slice(0, resume!.groupsLength) : [],
    largeGroups: previous
      ? new Map([...previous.largeGroups].filter(([group]) => group < resume!.groupsLength))
      : new Map(),
    totalTurns: resume?.totalTurns ?? 0,
    records: resume?.records ?? 0,
    hadContent: resume?.hadContent ?? false,
    resume: resume ?? { offset: 0, totalTurns: 0, records: 0, groupsLength: 0, hadContent: false },
  };
  let position = resume?.offset ?? 0;
  let lineStart = position;
  let fragments: Buffer[] = [];
  let lineLength = 0;
  let streaming: StreamingRole | undefined;
  if (resume && resume.groupsLength > 0) {
    if (resume.largeTail) index.largeGroups.set(resume.groupsLength - 1, resume.largeTail);
    else index.largeGroups.delete(resume.groupsLength - 1);
  }
  const hash = verifiedPrefix ?? createHash("sha256");
  const checkpoint = (): Checkpoint => ({
    offset: lineStart,
    totalTurns: index.totalTurns,
    records: index.records,
    groupsLength: index.groups.length,
    hadContent: index.hadContent,
    largeTail: index.largeGroups.get(index.groups.length - 1),
  });
  const consume = () => {
    let message: { role: unknown } | undefined;
    if (streaming) {
      message = streaming.finish();
      if (streaming.tooDeep) {
        throw new SessionHistoryError("INDEX_LIMIT", {
          sourcePath: path,
          generation,
          byteOffset: lineStart,
          byteLength: lineLength,
        });
      }
      if (streaming.hadContent) index.hadContent = true;
    } else {
      const line = Buffer.concat(fragments, lineLength);
      if (line.toString("utf8").trim()) index.hadContent = true;
      message = parseMessage(line);
    }
    if (
      previous &&
      lineStart === previous.resume.offset &&
      previous.records > previous.resume.records &&
      !message
    ) {
      // Appending junk to a formerly valid unterminated record is a semantic rewrite.
      index.generation = randomBytes(16).toString("hex");
    }
    if (message) {
      index.records++;
      if (message.role === "user") {
        if (index.totalTurns > 0) index.groups.push(lineStart);
        else if (!index.groups.length) index.groups.push(0);
        index.totalTurns++;
        if (index.totalTurns > SESSION_HISTORY_LIMITS.maxIndexedTurns) {
          throw new SessionHistoryError("INDEX_LIMIT", {
            sourcePath: path,
            generation,
            turn: index.totalTurns,
          });
        }
      } else if (!index.groups.length) index.groups.push(0);
      if (streaming && !index.largeGroups.has(index.groups.length - 1)) {
        index.largeGroups.set(index.groups.length - 1, {
          byteOffset: lineStart,
          byteLength: lineLength,
        });
      }
    }
    fragments = [];
    lineLength = 0;
    streaming = undefined;
  };
  while (position < snapshot.size) {
    const part = await readAt(
      handle,
      position,
      Math.min(SESSION_HISTORY_LIMITS.chunkBytes, snapshot.size - position),
      meter,
      signal,
    );
    if (!part.length)
      throw new SessionHistoryError("SOURCE_CHANGED", { sourcePath: path, generation });
    const unhashed = previous ? Math.max(0, previous.size - position) : 0;
    if (unhashed < part.length) hash.update(part.subarray(unhashed));
    let begin = 0;
    while (begin < part.length) {
      aborted(signal);
      const newline = part.indexOf(10, begin);
      const end = newline < 0 ? part.length : newline;
      lineLength += end - begin;
      if (!streaming && lineLength > SESSION_HISTORY_LIMITS.maxRecordBytes) {
        streaming = new StreamingRole();
        for (const fragment of fragments) streaming.feed(fragment);
        fragments = [];
      }
      if (streaming) streaming.feed(part.subarray(begin, end));
      else fragments.push(part.subarray(begin, end));
      if (newline < 0) break;
      consume();
      lineStart = position + newline + 1;
      index.resume = checkpoint();
      begin = newline + 1;
    }
    position += part.length;
    await yieldImmediate();
    aborted(signal);
  }
  // Reparse only this unterminated tail if a subsequent append completes it.
  index.resume = checkpoint();
  if (lineLength) consume();
  index.digest = hash.digest("hex");
  index.probe = await probe(handle, snapshot.size, meter, signal);
  await assertUnchanged(path, handle, snapshot, generation, signal);
  return index;
}

function ioCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

async function openOptional(path: string): Promise<FileHandle | undefined> {
  try {
    return await open(path, "r");
  } catch (error) {
    if (ioCode(error) === "ENOENT") return;
    throw error;
  }
}

function emptyIndex(path: string, previous?: HistoryIndex): HistoryIndex {
  return {
    sourcePath: path,
    generation: previous?.missing ? previous.generation : randomBytes(16).toString("hex"),
    identity: "",
    stamp: "",
    probe: "",
    size: 0,
    digest: "",
    groups: [],
    largeGroups: new Map(),
    totalTurns: 0,
    records: 0,
    hadContent: false,
    missing: true,
    resume: { offset: 0, totalTurns: 0, records: 0, groupsLength: 0, hadContent: false },
  };
}

async function refreshSource(
  path: string,
  handle: FileHandle,
  previous: HistoryIndex | undefined,
  meter: Meter,
  signal: AbortSignal,
): Promise<HistoryIndex> {
  aborted(signal);
  const snapshot = await witness(handle, path);
  if (previous && !previous.missing && previous.sourcePath === path) {
    const currentProbe = await probe(handle, snapshot.size, meter, signal);
    if (same(previous, snapshot) && previous.probe === currentProbe) {
      await assertUnchanged(path, handle, snapshot, previous.generation, signal);
      return previous;
    }
    if (previous.identity === snapshot.identity && snapshot.size > previous.size) {
      // ctime/inode plus a full byte digest detect middle rewrites even with restored mtime.
      // Growth needs this verification: head/tail sampling alone cannot prove append-only.
      const prefix = await hashPrefix(handle, previous.size, meter, signal);
      if (prefix.copy().digest("hex") === previous.digest) {
        return scanIndex(
          path,
          handle,
          snapshot,
          previous.generation,
          meter,
          signal,
          previous,
          prefix,
        );
      }
    }
  }
  return scanIndex(path, handle, snapshot, randomBytes(16).toString("hex"), meter, signal);
}

async function prepare(
  path: string,
  previous: HistoryIndex | undefined,
  signal: AbortSignal,
): Promise<Prepared> {
  const meter: Meter = { readBytes: 0, readCount: 0 };
  aborted(signal);
  let live: FileHandle | undefined;
  try {
    live = await openOptional(path);
  } catch (error) {
    if (ioCode(error) !== "EACCES" && ioCode(error) !== "EPERM") throw error;
    // The legacy reader tries the backup for an existing but unreadable live file.
    // Retry opening live on every request, so recovery switches generation/source normally.
    const backup = await openOptional(`${path}.bak`);
    if (!backup) return { index: emptyIndex(path, previous), meter };
    try {
      return { index: await refreshSource(`${path}.bak`, backup, previous, meter, signal), meter };
    } finally {
      await backup.close();
    }
  }
  if (!live) return { index: emptyIndex(path, previous), meter };
  try {
    let liveIndex: HistoryIndex | undefined;
    let liveWitness: Witness;
    let backupPrevious = previous;
    if (previous?.liveWitness) {
      liveWitness = await witness(live, path);
      liveWitness.probe = await probe(live, liveWitness.size, meter, signal);
      if (
        !same(liveWitness, previous.liveWitness) ||
        liveWitness.probe !== previous.liveWitness.probe
      ) {
        backupPrevious = undefined;
        liveIndex = await refreshSource(path, live, undefined, meter, signal);
        liveWitness = liveIndex;
      }
    } else {
      liveIndex = await refreshSource(path, live, previous, meter, signal);
      liveWitness = liveIndex;
    }
    let index = liveIndex;
    if (!liveIndex || (!liveIndex.records && liveIndex.hadContent)) {
      const backup = await openOptional(`${path}.bak`);
      if (backup) {
        try {
          index = await refreshSource(`${path}.bak`, backup, backupPrevious, meter, signal);
          index = { ...index, liveWitness };
        } finally {
          await backup.close();
        }
      } else if (!index) {
        index = await refreshSource(path, live, undefined, meter, signal);
      }
    }
    await assertUnchanged(path, live, liveWitness, index!.generation, signal);
    return { index: index!, meter };
  } finally {
    await live.close();
  }
}

function trimCache(): void {
  let turns = 0;
  for (const entry of cache.values()) turns += entry.index?.groups.length ?? 0;
  for (const [path, entry] of cache) {
    if (
      cache.size <= SESSION_HISTORY_LIMITS.maxCachedSessions &&
      turns <= SESSION_HISTORY_LIMITS.maxCachedTurns
    )
      break;
    if (entry.pending) continue;
    turns -= entry.index?.groups.length ?? 0;
    cache.delete(path);
  }
}

async function acquire(path: string, signal?: AbortSignal): Promise<Prepared> {
  aborted(signal);
  let entry = cache.get(path);
  if (!entry) {
    trimCache();
    if (cache.size >= SESSION_HISTORY_LIMITS.maxCachedSessions) {
      const idle = [...cache].find(([, value]) => !value.pending);
      if (!idle) throw new SessionHistoryError("INDEX_BUSY", { sourcePath: path });
      cache.delete(idle[0]);
    }
    entry = {};
  }
  cache.delete(path);
  cache.set(path, entry);
  let pending = entry.pending;
  if (!pending) {
    const controller = new AbortController();
    const current = entry;
    pending = { controller, waiters: 0, promise: undefined as unknown as Promise<Prepared> };
    const work = pending;
    work.promise = prepare(path, entry.index, controller.signal)
      .then((result) => {
        aborted(controller.signal);
        if (cache.get(path) === current) current.index = result.index;
        return result;
      })
      .finally(() => {
        if (current.pending === work) current.pending = undefined;
        trimCache();
      });
    entry.pending = work;
  }
  const work = pending;
  work.waiters++;
  return new Promise<Prepared>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, result?: Prepared) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      work.waiters--;
      if (!work.waiters && entry!.pending === work) {
        work.controller.abort();
        entry!.pending = undefined;
      }
      if (error) reject(error);
      else resolve(result!);
    };
    const onAbort = () => finish(new DOMException("Session history read cancelled", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    work.promise.then(
      (result) => finish(undefined, result),
      (error) => finish(error),
    );
    if (signal?.aborted) onAbort();
  });
}

/** Explicit rewrites/rebinds may eagerly invalidate; external changes are also checked on every read.
 * Cursors are process-local and become stale on cache eviction or invalidation.
 */
export function invalidateSessionHistory(name: string): void {
  const path = sessionPath(name);
  cache.get(path)?.pending?.controller.abort();
  cache.delete(path);
}

/** Same validation/generation as page reads, without materializing any message records.
 * Cold sources build the index; changed/growing sources require byte verification.
 */
export async function getSessionHistoryGeneration(
  name: string,
  signal?: AbortSignal,
): Promise<string> {
  const { index } = await acquire(sessionPath(name), signal);
  aborted(signal);
  return index.generation;
}

async function readRange(
  path: string,
  index: HistoryIndex,
  first: number,
  end: number,
  meter: Meter,
  signal?: AbortSignal,
): Promise<ChatMessage[]> {
  aborted(signal);
  if (index.missing) return [];
  const handle = await openOptional(index.sourcePath);
  if (!handle)
    throw new SessionHistoryError("SOURCE_CHANGED", {
      sourcePath: index.sourcePath,
      generation: index.generation,
    });
  try {
    if (!same(await witness(handle, index.sourcePath), index)) {
      throw new SessionHistoryError("SOURCE_CHANGED", {
        sourcePath: index.sourcePath,
        generation: index.generation,
      });
    }
    const chunks: Buffer[] = [];
    let position = first;
    while (position < end) {
      const part = await readAt(
        handle,
        position,
        Math.min(SESSION_HISTORY_LIMITS.chunkBytes, end - position),
        meter,
        signal,
      );
      if (!part.length)
        throw new SessionHistoryError("SOURCE_CHANGED", {
          sourcePath: index.sourcePath,
          generation: index.generation,
        });
      chunks.push(part);
      position += part.length;
      await yieldImmediate();
    }
    const body = Buffer.concat(chunks, end - first);
    const records: ChatMessage[] = [];
    let begin = 0;
    while (begin < body.length) {
      aborted(signal);
      const newline = body.indexOf(10, begin);
      const stop = newline < 0 ? body.length : newline;
      if (stop - begin > SESSION_HISTORY_LIMITS.maxRecordBytes) {
        throw new SessionHistoryError("SOURCE_CHANGED", {
          sourcePath: index.sourcePath,
          generation: index.generation,
        });
      }
      const message = parseMessage(body.subarray(begin, stop));
      if (message) records.push(message);
      begin = stop + 1;
      if (records.length % 128 === 0) await yieldImmediate();
    }
    await assertUnchanged(index.sourcePath, handle, index, index.generation, signal);
    if (index.liveWitness) {
      const live = await openOptional(path);
      if (!live)
        throw new SessionHistoryError("SOURCE_CHANGED", {
          sourcePath: path,
          generation: index.generation,
        });
      try {
        await assertUnchanged(path, live, index.liveWitness, index.generation, signal);
      } finally {
        await live.close();
      }
    }
    return records;
  } finally {
    await handle.close();
  }
}

async function readHistory(
  name: string,
  options: SessionHistoryPageOptions,
  turn?: number,
): Promise<SessionHistoryPage> {
  const path = sessionPath(name);
  const maxBytes = checkedInteger(
    options.maxBytes ?? SESSION_HISTORY_LIMITS.defaultBytes,
    SESSION_HISTORY_LIMITS.maxBytes,
    "maxBytes",
  );
  const limit = checkedInteger(
    options.limitTurns ?? SESSION_HISTORY_LIMITS.defaultTurns,
    SESSION_HISTORY_LIMITS.maxTurns,
    "limitTurns",
  );
  aborted(options.signal);
  const cursor = options.cursor === undefined ? undefined : decodeCursor(path, options.cursor);
  const { index, meter: shared } = await acquire(path, options.signal);
  const meter = { ...shared };
  aborted(options.signal);
  if (cursor && (cursor.generation !== index.generation || cursor.before > index.groups.length)) {
    throw new SessionHistoryError("STALE_CURSOR", {
      sourcePath: index.sourcePath,
      generation: index.generation,
    });
  }
  if (turn !== undefined && turn > index.totalTurns) {
    throw new SessionHistoryError("TURN_NOT_FOUND", {
      sourcePath: index.sourcePath,
      generation: index.generation,
      turn,
    });
  }
  const endGroup = turn ?? cursor?.before ?? index.groups.length;
  let startGroup = endGroup;
  let materializedBytes = 0;
  const selected: Array<{
    group: number;
    start: number;
    end: number;
    omission?: SessionHistoryOmission;
  }> = [];
  while (startGroup > 0 && endGroup - startGroup < (turn === undefined ? limit : 1)) {
    const nextStart = index.groups[startGroup - 1]!;
    const end = index.groups[startGroup] ?? index.size;
    const large = index.largeGroups.get(startGroup - 1);
    const oversized = !!large || end - nextStart > maxBytes;
    let omission: SessionHistoryOmission | undefined;
    if (oversized) {
      if (turn !== undefined) {
        throw new SessionHistoryError(large ? "RECORD_TOO_LARGE" : "TURN_TOO_LARGE", {
          sourcePath: index.sourcePath,
          generation: index.generation,
          turn: index.totalTurns ? startGroup : 0,
          turnExact: true,
          byteOffset: large?.byteOffset ?? nextStart,
          byteLength: large?.byteLength ?? end - nextStart,
          maxBytes: large ? SESSION_HISTORY_LIMITS.maxRecordBytes : maxBytes,
          ...meter,
        });
      }
      omission = {
        kind: "oversized-turn",
        reason: large ? "record" : "turn",
        turn: index.totalTurns ? startGroup : 0,
        byteOffset: nextStart,
        byteLength: end - nextStart,
        ...(large ? { recordByteLength: large.byteLength } : {}),
        maxBytes,
        exportRequired: !!large || end - nextStart > SESSION_HISTORY_LIMITS.maxBytes,
        sourcePath: index.sourcePath,
        generation: index.generation,
      };
    } else {
      if (materializedBytes + end - nextStart > maxBytes) break;
      materializedBytes += end - nextStart;
    }
    selected.push({ group: startGroup - 1, start: nextStart, end, omission });
    startGroup--;
  }
  const records: SessionHistoryRecord[] = [];
  const omissions: SessionHistoryOmission[] = [];
  let rangeStart: number | undefined;
  let rangeEnd = 0;
  const flush = async () => {
    if (rangeStart === undefined) return;
    for (const record of await readRange(
      path,
      index,
      rangeStart,
      rangeEnd,
      meter,
      options.signal,
    )) {
      records.push(record);
    }
    rangeStart = undefined;
  };
  for (const group of selected.reverse()) {
    if (group.omission) {
      await flush();
      omissions.push(group.omission);
      records.push({
        role: group.omission.turn ? "user" : "assistant",
        content: `History turn omitted (${group.omission.byteLength} bytes). ${group.omission.exportRequired ? "Export the original session." : "Open bounded turn details or export the original session."}`,
        historyOmission: group.omission,
      });
    } else {
      rangeStart ??= group.start;
      rangeEnd = group.end;
    }
  }
  await flush();
  // Even omission-only pages validate that the indexed source has not been rebound meanwhile.
  if (!materializedBytes) await readRange(path, index, 0, 0, meter, options.signal);
  aborted(options.signal);
  return {
    records,
    omissions,
    startTurn: startGroup,
    generation: index.generation,
    ...(startGroup > 0 ? { beforeCursor: cursorFor(path, index.generation, startGroup) } : {}),
    hasMore: startGroup > 0,
    totalTurns: index.totalTurns,
    sourceSize: index.size,
    sourcePath: index.sourcePath,
    ...meter,
  };
}

/** Newest page first; beforeCursor is an exclusive user-group boundary, stable across appends. */
export async function readSessionHistoryPage(
  name: string,
  options: SessionHistoryPageOptions = {},
): Promise<SessionHistoryPage> {
  return readHistory(name, options);
}

/** Read exactly one 1-based raw user turn, preserving its complete assistant/tool chain. */
export async function readSessionHistoryTurn(
  name: string,
  turn: number,
  options: SessionHistoryBounds = {},
): Promise<SessionHistoryPage> {
  checkedInteger(turn, Number.MAX_SAFE_INTEGER, "turn");
  return readHistory(name, options, turn);
}
