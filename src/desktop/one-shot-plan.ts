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
    "Plan-only mode is active for this request.",
    "",
    "This turn is for planning only. Investigate with read-only tools only if needed, then write a complete SPEC / execution plan as the assistant response.",
    "Do not modify files, run non-read-only shell commands, or use tools that change external state.",
    "Do not call `submit_plan`; do not open an approval gate; do not execute the plan in this turn.",
    "The spec should get as close as possible to execution: goals, assumptions, concrete steps, files/modules likely touched, risks/open questions, and verification.",
    "If a blocking requirement is unclear, ask focused questions instead of executing.",
    "End by asking the user to reply in the next message if they want you to execute.",
    "Wait for the user's next message before doing any implementation.",
    "",
    "User request:",
    text.trim(),
  ].join("\n");
}
