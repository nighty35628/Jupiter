import { describe, expect, it } from "vitest";
import {
  PromptPredictionState,
  predictionTurnSucceeded,
} from "../src/desktop/prompt-prediction-state.js";

const identity = {
  sessionId: "session",
  bindingId: 1,
  revision: 3,
  providerId: "custom",
  model: "model",
};

describe("prompt prediction lifecycle", { retry: 0 }, () => {
  it("requires a successful final response, not just a completion notification", () => {
    const normal = { done: true, failed: false, aborted: false, forced: false, text: "Finished." };
    expect(predictionTurnSucceeded(normal)).toBe(true);
    for (const patch of [
      { done: false },
      { failed: true },
      { aborted: true },
      { forced: true },
      { text: " " },
    ]) {
      expect(predictionTurnSucceeded({ ...normal, ...patch })).toBe(false);
    }
  });

  it("claims once before asynchronous work, including simultaneous clients", () => {
    const state = new PromptPredictionState();
    const id = state.offer(identity);
    expect(state.claim(id, identity)?.kind).toBe("start");
    expect(state.claim(id, identity)?.kind).toBe("pending");
    expect(state.finish(id, identity, "Run the tests.")).toBe(true);
    expect(state.claim(id, identity)).toMatchObject({ kind: "cached", text: "Run the tests." });
  });

  it("does not generate a historical suggestion on renderer resync", () => {
    const state = new PromptPredictionState();
    const id = state.offer(identity);
    expect(state.replay(identity)).toBeNull();
    state.claim(id, identity);
    state.finish(id, identity, "Ready suggestion");
    expect(state.replay(identity)).toBe(id);
  });

  it("does not retry null, cancellation or invalidated results", () => {
    const state = new PromptPredictionState();
    const id = state.offer(identity);
    const claim = state.claim(id, identity);
    expect(claim?.kind).toBe("start");
    state.finish(id, identity, null);
    expect(state.claim(id, identity)).toMatchObject({ kind: "cached", text: null });
    state.invalidate();
    expect(state.claim(id, identity)).toBeNull();
    expect(claim && "signal" in claim && claim.signal.aborted).toBe(true);
  });

  it("rejects old versions without admitting another attempt", () => {
    const state = new PromptPredictionState();
    const id = state.offer(identity);
    state.claim(id, identity);
    expect(state.finish(id, { ...identity, revision: 4 }, "Old")).toBe(false);
    expect(state.claim(id, identity)).toBeNull();
  });

  it("gives new completion identity after rollback and never revives an old one", () => {
    const state = new PromptPredictionState();
    const old = state.offer(identity);
    state.claim(old, identity);
    const next = state.offer(identity);
    expect(next).not.toBe(old);
    expect(state.finish(old, identity, "Old")).toBe(false);
    expect(state.claim(next, identity)?.kind).toBe("start");
  });
});
