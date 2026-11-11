import type { ProviderDialectPreference, ReasoningEffort } from "./config.js";
import { type ModelCapability, resolveModelCapability } from "./provider-capabilities.js";

/** Compatibility estimate, not a model specification or an endpoint guarantee. */
export const DEFAULT_CONTEXT_TOKENS = 131_072;

export type BudgetSource = "override" | "metadata" | "official" | "server" | "fallback";
type BudgetCapability = Pick<
  ModelCapability,
  "contextWindowTokens" | "maxOutputTokens" | "defaultOutputTokens"
>;

export interface RequestBudgetOptions {
  baseUrl?: string | null;
  model: string;
  dialect?: ProviderDialectPreference;
  /** Already validated metadata for this endpoint/dialect/model snapshot only. */
  capability?: BudgetCapability;
  /** Explicit total-window override, separate from legacy contextTokens[model]. */
  contextWindowTokens?: number;
  /** Legacy contextTokens[model] is an input cap; output is not subtracted from it. */
  inputTokenLimit?: number;
  /** Only user-declared/custom limits may imply a larger unknown fallback window. */
  inputTokenLimitExplicit?: boolean;
  /** Client-owned explicit server evidence; constrains known C, replaces unknown fallback C. */
  serverContextWindowTokens?: number;
  /** Explicit prompt-limit evidence kept by the caller's client, never persisted here. */
  serverInputTokenLimit?: number;
  maxTokens?: number;
  /** Request-local output ceiling (e.g. continuation/compaction), never a model spec. */
  outputTokenCap?: number;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: ReasoningEffort;
}

export interface RequestBudget {
  /** C: input + generated output, including reasoning where the provider counts it. */
  readonly contextWindowTokens: number;
  /** R: reservation; estimated only when the provider default is unknown. */
  readonly outputReserveTokens: number;
  /** Wire max_tokens. Undefined preserves the unknown third-party server default. */
  readonly maxTokens: number | undefined;
  /** The explicit/default output was capped for this request, never in the model specification. */
  readonly outputClamped: boolean;
  readonly safetyTokens: number;
  /** Prompt ceiling before reserving output, retained for continuation recalculation. */
  readonly inputTokenLimit: number;
  readonly inputLimit: number;
  /** Source of C, not of the legacy input ceiling or request-local caps. */
  readonly source: BudgetSource;
  readonly outputSource: "explicit" | "default" | "request-cap" | "estimate";
  /** C and/or R is a compatibility estimate, not a verified provider limit. */
  readonly estimated: boolean;
}

function tokens(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
    : undefined;
}

/** Pure request arithmetic: no config I/O, counting, mutation, probing or persistence. */
export function resolveRequestBudget(opts: RequestBudgetOptions): RequestBudget {
  const official = resolveModelCapability(opts.baseUrl, opts.model, opts.dialect);
  const overrideWindow = tokens(opts.contextWindowTokens);
  const metadataWindow = tokens(opts.capability?.contextWindowTokens);
  const knownWindow = overrideWindow ?? metadataWindow ?? official.contextWindowTokens;
  const serverWindow = tokens(opts.serverContextWindowTokens);
  let source: BudgetSource =
    overrideWindow !== undefined
      ? "override"
      : metadataWindow !== undefined
        ? "metadata"
        : official.contextWindowTokens !== undefined
          ? "official"
          : "fallback";
  const defaults = opts.capability?.defaultOutputTokens ?? official.defaultOutputTokens;
  const defaultOutput = tokens(
    opts.thinking === "disabled"
      ? defaults?.nonThinking
      : opts.reasoningEffort === "max"
        ? defaults?.maxThinking
        : defaults?.thinking,
  );
  const requestedOutput = tokens(opts.maxTokens);
  const requestCap = tokens(opts.outputTokenCap);
  const knownOutput = requestedOutput ?? defaultOutput ?? requestCap;
  const outputSource =
    requestedOutput !== undefined
      ? "explicit"
      : defaultOutput !== undefined
        ? "default"
        : requestCap !== undefined
          ? "request-cap"
          : "estimate";
  const providerOutputCap = tokens(opts.capability?.maxOutputTokens) ?? official.maxOutputTokens;
  const inferredOutput = Math.min(
    knownOutput ?? 8_192,
    providerOutputCap ?? Number.MAX_SAFE_INTEGER,
    requestCap ?? Number.MAX_SAFE_INTEGER,
  );
  const declaredInput = opts.inputTokenLimitExplicit ? tokens(opts.inputTokenLimit) : undefined;
  const fallbackWindow =
    declaredInput === undefined
      ? DEFAULT_CONTEXT_TOKENS
      : Math.min(
          Number.MAX_SAFE_INTEGER,
          Math.max(DEFAULT_CONTEXT_TOKENS, declaredInput + inferredOutput + 4_096),
        );
  let contextWindowTokens = knownWindow ?? fallbackWindow;
  if (serverWindow !== undefined && (knownWindow === undefined || serverWindow <= knownWindow)) {
    contextWindowTokens = serverWindow;
    source = "server";
  }
  const safetyTokens = Math.min(4_096, Math.floor(contextWindowTokens * 0.02));
  const cappedOutput = Math.min(
    knownOutput ?? Math.min(8_192, Math.floor(contextWindowTokens / 4)),
    providerOutputCap ?? contextWindowTokens,
    requestCap ?? contextWindowTokens,
  );
  // A server/default reserve that consumes the entire window cannot serve even a short prompt.
  const windowOutputCap =
    cappedOutput >= contextWindowTokens - safetyTokens
      ? Math.floor(contextWindowTokens / 4)
      : contextWindowTokens - safetyTokens;
  const outputReserveTokens = Math.min(cappedOutput, windowOutputCap);
  const inputTokenLimit = Math.min(
    tokens(opts.inputTokenLimit) ?? contextWindowTokens,
    tokens(opts.serverInputTokenLimit) ?? contextWindowTokens,
  );
  return {
    contextWindowTokens,
    outputReserveTokens,
    maxTokens: knownOutput === undefined ? undefined : outputReserveTokens,
    outputClamped: knownOutput !== undefined && outputReserveTokens < knownOutput,
    safetyTokens,
    inputTokenLimit,
    inputLimit: Math.min(
      inputTokenLimit,
      Math.max(0, contextWindowTokens - outputReserveTokens - safetyTokens),
    ),
    source,
    outputSource,
    estimated: source === "fallback" || knownOutput === undefined,
  };
}
