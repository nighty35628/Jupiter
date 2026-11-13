import type { z } from "zod";
import { redactEventText } from "../core/event-redaction.js";
import type { ToolRegistry } from "../tools.js";
import { checkpointSchema } from "./types.js";

export function registerScheduledCheckpoint(
  registry: ToolRegistry,
  publish: (checkpoint: z.infer<typeof checkpointSchema>) => void,
): void {
  registry.register({
    name: "scheduled_checkpoint",
    description:
      "Record a completed task stage, observed evidence, and remaining steps. Call after each meaningful stage and before ending a scheduled task. Never claim evidence you did not observe.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        step: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
        remaining: { type: "array", items: { type: "string" } },
      },
      required: ["step", "evidence", "remaining"],
      additionalProperties: false,
    },
    fn: (input: unknown) => {
      const args = checkpointSchema.omit({ at: true }).parse(input);
      publish({
        at: Date.now(),
        step: redactEventText(args.step).slice(0, 2000),
        evidence: args.evidence.map((item) => redactEventText(item).slice(0, 2000)),
        remaining: args.remaining.map((item) => redactEventText(item).slice(0, 2000)),
      });
      return "Checkpoint persisted; continue against the original objective and remaining steps.";
    },
  });
}
