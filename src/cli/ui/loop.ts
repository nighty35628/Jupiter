/** Pure parsing for `/loop <interval> <prompt>`; cancellation contract is enforced in App.tsx. */

/** Lower bound on loop interval (ms). Faster than this would queue submits faster than turns finish. */
export const MIN_LOOP_INTERVAL_MS = 5_000;
/** Upper bound on loop interval (ms). Beyond a few hours, use cron. */
export const MAX_LOOP_INTERVAL_MS = 6 * 60 * 60_000;

/** Returns null on bad shape OR out-of-range; caller surfaces as usage hint. */
export function parseLoopInterval(raw: string): { ms: number } | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const m = /^([0-9]+(?:\.[0-9]+)?)(s|sec|secs|m|min|mins|h|hr|hrs)?$/.exec(s);
  if (!m) return null;
  const n = Number.parseFloat(m[1] ?? "");
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] ?? "s";
  let ms: number;
  if (unit === "s" || unit === "sec" || unit === "secs") ms = Math.round(n * 1000);
  else if (unit === "m" || unit === "min" || unit === "mins") ms = Math.round(n * 60_000);
  else if (unit === "h" || unit === "hr" || unit === "hrs") ms = Math.round(n * 60 * 60_000);
  else return null;
  if (ms < MIN_LOOP_INTERVAL_MS) return null;
  if (ms > MAX_LOOP_INTERVAL_MS) return null;
  return { ms };
}

export interface ParsedLoopArgs {
  intervalMs: number;
  prompt: string;
}

export type LoopCommand =
  | { kind: "start"; intervalMs: number; prompt: string }
  | { kind: "stop" }
  | { kind: "status" }
  | { kind: "error"; message: string };

export function parseLoopCommand(args: readonly string[]): LoopCommand {
  if (args.length === 0) return { kind: "status" };
  const first = (args[0] ?? "").toLowerCase();
  if (args.length === 1 && (first === "stop" || first === "off" || first === "cancel")) {
    return { kind: "stop" };
  }
  const interval = parseLoopInterval(args[0] ?? "");
  if (!interval) {
    return {
      kind: "error",
      message:
        "usage: /loop <interval> <prompt>   (interval = 5s..6h, e.g. 30s, 5m, 1h)\n" +
        "       /loop stop                  (cancel an active loop)\n" +
        "       /loop                       (show active-loop status)",
    };
  }
  const prompt = args.slice(1).join(" ").trim();
  if (!prompt) {
    return {
      kind: "error",
      message: `usage: /loop ${args[0]} <prompt>   — interval is fine but the prompt is missing.`,
    };
  }
  return { kind: "start", intervalMs: interval.ms, prompt };
}

export function formatLoopStatus(prompt: string, nextFireMs: number, iter: number): string {
  const preview = prompt.length > 36 ? `${prompt.slice(0, 33)}…` : prompt;
  const when = nextFireMs <= 0 ? "firing now" : `next in ${formatDuration(nextFireMs)}`;
  return `loop: \`${preview}\` · ${when} · iter ${iter}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h${mm}m`;
}
