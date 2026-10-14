import { existsSync } from "node:fs";
import { Usage } from "../client.js";
import { loadSessionMeta, patchSessionMeta, sessionPath } from "../memory/session.js";
import type { SessionStats } from "../telemetry/stats.js";
import { appendUsage } from "../telemetry/usage.js";

/** The caller resolves the current stats and source session name before settling. */
export function recordPromptPredictionUsage(args: {
  stats: SessionStats;
  sessionName: string | null;
  model: string;
  providerId: string;
  usage: Usage;
  costUsd: number | null;
  usageComplete?: boolean;
  completionId: string;
  path?: string;
}): void {
  const usage = new Usage(
    args.usage.promptTokens,
    args.usage.completionTokens,
    args.usage.totalTokens,
    args.usage.promptCacheHitTokens,
    Math.max(0, args.usage.promptTokens - args.usage.promptCacheHitTokens),
  );
  const cost = args.costUsd ?? 0;
  args.stats.recordExternal(args.model, usage, args.providerId, cost);
  appendUsage({
    session: args.sessionName,
    model: args.model,
    providerId: args.providerId,
    usage,
    costUsdOverride: cost,
    costKnown: args.costUsd !== null && args.usageComplete === true,
    kind: "auxiliary",
    auxiliary: {
      provider: args.providerId,
      operation: "prompt_prediction",
      requestId: args.completionId,
    },
    path: args.path,
  });

  // Keep existence/read/delta/write synchronous. Never replace newer runtime
  // totals with this stats object's snapshot, or resurrect a deleted transcript.
  if (args.sessionName !== null && existsSync(sessionPath(args.sessionName))) {
    const meta = loadSessionMeta(args.sessionName);
    patchSessionMeta(args.sessionName, {
      totalCostUsd: (meta.totalCostUsd ?? 0) + cost,
      cacheHitTokens: (meta.cacheHitTokens ?? 0) + usage.promptCacheHitTokens,
      cacheMissTokens: (meta.cacheMissTokens ?? 0) + usage.promptCacheMissTokens,
      totalCompletionTokens: (meta.totalCompletionTokens ?? 0) + usage.completionTokens,
    });
  }
}
