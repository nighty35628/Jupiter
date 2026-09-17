import { describe, expect, it } from "vitest";
import {
  createTranscriptProjector,
  elideTranscriptMessages,
  retainRecentTranscript,
} from "./transcript-elision";

describe("transcript projection", () => {
  it("reuses budgeted historical rows while the live tail grows", () => {
    const project = createTranscriptProjector();
    const old = {
      kind: "assistant",
      turn: 1,
      segments: [{ kind: "text", text: "x".repeat(300_000) }],
    };
    const first = project([old, { kind: "assistant", turn: 2 }]);
    const second = project([old, { kind: "assistant", turn: 2 }]);
    expect(second[0]).toBe(first[0]);
  });
  it("bounds old replayable payloads without evicting the latest turn", () => {
    const messages = [1, 2, 3, 4].map((turn) => ({
      kind: "assistant",
      turn,
      segments: [{ kind: "text", text: "x".repeat(1_000_000) }],
    }));
    const retained = retainRecentTranscript(messages, new Set());
    expect(JSON.stringify(retained).length).toBeLessThan(2_100_000);
    expect(retained[3]).toBe(messages[3]);
  });
  it("does not collapse the current row when a long stream finishes", () => {
    const message = {
      kind: "assistant",
      turn: 1,
      pending: false,
      segments: [{ kind: "text", text: "x".repeat(300_000) }],
    };
    expect(elideTranscriptMessages([message])[0]).toBe(message);
  });
  it("can expand older content without a destructive display projection", () => {
    const message = {
      kind: "assistant",
      turn: 1,
      pending: false,
      segments: [{ kind: "text", text: "x".repeat(300_000) }],
    };
    const input = [message, { ...message, turn: 2 }];
    const preview = elideTranscriptMessages(input);
    expect(preview[0]).not.toBe(message);
    expect(input[0].segments[0].text).toHaveLength(300_000);
    expect(elideTranscriptMessages(input, new Set([1]))[0]).toBe(message);
    expect(elideTranscriptMessages(input)).toEqual(preview);
  });
});
