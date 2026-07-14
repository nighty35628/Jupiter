import type { DeepSeekClient } from "../client.js";
import { t } from "../i18n/index.js";
import {
  ProviderHttpError,
  extractProviderErrorDetail,
  sanitizeProviderErrorText,
} from "../provider-http-error.js";

export interface DeepSeekProbeResult {
  reachable: boolean;
}

export interface FormatLoopErrorOptions {
  /** baseUrl of the upstream that just failed — picks DS vs generic wording. */
  upstreamHost?: string;
}

export function formatLoopError(
  err: Error,
  probe?: DeepSeekProbeResult,
  opts?: FormatLoopErrorOptions,
): string {
  const msg = err.message ?? "";
  if (msg.includes("maximum context length")) {
    const reqMatch = msg.match(/requested\s+(\d+)\s+tokens/);
    const requested = reqMatch
      ? `${Number(reqMatch[1]).toLocaleString()} tokens`
      : t("errors.contextOverflowTooMany");
    return t("errors.contextOverflow", { requested });
  }

  if (err instanceof ProviderHttpError) {
    return formatProviderHttpError(err, probe);
  }

  const m = /^(?:DeepSeek|Upstream\s+\S+) (\d{3}):?\s*([\s\S]*)$/.exec(msg);
  if (!m) return msg;
  const status = m[1] ?? "";
  const body = m[2] ?? "";
  const inner = extractDeepSeekErrorMessage(body);

  if (status === "401") return t("errors.auth401", { inner });
  if (status === "403") return t("errors.auth403", { inner });
  if (status === "402") return t("errors.balance402", { inner });
  if (status === "422") return t("errors.badparam422", { inner });
  if (status === "400") return t("errors.badrequest400", { inner });
  if (status === "429") return t("errors.concurrency429", { inner });
  if (is5xxStatus(status)) {
    return appendProviderDetail(format5xx(status, probe, opts?.upstreamHost), inner);
  }
  return msg;
}

export function is5xxError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof ProviderHttpError) return err.status >= 500 && err.status <= 599;
  const m = /^DeepSeek (5\d{2}):/.exec(err.message ?? "");
  return m !== null;
}

export function is4xxError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof ProviderHttpError) return err.status >= 400 && err.status <= 499;
  return /^DeepSeek (4\d{2}):/.test(err.message ?? "");
}

/** Read structured metadata off thrown errors without resorting to `as any`. */
export function errorMeta(err: unknown): { code?: string; phase?: string } {
  if (!(err instanceof Error)) return {};
  const code = "code" in err && typeof err.code === "string" ? err.code : undefined;
  const phase = "phase" in err && typeof err.phase === "string" ? err.phase : undefined;
  return { code, phase };
}

export async function probeDeepSeekReachable(
  client: DeepSeekClient,
  timeoutMs = 1500,
): Promise<DeepSeekProbeResult> {
  const balance = await client.getBalance({ signal: AbortSignal.timeout(timeoutMs) });
  return { reachable: balance !== null };
}

/** Allow-list — only api.deepseek.com gets DS-specific 5xx wording + balance probe. */
export function isDeepSeekHost(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.deepseek.com";
  } catch {
    return false;
  }
}

function is5xxStatus(status: string): boolean {
  return /^5\d{2}$/.test(status);
}

function format5xx(
  status: string,
  probe: DeepSeekProbeResult | undefined,
  upstreamHost: string | undefined,
): string {
  if (upstreamHost !== undefined && !isDeepSeekHost(upstreamHost)) {
    return formatUpstream5xx(status, upstreamHost);
  }
  return formatDeepSeek5xx(status, probe);
}

function formatDeepSeek5xx(status: string, probe?: DeepSeekProbeResult): string {
  const head = t("errors.deepseek5xxHead", { status });
  const probeNote =
    probe === undefined
      ? ""
      : probe.reachable
        ? t("errors.deepseek5xxReachable")
        : t("errors.deepseek5xxUnreachable");
  const action =
    probe?.reachable === false
      ? t("errors.deepseek5xxActionNetwork")
      : t("errors.deepseek5xxActionRetry");
  return `${head}${probeNote}${action}`;
}

function formatUpstream5xx(status: string, baseUrl: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host || baseUrl;
  } catch {
    /* keep raw baseUrl */
  }
  const head = t("errors.upstream5xxHead", { status, host });
  const action = t("errors.upstream5xxActionRetry");
  return `${head}${action}`;
}

export function reasonPrefixFor(reason: "aborted" | "context-guard" | "stuck"): string {
  if (reason === "aborted") return t("errors.reasonAborted");
  if (reason === "context-guard") return t("errors.reasonContextGuard");
  return t("errors.reasonStuck");
}

export function errorLabelFor(reason: "aborted" | "context-guard" | "stuck"): string {
  if (reason === "aborted") return t("errors.labelAborted");
  if (reason === "context-guard") return t("errors.labelContextGuard");
  return t("errors.labelStuck");
}

function extractDeepSeekErrorMessage(body: string): string {
  return extractProviderErrorDetail(body) || t("errors.innerNoMessage");
}

function formatProviderHttpError(err: ProviderHttpError, probe?: DeepSeekProbeResult): string {
  const status = String(err.status);
  const inner = err.safeDetail || t("errors.innerNoMessage");
  if (err.providerHost !== "api.deepseek.com") {
    return t("errors.upstreamHttp", {
      host: err.providerHost,
      status,
      inner,
    });
  }
  if (status === "401") return t("errors.auth401", { inner });
  if (status === "403") return t("errors.auth403", { inner });
  if (status === "402") return t("errors.balance402", { inner });
  if (status === "422") return t("errors.badparam422", { inner });
  if (status === "400") return t("errors.badrequest400", { inner });
  if (status === "429") return t("errors.concurrency429", { inner });
  if (is5xxStatus(status)) {
    return appendProviderDetail(formatDeepSeek5xx(status, probe), err.safeDetail);
  }
  return sanitizeProviderErrorText(err.message);
}

function appendProviderDetail(base: string, detail: string): string {
  if (!detail || detail === t("errors.innerNoMessage")) return base;
  return `${base} ${detail}`;
}
