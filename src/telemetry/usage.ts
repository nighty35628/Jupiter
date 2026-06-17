/** Append-only JSONL of per-turn tokens + cost; best-effort writes, never blocks the turn. No prompts/completions logged. */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Usage } from "../client.js";
import {
  CLAUDE_SONNET_PRICING,
  DEEPSEEK_PRICING,
  cacheSavingsUsd,
  claudeEquivalentCost,
  costUsd,
} from "./stats.js";

/** One turn's snapshot — serialized verbatim as a JSONL line. */
export interface UsageRecord {
  /** Epoch millis when the record was written. */
  ts: number;
  /** Session name if the turn ran inside a persisted session, `null` for ephemeral. */
  session: string | null;
  /** Model id the turn ran against (drives the pricing lookup). */
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /** Total cost of the turn in USD. */
  costUsd: number;
  /** What the same turn would have cost at Claude Sonnet 4.6 rates. */
  claudeEquivUsd: number;
  /** Absent on legacy records — treat as "turn" when missing. */
  kind?: "turn" | "subagent";
  /** Present when `kind === "subagent"`. Attribution metadata for the /stats roll-up. */
  subagent?: {
    /** Skill that spawned it, when the spawn came from a `runAs: subagent` skill. */
    skillName?: string;
    /** First ~60 chars of the task prompt — enough context to recognize a run, never the full text. */
    taskPreview: string;
    /** Tool calls the child loop dispatched before returning. */
    toolIters: number;
    /** Wall-clock ms. */
    durationMs: number;
  };
}

/** Where the log lives. Tests override via `opts.path`. */
export function defaultUsageLogPath(homeDirOverride?: string): string {
  return join(homeDirOverride ?? homedir(), ".jupiter", "usage.jsonl");
}

export interface AppendUsageInput {
  session: string | null;
  model: string;
  usage: Usage;
  /** Override the timestamp (tests). */
  now?: number;
  /** Override the log path (tests). */
  path?: string;
  /** When appending a subagent summary row, set `kind: "subagent"` and populate `subagent`. */
  kind?: "turn" | "subagent";
  subagent?: UsageRecord["subagent"];
}

const USAGE_COMPACTION_THRESHOLD_BYTES = 5 * 1024 * 1024;
const USAGE_RETENTION_DAYS = 365;

function compactUsageLogIfLarge(path: string, now: number): void {
  // Open once for the size check + read so they bind to the same fd
  // (CodeQL js/file-system-race). Concurrent appenders that grow the
  // log between check and read can no longer cause us to act on a
  // stale size and rewrite based on partial content.
  let raw: string;
  try {
    const fd = openSync(path, "r");
    try {
      const stat = fstatSync(fd);
      if (stat.size < USAGE_COMPACTION_THRESHOLD_BYTES) return;
      const buf = Buffer.alloc(stat.size);
      let read = 0;
      while (read < stat.size) {
        const n = readSync(fd, buf, read, stat.size - read, read);
        if (n <= 0) break;
        read += n;
      }
      raw = buf.toString("utf8", 0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return;
  }
  const cutoff = now - USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (isValidRecord(rec) && rec.ts >= cutoff) kept.push(line);
    } catch {
      /* skip malformed */
    }
  }
  // No-op when nothing aged out — avoids rewrite storms on fresh logs.
  if (kept.length === lines.filter((l) => l.trim()).length) return;
  // Write to a sibling tmp path then rename — atomic from a reader's
  // POV and severs CodeQL's stat→write taint chain. Concurrent
  // appenders during the compaction window lose their entries; we
  // accept that for a best-effort usage log.
  const tmp = `${path}.compacting`;
  try {
    writeFileSync(tmp, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp may not exist — ignore */
    }
  }
}

/** Returns the record so tests can assert cost fields without re-reading the log. */
export function appendUsage(input: AppendUsageInput): UsageRecord {
  const record: UsageRecord = {
    ts: input.now ?? Date.now(),
    session: input.session,
    model: input.model,
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    cacheHitTokens: input.usage.promptCacheHitTokens,
    cacheMissTokens: input.usage.promptCacheMissTokens,
    costUsd: costUsd(input.model, input.usage),
    claudeEquivUsd: claudeEquivalentCost(input.usage),
  };
  if (input.kind === "subagent") record.kind = "subagent";
  if (input.subagent) record.subagent = input.subagent;

  const path = input.path ?? defaultUsageLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    compactUsageLogIfLarge(path, record.ts);
  } catch {
    /* best-effort — disk failure shouldn't break the chat */
  }
  return record;
}

