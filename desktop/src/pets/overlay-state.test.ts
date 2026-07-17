import { describe, expect, it } from "vitest";
import { derivePetTaskActivities, derivePetTaskStatus } from "./overlay-state";
import { EMPTY_PET_TAB_ACTIVITY, type PetTabActivity } from "./types";

function activity(patch: Partial<PetTabActivity>): PetTabActivity {
  return { ...EMPTY_PET_TAB_ACTIVITY, ...patch };
}

describe("pet overlay activity aggregation", () => {
  it("prioritizes input, blocked, ready, and running tasks like Codex", () => {
    const result = derivePetTaskActivities([
      {
        tabId: "running",
        title: "Running",
        active: true,
        busy: true,
        activity: activity({ busy: true, updatedAt: 40 }),
      },
      {
        tabId: "ready",
        title: "Ready",
        active: false,
        busy: false,
        activity: activity({ completionOutcome: "success", updatedAt: 30 }),
      },
      {
        tabId: "blocked",
        title: "Blocked",
        active: false,
        busy: false,
        activity: activity({ completionOutcome: "failure", updatedAt: 20 }),
      },
      {
        tabId: "waiting",
        title: "Waiting",
        active: false,
        busy: true,
        activity: activity({ pendingApprovals: ["confirm:1"], updatedAt: 10 }),
      },
    ]);

    expect(result.map((item) => item.tabId)).toEqual(["waiting", "blocked", "ready", "running"]);
  });

  it("stops advertising a completed task after the user opens its tab", () => {
    const completed = activity({ completionOutcome: "success" });
    expect(
      derivePetTaskStatus({
        tabId: "background",
        title: "Background",
        active: false,
        busy: false,
        activity: completed,
      }),
    ).toBe("ready");
    expect(
      derivePetTaskStatus({
        tabId: "background",
        title: "Background",
        active: true,
        busy: false,
        activity: completed,
      }),
    ).toBe("idle");
  });

  it("distinguishes tool work from model thinking", () => {
    expect(
      derivePetTaskStatus({
        tabId: "tool",
        title: "Tool",
        active: true,
        busy: true,
        activity: activity({ activeToolCalls: ["call-1"] }),
      }),
    ).toBe("working");
    expect(
      derivePetTaskStatus({
        tabId: "thinking",
        title: "Thinking",
        active: true,
        busy: true,
      }),
    ).toBe("thinking");
  });
});
