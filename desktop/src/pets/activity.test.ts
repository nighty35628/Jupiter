import { describe, expect, it } from "vitest";
import type { IncomingEvent, OutgoingCommand } from "../protocol";
import {
  derivePetBaseActivity,
  petIncomingAffectsActivity,
  petOutgoingWaitsForDelivery,
  reducePetIncoming,
  reducePetOutgoing,
} from "./activity";

const outgoing = (command: OutgoingCommand): OutgoingCommand => command;
const incoming = (event: IncomingEvent): IncomingEvent => event;

describe("pet activity reducer", () => {
  it("uses approval, tool, thinking, and terminal outcome precedence", () => {
    let state = reducePetOutgoing(undefined, outgoing({ cmd: "user_input", text: "hello" }));
    expect(derivePetBaseActivity(state)).toBe("thinking");

    state = reducePetIncoming(
      state,
      incoming({
        type: "tool.preparing",
        id: 1,
        ts: "now",
        turn: 1,
        callId: "call-1",
        name: "read_file",
      }),
    );
    expect(derivePetBaseActivity(state)).toBe("working");

    state = reducePetIncoming(
      state,
      incoming({
        type: "$confirm_required",
        id: 7,
        kind: "run_command",
        command: "npm test",
      }),
    );
    expect(derivePetBaseActivity(state)).toBe("waiting");

    state = reducePetOutgoing(
      state,
      outgoing({ cmd: "confirm_response", id: 7, response: { type: "run_once" } }),
    );
    expect(derivePetBaseActivity(state)).toBe("working");

    state = reducePetIncoming(
      state,
      incoming({
        type: "tool.result",
        id: 2,
        ts: "now",
        turn: 1,
        callId: "call-1",
        ok: false,
        output: "failed",
      }),
    );
    state = reducePetIncoming(
      state,
      incoming({ type: "error", id: 3, ts: "now", turn: 1, message: "hard", recoverable: false }),
    );
    state = reducePetIncoming(state, incoming({ type: "$turn_complete" }));
    expect(state.completionSequence).toBe(1);
    expect(state.completionOutcome).toBe("failure");
    expect(derivePetBaseActivity(state)).toBe("idle");
  });

  it("does not celebrate aborted turns or fail on recoverable errors", () => {
    let state = reducePetOutgoing(undefined, outgoing({ cmd: "user_input", text: "hello" }));
    state = reducePetIncoming(
      state,
      incoming({
        type: "error",
        id: 1,
        ts: "now",
        turn: 1,
        message: "recovered",
        recoverable: true,
      }),
    );
    state = reducePetOutgoing(state, outgoing({ cmd: "abort" }));
    state = reducePetIncoming(state, incoming({ type: "$turn_complete" }));
    expect(state.completionOutcome).toBeNull();
  });

  it("waits for delivery before showing new work but preserves abort ordering", () => {
    expect(petOutgoingWaitsForDelivery(outgoing({ cmd: "user_input", text: "hello" }))).toBe(true);
    expect(petOutgoingWaitsForDelivery(outgoing({ cmd: "abort" }))).toBe(false);
  });

  it("ignores high-frequency stream deltas before scheduling pet state", () => {
    expect(
      petIncomingAffectsActivity(
        incoming({
          type: "model.delta",
          id: 1,
          ts: "now",
          turn: 1,
          channel: "content",
          text: "token",
        }),
      ),
    ).toBe(false);
    expect(
      petIncomingAffectsActivity(
        incoming({
          type: "tool.preparing",
          id: 2,
          ts: "now",
          turn: 1,
          callId: "call-1",
          name: "read_file",
        }),
      ),
    ).toBe(true);
  });

  it("keeps object identity for duplicate turn and tool start events", () => {
    const thinking = reducePetOutgoing(undefined, outgoing({ cmd: "user_input", text: "hello" }));
    const duplicateTurn = reducePetIncoming(
      thinking,
      incoming({
        type: "model.turn.started",
        id: 1,
        ts: "now",
        turn: 1,
        model: "deepseek-chat",
        reasoningEffort: "medium",
        prefixHash: "prefix",
      }),
    );
    expect(duplicateTurn).toBe(thinking);

    const working = reducePetIncoming(
      thinking,
      incoming({
        type: "tool.preparing",
        id: 2,
        ts: "now",
        turn: 1,
        callId: "call-1",
        name: "read_file",
      }),
    );
    const duplicateTool = reducePetIncoming(
      working,
      incoming({
        type: "tool.intent",
        id: 3,
        ts: "now",
        turn: 1,
        callId: "call-1",
        name: "read_file",
        args: "{}",
      }),
    );
    expect(duplicateTool).toBe(working);
  });

  it("keeps the runtime busy fallback after activity tracking starts mid-turn", () => {
    const noOpResult = reducePetIncoming(
      undefined,
      incoming({
        type: "tool.result",
        id: 4,
        ts: "now",
        turn: 1,
        callId: "started-before-pets-were-enabled",
        ok: true,
        output: "done",
      }),
    );

    expect(derivePetBaseActivity(noOpResult, true)).toBe("thinking");

    const waiting = reducePetIncoming(
      noOpResult,
      incoming({ type: "$confirm_required", id: 5, kind: "run_command", command: "npm test" }),
    );
    expect(derivePetBaseActivity(waiting, true)).toBe("waiting");

    const resumed = reducePetOutgoing(
      waiting,
      outgoing({ cmd: "confirm_response", id: 5, response: { type: "run_once" } }),
    );
    expect(derivePetBaseActivity(resumed, true)).toBe("thinking");
  });

  it("keeps the original tab busy when new chat opens in another tab", () => {
    const working = reducePetOutgoing(undefined, outgoing({ cmd: "skill_run", name: "test" }));
    const next = reducePetOutgoing(
      working,
      outgoing({ cmd: "new_chat", workspaceDir: "/tmp/project", openInNewTab: true }),
    );

    expect(next).toBe(working);
    expect(derivePetBaseActivity(next)).toBe("working");
  });

  it("marks same-tab session changes without resetting tabs opened in the background", () => {
    const working = reducePetOutgoing(undefined, outgoing({ cmd: "skill_run", name: "test" }));
    const reset = reducePetOutgoing(
      working,
      outgoing({ cmd: "session_load", name: "next-session", openInNewTab: false }),
    );
    expect(reset.resetSequence).toBe(working.resetSequence + 1);
    expect(derivePetBaseActivity(reset)).toBe("idle");

    const background = reducePetOutgoing(
      working,
      outgoing({ cmd: "session_load", name: "next-session", openInNewTab: true }),
    );
    expect(background).toBe(working);
  });
});
