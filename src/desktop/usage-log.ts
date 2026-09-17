import type { LoopEvent } from "../loop/types.js";
import { type UsageRecord, appendUsage } from "../telemetry/usage.js";

export function appendDesktopAssistantFinalUsage(
  ev: Pick<LoopEvent, "role" | "stats">,
  session: string | null,
  opts: { path?: string } = {},
): UsageRecord | null {
  if (ev.role !== "assistant_final" || !ev.stats?.usage) return null;
  return appendUsage({
    session,
    model: ev.stats.model,
    providerId: ev.stats.providerId,
    costUsdOverride: ev.stats.cost,
    usage: ev.stats.usage,
    path: opts.path,
  });
}
