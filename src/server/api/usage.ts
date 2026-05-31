import { cacheSavingsUsd } from "../../telemetry/stats.js";
import { aggregateUsage, formatLogSize, readUsageLog } from "../../telemetry/usage.js";
import type { DashboardContext } from "../context.js";
import type { ApiResult } from "../router.js";

interface DailyBucket {
  /** UTC day key, ISO yyyy-mm-dd. Sorted ascending. */
  day: string;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  costUsd: number;
  cacheSavingsUsd: number;
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function buildSeries(records: ReturnType<typeof readUsageLog>): DailyBucket[] {
  const map = new Map<string, DailyBucket>();
  for (const r of records) {
    const day = dayKey(r.ts);
    let b = map.get(day);
    if (!b) {
      b = {
        day,
        turns: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        costUsd: 0,
        cacheSavingsUsd: 0,
      };
      map.set(day, b);
    }
    b.turns += 1;
    b.promptTokens += r.promptTokens;
    b.completionTokens += r.completionTokens;
    b.cacheHitTokens += r.cacheHitTokens;
    b.cacheMissTokens += r.cacheMissTokens;
    b.costUsd += r.costUsd;
    b.cacheSavingsUsd += cacheSavingsUsd(r.model, r.cacheHitTokens);
  }
  return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
}

export async function handleUsage(
  method: string,
  rest: string[],
  _body: string,
  ctx: DashboardContext,
): Promise<ApiResult> {
  if (method !== "GET") {
    return { status: 405, body: { error: "GET only" } };
  }
  const records = readUsageLog(ctx.usageLogPath);

  // /api/usage/series → daily roll-ups for the chart. Separate sub-path
  // so the main /api/usage stays a small dashboard payload that polls
  // every 5s without dragging the series along.
  if (rest[0] === "series") {
    return {
      status: 200,
      body: {
        days: buildSeries(records),
        recordCount: records.length,
      },
    };
  }

  const agg = aggregateUsage(records);
  return {
    status: 200,
    body: {
      logPath: ctx.usageLogPath,
      logSize: formatLogSize(ctx.usageLogPath),
      recordCount: records.length,
      buckets: agg.buckets,
      byModel: agg.byModel,
      bySession: agg.bySession,
      firstSeen: agg.firstSeen,
      lastSeen: agg.lastSeen,
      subagents: agg.subagents ?? null,
    },
  };
}