export function readUsageLog(path: string = defaultUsageLogPath()): UsageRecord[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (isValidRecord(rec)) out.push(rec);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function isValidRecord(rec: unknown): rec is UsageRecord {
  if (!rec || typeof rec !== "object") return false;
  const r = rec as Partial<UsageRecord>;
  return (
    typeof r.ts === "number" &&
    typeof r.model === "string" &&
    typeof r.promptTokens === "number" &&
    typeof r.completionTokens === "number" &&
    typeof r.cacheHitTokens === "number" &&
    typeof r.cacheMissTokens === "number" &&
    typeof r.costUsd === "number" &&
    typeof r.claudeEquivUsd === "number"
  );
}

/** One row of the `jupiter stats` dashboard — a rolled-up window. */
export interface UsageBucket {
  label: string;
  /** Start of the window as epoch millis. `0` = unbounded (all-time). */
  since: number;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  costUsd: number;
  claudeEquivUsd: number;
  /** Recomputed from current pricing each aggregate — intentionally NOT frozen with `costUsd`. */
  cacheSavingsUsd: number;
}

/** Cache hit ratio for a bucket — zero denominator returns 0. */
export function bucketCacheHitRatio(b: UsageBucket): number {
  const denom = b.cacheHitTokens + b.cacheMissTokens;
  return denom > 0 ? b.cacheHitTokens / denom : 0;
}

/** Savings vs Claude as a fraction (0.94 = 94% savings). 0 if Claude cost is 0. */
export function bucketSavingsFraction(b: UsageBucket): number {
  return b.claudeEquivUsd > 0 ? 1 - b.costUsd / b.claudeEquivUsd : 0;
}

function emptyBucket(label: string, since: number): UsageBucket {
  return {
    label,
    since,
    turns: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    costUsd: 0,
    claudeEquivUsd: 0,
    cacheSavingsUsd: 0,
  };
}

function addToBucket(b: UsageBucket, r: UsageRecord): void {
  b.turns += 1;
  b.promptTokens += r.promptTokens;
  b.completionTokens += r.completionTokens;
  b.cacheHitTokens += r.cacheHitTokens;
  b.cacheMissTokens += r.cacheMissTokens;
  b.costUsd += r.costUsd;
  b.claudeEquivUsd += r.claudeEquivUsd;
  b.cacheSavingsUsd += cacheSavingsUsd(r.model, r.cacheHitTokens);
}

export interface AggregateOptions {
  /** Override `Date.now()` for deterministic tests. */
  now?: number;
}

export interface UsageAggregate {
  /** Fixed-order rolling windows: today, week, month, all-time. */
  buckets: UsageBucket[];
  /** Model id → turn count. Sorted descending; top entry is the "most used." */
  byModel: Array<{ model: string; turns: number }>;
  /** Session name → turn count. Sorted descending. Null sessions are grouped under `"(ephemeral)"`. */
  bySession: Array<{ session: string; turns: number }>;
  /** Earliest record's ts, or `null` when the log is empty. Drives "saved $X since <date>". */
  firstSeen: number | null;
  /** Latest record's ts, or `null` when the log is empty. */
  lastSeen: number | null;
  /** Undefined when no subagent records exist; counts spawns, not internal child-loop turns. */
  subagents?: SubagentAggregate;
}

export interface UsageHistoryDay {
  day: string;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  costUsd: number;
  claudeEquivUsd: number;
  cacheSavingsUsd: number;
}

export interface UsageHistoryMonth {
  month: string;
  label: string;
  start: number;
  end: number;
  total: UsageHistoryDay;
  days: UsageHistoryDay[];
}

export interface UsageHistoryAggregate {
  generatedAt: number;
  recordCount: number;
  months: UsageHistoryMonth[];
}

/** Rolled-up view of all `kind: "subagent"` records. */
export interface SubagentAggregate {
  total: number;
  costUsd: number;
  totalDurationMs: number;
  /** Per-skill breakdown. Records without `skillName` (raw spawn_subagent calls) group under `"(adhoc)"`. */
  bySkill: Array<{ skillName: string; count: number; costUsd: number; durationMs: number }>;
}

/** Rolling 24h/7d/30d windows — avoids "it's 00:03, 'today' is empty" surprises. */
export function aggregateUsage(
  records: UsageRecord[],
  opts: AggregateOptions = {},
): UsageAggregate {
  const now = opts.now ?? Date.now();
  const day = 24 * 60 * 60 * 1000;
  const today = emptyBucket("today", now - day);
  const week = emptyBucket("week", now - 7 * day);
  const month = emptyBucket("month", now - 30 * day);
  const all = emptyBucket("all-time", 0);

  const modelCounts = new Map<string, number>();
  const sessionCounts = new Map<string, number>();
  let firstSeen: number | null = null;
  let lastSeen: number | null = null;
  const skillCounts = new Map<string, { count: number; costUsd: number; durationMs: number }>();
  let subagentTotal = 0;
  let subagentCost = 0;
  let subagentDuration = 0;

  for (const r of records) {
    addToBucket(all, r);
    if (r.ts >= today.since) addToBucket(today, r);
    if (r.ts >= week.since) addToBucket(week, r);
    if (r.ts >= month.since) addToBucket(month, r);

    modelCounts.set(r.model, (modelCounts.get(r.model) ?? 0) + 1);
    const sessKey = r.session ?? "(ephemeral)";
    sessionCounts.set(sessKey, (sessionCounts.get(sessKey) ?? 0) + 1);

    if (firstSeen === null || r.ts < firstSeen) firstSeen = r.ts;
    if (lastSeen === null || r.ts > lastSeen) lastSeen = r.ts;

    if (r.kind === "subagent") {
      subagentTotal += 1;
      subagentCost += r.costUsd;
      const dur = r.subagent?.durationMs ?? 0;
      subagentDuration += dur;
      const key = r.subagent?.skillName?.trim() || "(adhoc)";
      const prev = skillCounts.get(key) ?? { count: 0, costUsd: 0, durationMs: 0 };
      prev.count += 1;
      prev.costUsd += r.costUsd;
      prev.durationMs += dur;
      skillCounts.set(key, prev);
    }
  }

  const byModel = Array.from(modelCounts.entries())
    .map(([model, turns]) => ({ model, turns }))
    .sort((a, b) => b.turns - a.turns);
  const bySession = Array.from(sessionCounts.entries())
    .map(([session, turns]) => ({ session, turns }))
    .sort((a, b) => b.turns - a.turns);

  const subagents: SubagentAggregate | undefined =
    subagentTotal > 0
      ? {
          total: subagentTotal,
          costUsd: subagentCost,
          totalDurationMs: subagentDuration,
          bySkill: Array.from(skillCounts.entries())
            .map(([skillName, v]) => ({ skillName, ...v }))
            .sort((a, b) => b.count - a.count),
        }
      : undefined;

  return {
    buckets: [today, week, month, all],
    byModel,
    bySession,
    firstSeen,
    lastSeen,
    subagents,
  };
}

export interface UsageHistoryOptions {
  now?: number;
  monthCount?: number;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthLabel(date: Date): string {
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function emptyHistoryDay(day: string): UsageHistoryDay {
  return {
    day,
    turns: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    costUsd: 0,
    claudeEquivUsd: 0,
    cacheSavingsUsd: 0,
  };
}

function addRecordToHistoryDay(day: UsageHistoryDay, record: UsageRecord): void {
  day.turns += 1;
  day.promptTokens += record.promptTokens;
  day.completionTokens += record.completionTokens;
  day.cacheHitTokens += record.cacheHitTokens;
  day.cacheMissTokens += record.cacheMissTokens;
  day.costUsd += record.costUsd;
  day.claudeEquivUsd += record.claudeEquivUsd;
  day.cacheSavingsUsd += cacheSavingsUsd(record.model, record.cacheHitTokens);
}

export function aggregateUsageHistory(
  records: UsageRecord[],
  opts: UsageHistoryOptions = {},
): UsageHistoryAggregate {
  const generatedAt = opts.now ?? Date.now();
  const monthCount = Math.max(1, Math.min(36, Math.floor(opts.monthCount ?? 13)));
  const now = new Date(generatedAt);
  const monthEntries: UsageHistoryMonth[] = [];
  const byMonth = new Map<string, UsageHistoryMonth>();

  for (let i = 0; i < monthCount; i += 1) {
    const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const endDate = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 1));
    const key = monthKey(startDate);
    const month: UsageHistoryMonth = {
      month: key,
      label: monthLabel(startDate),
      start: startDate.getTime(),
      end: endDate.getTime(),
      total: emptyHistoryDay(key),
      days: [],
    };
    monthEntries.push(month);
    byMonth.set(key, month);
  }

  const dayMaps = new Map<string, Map<string, UsageHistoryDay>>();
  for (const record of records) {
    const date = new Date(record.ts);
    const key = monthKey(date);
    const month = byMonth.get(key);
    if (!month || record.ts < month.start || record.ts >= month.end) continue;
    addRecordToHistoryDay(month.total, record);
    const dKey = dayKey(date);
    let days = dayMaps.get(key);
    if (!days) {
      days = new Map();
      dayMaps.set(key, days);
    }
    let day = days.get(dKey);
    if (!day) {
      day = emptyHistoryDay(dKey);
      days.set(dKey, day);
    }
    addRecordToHistoryDay(day, record);
  }

  for (const month of monthEntries) {
    month.days = Array.from(dayMaps.get(month.month)?.values() ?? []).sort((a, b) =>
      a.day.localeCompare(b.day),
    );
  }

  return { generatedAt, recordCount: records.length, months: monthEntries };
}

/** File-size helper for the stats header — "1.2 MB" etc. Returns "" if missing. */
export function formatLogSize(path: string = defaultUsageLogPath()): string {
  if (!existsSync(path)) return "";
  try {
    const s = statSync(path);
    const bytes = s.size;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } catch {
    return "";
  }
}

/** Re-exports for downstream consumers that also want the pricing constants. */
export { CLAUDE_SONNET_PRICING, DEEPSEEK_PRICING };
