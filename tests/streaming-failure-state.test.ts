import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient, type StreamChunk } from "../src/client.js";
import * as streaming from "../src/loop/streaming.js";
import type { LoopEvent } from "../src/loop/types.js";

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

async function failure(client: DeepSeekClient, signal = new AbortController().signal) {
  const events: LoopEvent[] = [];
  let error: unknown;
  try {
    for await (const event of streaming.streamModelResponse({
      client,
      model: "synthetic-model",
      messages: [{ role: "user", content: "test" }],
      toolSpecs: [],
      signal,
      thinkingEnabled: true,
      reasoningEffort: "high",
      disableRetry: true,
      requestId: "request-test",
      turn: 1,
    }))
      events.push(event);
  } catch (value) {
    error = value;
  }
  expect(error).toBeDefined();
  return { error, events };
}

describe("failed stream attempt observability", { retry: 0 }, () => {
  it.each([
    ["content", { content: "partial" }, true, false, false, 7, 0, 0],
    ["reasoning", { reasoning_content: "think" }, false, true, false, 0, 5, 0],
    [
      "tool args",
      { tool_calls: [{ index: 0, function: { arguments: "{" } }] },
      false,
      false,
      true,
      0,
      0,
      1,
    ],
    ["tool id only", { tool_calls: [{ index: 0, id: "call-test" }] }, false, false, true, 0, 0, 0],
    [
      "tool name only",
      { tool_calls: [{ index: 0, function: { name: "read" } }] },
      false,
      false,
      true,
      0,
      0,
      0,
    ],
    ["no output", {}, false, false, false, 0, 0, 0],
  ])(
    "retains %s before a provider error in the same network block",
    async (
      _label,
      delta,
      sawContent,
      sawReasoning,
      sawToolDelta,
      outputChars,
      reasoningChars,
      toolArgsChars,
    ) => {
      const fetch = vi.fn(
        async () =>
          new Response(
            frame({ choices: [{ delta }] }) + frame({ error: { code: "context_length_exceeded" } }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      );
      const { error, events } = await failure(
        new DeepSeekClient({
          apiKey: "synthetic-key",
          baseUrl: "https://synthetic.invalid/v1",
          fetch,
          retry: { maxAttempts: 1 },
        }),
      );
      expect(streaming.getStreamFailureState(error)).toEqual({
        requestId: "request-test",
        sawContent,
        sawReasoning,
        sawToolDelta,
        outputChars,
        reasoningChars,
        toolArgsChars,
      });
      if (sawContent) expect(events.some((event) => event.content === "partial")).toBe(true);
      if (sawReasoning) expect(events.some((event) => event.reasoningDelta === "think")).toBe(true);
      if (sawToolDelta)
        expect(events.filter((event) => event.role === "tool_call_drop")).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves frozen error identity, status, name and abort code without storing output", async () => {
    const error = Object.freeze(
      Object.assign(new Error("cancelled"), {
        name: "AbortError",
        status: 499,
        code: "ABORT_ERR",
      }),
    );
    const client = new DeepSeekClient({ apiKey: "synthetic" });
    vi.spyOn(client, "stream").mockImplementation(async function* () {
      yield { contentDelta: "private-output", reasoningDelta: "private-reasoning", raw: {} };
      throw error;
    });
    expect((await failure(client)).error).toBe(error);
    const state = streaming.getStreamFailureState(error);
    expect(state).toMatchObject({ sawContent: true, sawReasoning: true, sawToolDelta: false });
    expect(JSON.stringify(state)).not.toMatch(/private-output|private-reasoning/);
    expect(Object.isFrozen(state)).toBe(true);
    expect(error).toMatchObject({ name: "AbortError", status: 499, code: "ABORT_ERR" });
  });

  it("does not carry flags over from an earlier attempt using the same error", async () => {
    const error = new Error("network failed");
    const client = new DeepSeekClient({ apiKey: "synthetic" });
    let chunks: StreamChunk[] = [{ reasoningDelta: "think", raw: {} }];
    vi.spyOn(client, "stream").mockImplementation(async function* () {
      yield* chunks;
      throw error;
    });
    await failure(client);
    expect(streaming.getStreamFailureState(error)?.sawReasoning).toBe(true);
    chunks = [];
    await failure(client);
    expect(streaming.getStreamFailureState(error)).toMatchObject({
      sawContent: false,
      sawReasoning: false,
      sawToolDelta: false,
    });
    expect(streaming.getStreamFailureState(new Error("unrelated"))).toBeUndefined();
    expect(streaming.getStreamFailureState(null)).toBeUndefined();
  });

  it("retains flags and the abort reason when cancelled after the last chunk", async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const client = new DeepSeekClient({ apiKey: "synthetic" });
    vi.spyOn(client, "stream").mockImplementation(async function* () {
      yield { toolCallDeltas: [{ index: 0, id: "call-test" }], raw: {} };
      controller.abort(reason);
    });
    const { error, events } = await failure(client, controller.signal);
    expect(error).toBe(reason);
    expect(streaming.getStreamFailureState(error)).toMatchObject({
      sawContent: false,
      sawReasoning: false,
      sawToolDelta: true,
      toolArgsChars: 0,
    });
    expect(events.find((event) => event.role === "tool_call_drop")?.terminalState).toBe(
      "cancelled",
    );
  });
});
