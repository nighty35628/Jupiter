export type OneShotPlanCommand =
  | { type: "arm" }
  | { type: "cancel" }
  | { type: "send"; text: string };

export function parseOneShotPlanCommand(input: string): OneShotPlanCommand | null {
  const trimmed = input.trim();
  const match = /^\/plan(?:\s+([\s\S]+))?$/.exec(trimmed);
  if (!match) return null;

  const arg = match[1]?.trim();
  if (!arg) return { type: "arm" };

  const lower = arg.toLowerCase();
  if (lower === "off" || lower === "cancel") return { type: "cancel" };

  return { type: "send", text: arg };
}

export function buildOneShotPlanPrompt(text: string): string {
  return [
    "One-shot Plan mode is active for this request.",
    "",
    "First investigate only as needed, then call `submit_plan` with a concrete implementation plan before doing any mutating work.",
    "Do not modify files, run non-read-only shell commands, or use tools that change external state before the plan is approved.",
    "After the user approves the plan, continue executing the original request in the same turn.",
    "",
    "User request:",
    text.trim(),
  ].join("\n");
}
