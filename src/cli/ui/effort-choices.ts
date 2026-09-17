import {
  type ReasoningSelection,
  displayReasoningSelection,
  resolveModelCapability,
} from "../../provider-capabilities.js";

/** `max` is a DeepSeek-only reasoning extension; non-DeepSeek hosts 400 on it (#1794). */
export function effortChoicesForBaseUrl(
  baseUrl: string | undefined | null,
  model = "deepseek-flash",
): readonly ReasoningSelection[] {
  return resolveModelCapability(baseUrl, model).thinkingLevels;
}

export function effortArgsHintFor(choices: readonly ReasoningSelection[]): string {
  return `<${choices.map((choice) => displayReasoningSelection(choice, choices)).join("|")}>`;
}

export function effortArgumentChoicesFor(
  choices: readonly ReasoningSelection[],
): ReasoningSelection[] {
  return choices.map((choice) => displayReasoningSelection(choice, choices));
}
