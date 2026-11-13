import { z } from "zod";
import type { ToolRegistry } from "../tools.js";
import type { ScheduledTaskInput } from "./types.js";

export interface ScheduledScopeReview {
  goal: NonNullable<ScheduledTaskInput["goal"]>;
  tool: string;
  args: Record<string, unknown>;
}
export const scopeDecisionSchema = z
  .object({ allowed: z.boolean(), reason: z.string().min(1).max(2000) })
  .strict();

export function registerScheduledScopeGuard(
  registry: ToolRegistry,
  options: {
    goal: () => ScheduledTaskInput["goal"];
    review: (input: ScheduledScopeReview) => Promise<z.infer<typeof scopeDecisionSchema>>;
    block: (reason: string) => void;
  },
) {
  let blocked: string | undefined;
  let sinceCheckpoint = 0;
  let tail: Promise<unknown> = Promise.resolve();
  registry.addToolInterceptor("scheduled-goal-scope", (tool, args) => {
    const check = async () => {
      const goal = options.goal();
      if (!goal) return null;
      if (blocked) return JSON.stringify({ error: blocked });
      try {
        const decision = scopeDecisionSchema.parse(await options.review({ goal, tool, args }));
        if (!decision.allowed) throw Error(`Outside the approved task scope: ${decision.reason}`);
        if (tool !== "scheduled_checkpoint" && ++sinceCheckpoint > 12)
          throw Error(
            "Stage checkpoint missing after 12 operations; review progress before resuming",
          );
        return null;
      } catch (error) {
        blocked = error instanceof Error ? error.message : "Task scope review failed";
        options.block(blocked);
        return JSON.stringify({ error: blocked });
      }
    };
    const next = tail.then(check);
    tail = next.catch(() => undefined);
    return next;
  });
  return {
    checkpoint: () => {
      sinceCheckpoint = 0;
    },
  };
}
