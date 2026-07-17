import { describe, expect, it } from "vitest";
import {
  budgetTranscriptMessages,
  transcriptPayloadBytes,
} from "../src/desktop/transcript-budget.js";

describe("desktop transcript display budget", () => {
  it("bounds a tool-heavy transcript even when it has only a few UI messages", () => {
    const huge = "tool payload\n".repeat(2_000);
    const messages = [1, 2, 3].flatMap((turn) => [
      { kind: "user" as const, turn, text: `question ${turn}` },
      {
        kind: "assistant" as const,
        turn,
        pending: false,
        segments: Array.from({ length: 90 }, (_, i) => ({
          kind: "tool" as const,
          callId: `${turn}-${i}`,
          name: "read_file",
          args: huge,
          result: huge,
        })),
      },
    ]);

    const budgeted = budgetTranscriptMessages(messages);
    const assistants = budgeted.filter((message) => message.kind === "assistant");

    expect(budgeted).toHaveLength(messages.length);
    expect(assistants.some((message) => message.displayTruncated === true)).toBe(true);
    expect(
      assistants.some((message) => message.segments.some((segment) => segment.kind === "elision")),
    ).toBe(true);
    expect(transcriptPayloadBytes(budgeted)).toBeLessThanOrEqual(256 * 1024);
  });

  it("keeps pending and explicitly expanded turns intact", () => {
    const longText = "x".repeat(90_000);
    const messages = [
      {
        kind: "assistant" as const,
        turn: 1,
        pending: false,
        segments: [{ kind: "text" as const, text: longText }],
      },
      {
        kind: "assistant" as const,
        turn: 2,
        pending: true,
        segments: [{ kind: "reasoning" as const, text: longText }],
      },
    ];

    const budgeted = budgetTranscriptMessages(messages, { preserveTurns: new Set([1]) });

    expect(budgeted[0]).toEqual(messages[0]);
    expect(budgeted[1]).toEqual(messages[1]);
  });

  it("caps one oversized user field without deleting its turn", () => {
    const messages = [
      { kind: "user" as const, turn: 1, text: "问".repeat(100_000) },
      {
        kind: "assistant" as const,
        turn: 1,
        pending: false,
        segments: [{ kind: "text" as const, text: "answer" }],
      },
    ];

    const budgeted = budgetTranscriptMessages(messages);
    const user = budgeted[0];

    expect(user?.kind).toBe("user");
    expect(user && "text" in user ? user.text.length : 0).toBeLessThan(20_000);
    expect(user && "displayTruncated" in user).toBe(true);
    expect(budgeted).toHaveLength(2);
  });
});
