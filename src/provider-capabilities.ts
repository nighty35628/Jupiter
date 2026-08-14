import type { ReasoningEffort } from "./config.js";

export type ProviderDialect = "deepseek" | "azure" | "openai-compatible";
export type DeepSeekThinkingLevel = "off" | "low" | "high" | "max";
export type ReasoningSelection = "off" | ReasoningEffort;

export interface ModelCapability {
  dialect: ProviderDialect;
  officialDeepSeekV4: boolean;
  thinkingLevels: readonly ReasoningSelection[];
  supportsPrefixContinuation: boolean;
  contextWindowTokens?: number;
}

const DEEPSEEK_V4_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
const DEEPSEEK_THINKING_LEVELS: readonly DeepSeekThinkingLevel[] = ["off", "low", "high", "max"];
const STANDARD_THINKING_LEVELS: readonly ReasoningSelection[] = ["low", "medium", "high"];

export function resolveProviderDialect(baseUrl: string | undefined | null): ProviderDialect {
  if (!baseUrl) return "openai-compatible";
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === "api.deepseek.com") return "deepseek";
    if (host === "azure.com" || host.endsWith(".azure.com")) return "azure";
  } catch {
    // Invalid/custom URLs retain the legacy OpenAI-compatible behavior.
  }
  return "openai-compatible";
}

/** Exact trust boundary used when an operation may reuse DeepSeek credentials. */
export function isStrictOfficialDeepSeekEndpoint(baseUrl: string | undefined | null): boolean {
  const raw = baseUrl?.trim() || "https://api.deepseek.com";
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "api.deepseek.com" &&
      (url.port === "" || url.port === "443") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function isOfficialDeepSeekV4Model(model: string): boolean {
  return DEEPSEEK_V4_MODELS.has(model);
}

export function resolveModelCapability(
  baseUrl: string | undefined | null,
  model: string,
): ModelCapability {
  const dialect = resolveProviderDialect(baseUrl);
  const officialDeepSeekV4 = dialect === "deepseek" && isOfficialDeepSeekV4Model(model);
  return {
    dialect,
    officialDeepSeekV4,
    thinkingLevels: officialDeepSeekV4 ? DEEPSEEK_THINKING_LEVELS : STANDARD_THINKING_LEVELS,
    supportsPrefixContinuation: officialDeepSeekV4,
    contextWindowTokens: officialDeepSeekV4 ? 1_048_576 : undefined,
  };
}

/** DeepSeek documents medium/xhigh as aliases of high for current V4 models. */
export function normalizeOfficialDeepSeekEffort(effort: ReasoningEffort): "low" | "high" | "max" {
  return effort === "low" || effort === "max" ? effort : "high";
}

/** Keep DeepSeek's wire-level `low` value while presenting the first user-facing tier as `medium`. */
export function displayReasoningSelection(
  selection: ReasoningSelection,
  choices: readonly ReasoningSelection[],
): ReasoningSelection {
  return choices.includes("max") && selection === "low" ? "medium" : selection;
}

/** Resolve a user-facing DeepSeek tier back to its wire/config value. */
export function parseReasoningSelection(
  selection: string,
  choices: readonly ReasoningSelection[],
): ReasoningSelection | undefined {
  const parsed = choices.includes("max") && selection === "medium" ? "low" : selection;
  return choices.includes(parsed as ReasoningSelection)
    ? (parsed as ReasoningSelection)
    : undefined;
}
