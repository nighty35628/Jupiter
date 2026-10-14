import { describe, expect, it, vi } from "vitest";
import { handleToolDrop, handleToolStart } from "../src/cli/ui/hooks/handle-stream-events.js";
import { type ToolEventContext, handleToolEvent } from "../src/cli/ui/hooks/handle-tool-event.js";
import type { Scrollback } from "../src/cli/ui/hooks/useScrollback.js";
import { TurnTranslator } from "../src/cli/ui/state/TurnTranslator.js";
import { DeepSeekClient } from "../src/client.js";
import { Eventizer } from "../src/core/eventize.js";
import { conversation, emptyConversation } from "../src/core/reducers.js";
import { dispatchToolCallsChunked } from "../src/loop/dispatch.js";
import { streamModelResponse } from "../src/loop/streaming.js";
import type { LoopEvent } from "../src/loop/types.js";
import { getToolCallIdentity } from "../src/loop/types.js";
import { ToolCallRepair } from "../src/repair/index.js";
import type { ToolCall } from "../src/types.js";

const ctx = { model: "test", prefixHash: "test", reasoningEffort: "high" } as const;
const event = (ev: Partial<LoopEvent>): LoopEvent => ({
  turn: 1,
  role: "status",
  content: "",
  ...ev,
});
const call = (id: string): ToolCall => ({
  id,
  type: "function",
  function: { name: "read", arguments: "{}" },
});

async function stream(requestId?: string, count = 1000) {
  const client = {
    async *stream() {
      yield {
        reasoningDelta: "think",
        contentDelta: "work",
        toolCallDeltas: [{ index: 0, name: "read", argumentsDelta: '{"q":"' }],
      };
      for (let i = 0; i < count; i++) yield { toolCallDeltas: [{ index: 0, argumentsDelta: "x" }] };
      yield { toolCallDeltas: [{ index: 0, id: "provider-late", argumentsDelta: '"}' }] };
    },
  } as unknown as DeepSeekClient;
  const gen = streamModelResponse({
    client,
    model: "test",
    messages: [],
    toolSpecs: [],
    signal: new AbortController().signal,
    thinkingEnabled: true,
    reasoningEffort: "high",
    turn: 1,
    requestId,
  });
  const events: LoopEvent[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

describe("stage 3 tool identity and progress", { retry: 0 }, () => {
  it("keeps displayed identity stable when provider id arrives late", async () => {
    const { events, result } = await stream("request-a", 2);
    const progress = events.filter((ev) => ev.role === "tool_call_delta");
    expect(progress[0]).toMatchObject({
      requestId: "request-a",
      localCallId: "request-a:tool:0",
      callId: "request-a:tool:0",
    });
    expect(new Set(progress.map((ev) => ev.callId))).toEqual(new Set(["request-a:tool:0"]));
    expect(progress.at(-1)?.providerCallId).toBe("provider-late");
    expect(result.toolCalls[0]?.id).toBe("provider-late");
    expect(JSON.stringify(result.toolCalls)).not.toContain("request-a");
  });

  it("coalesces argument progress and flushes exact numeric counters without partial JSON", async () => {
    const { events } = await stream("request-a");
    const progress = events.filter((ev) => ev.role === "tool_call_delta");
    expect(progress.length).toBeLessThan(30);
    expect(progress.at(-1)).toMatchObject({
      toolCallArgsChars: 1008,
      toolArgsChars: 1008,
      outputChars: 4,
      reasoningChars: 5,
      toolCallReadyCount: 1,
    });
    expect(
      progress.every((ev) => !ev.toolArgs && ev.content === "" && !("partialJSON" in ev)),
    ).toBe(true);
  });

  it("defaults to a fresh namespace for each model request in the same turn", async () => {
    const a = await stream(undefined, 1);
    const b = await stream(undefined, 1);
    const aId = a.events.find((ev) => ev.role === "tool_call_delta")?.callId;
    const bId = b.events.find((ev) => ev.role === "tool_call_delta")?.callId;
    expect(aId).toBeTruthy();
    expect(bId).not.toBe(aId);
  });

  it("uses explicit ids for synthetic reverse results, not FIFO ownership", () => {
    const e = new Eventizer();
    for (const id of ["a", "b"])
      e.consume(event({ role: "tool_start", toolName: "read", callId: id }), ctx);
    const b = e.consume(event({ role: "tool", toolName: "read", callId: "b", content: "B" }), ctx);
    const a = e.consume(event({ role: "tool", toolName: "read", callId: "a", content: "A" }), ctx);
    expect(b.at(-1)).toMatchObject({ type: "tool.result", callId: "b", output: "B" });
    expect(a.at(-1)).toMatchObject({ type: "tool.result", callId: "a", output: "A" });
  });

  it("does not dedupe index zero across two requests in one turn", () => {
    const e = new Eventizer();
    for (const requestId of ["one", "two"]) {
      const out = e.consume(
        event({
          role: "tool_call_delta",
          toolName: "read",
          toolCallIndex: 0,
          requestId,
          localCallId: `${requestId}:tool:0`,
        }),
        ctx,
      );
      expect(
        out.some((ev) => ev.type === "tool.preparing" && ev.callId === `${requestId}:tool:0`),
      ).toBe(true);
    }
  });

  it("never claims a preparing card belonging to a different explicit call", () => {
    const e = new Eventizer();
    e.consume(
      event({ role: "tool_call_delta", toolName: "read", toolCallIndex: 0, callId: "dropped" }),
      ctx,
    );
    const start = e.consume(event({ role: "tool_start", toolName: "read", callId: "actual" }), ctx);
    expect(start.at(-1)).toMatchObject({ type: "tool.dispatched", callId: "actual" });
  });

  it("terminates dropped preparing calls and ignores late progress/start", () => {
    const e = new Eventizer();
    const preparing = event({
      role: "tool_call_delta",
      callId: "drop",
      toolName: "read",
      toolCallIndex: 0,
    });
    e.consume(preparing, ctx);
    const dropped = e.consume(
      event({ role: "tool_call_drop", callId: "drop", content: "storm" }),
      ctx,
    );
    expect(dropped.at(-1)).toMatchObject({
      type: "tool.result",
      callId: "drop",
      ok: false,
      terminalState: "dropped",
      executed: false,
    });
    expect(e.consume(preparing, ctx)).toEqual([]);
    expect(e.consume(event({ role: "tool_start", callId: "drop", toolName: "read" }), ctx)).toEqual(
      [],
    );
  });

  it("does not downgrade a completed tool on late progress", () => {
    const e = new Eventizer();
    e.consume(event({ role: "tool_start", callId: "done", toolName: "read" }), ctx);
    e.consume(event({ role: "tool", callId: "done", toolName: "read", content: "ok" }), ctx);
    expect(
      e.consume(
        event({ role: "tool_call_delta", callId: "done", toolName: "read", toolCallIndex: 0 }),
        ctx,
      ),
    ).toEqual([]);
  });

  it("reports suppressed original calls for terminal delivery after repair", () => {
    const repair = new ToolCallRepair({ allowedToolNames: new Set(["read"]), stormThreshold: 2 });
    repair.process([call("one")], null);
    const dropped = call("two");
    const result = repair.process([dropped], null);
    expect(result.calls).toEqual([]);
    expect(result.droppedCalls).toEqual([{ call: dropped, reason: expect.any(String) }]);
  });

  it("keeps dispatcher results in input order even when completion order is reversed", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: LoopEvent[] = [];
    const complete: string[] = [];
    for await (const ev of dispatchToolCallsChunked([call("a"), call("b")], {
      turn: 1,
      signal: new AbortController().signal,
      isParallelSafe: () => true,
      inflightIdFor: (c) => c.id!,
      inflightAdd: () => {},
      inflightDelete: () => {},
      appendAndPersist: () => {},
      rateLimitState: { shown: false },
      runOne: async (c) => {
        if (c.id === "a") await barrier;
        else release();
        complete.push(c.id!);
        return { result: c.id!, preWarnings: [], postWarnings: [] };
      },
    }))
      events.push(ev);
    expect(complete).toEqual(["b", "a"]);
    expect(events.filter((ev) => ev.role === "tool").map((ev) => ev.callId)).toEqual(["a", "b"]);
  });

  it("does not dispatch queued calls after cancellation and terminates their preparations", async () => {
    const controller = new AbortController();
    const runOne = vi.fn(async () => {
      controller.abort();
      return { result: "first completed", preWarnings: [], postWarnings: [] };
    });
    const events: LoopEvent[] = [];
    for await (const ev of dispatchToolCallsChunked([call("first"), call("queued")], {
      turn: 1,
      signal: controller.signal,
      isParallelSafe: () => false,
      inflightIdFor: (c) => c.id!,
      inflightAdd: () => {},
      inflightDelete: () => {},
      appendAndPersist: () => {},
      rateLimitState: { shown: false },
      runOne,
    }))
      events.push(ev);
    expect(runOne).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      role: "tool_call_drop",
      providerCallId: "queued",
      terminalState: "cancelled",
    });
  });

  it("CLI ends tools by supplied ID and aborts every remaining card", () => {
    const log = {
      startTool: vi.fn((_name, _args, id) => id),
      endTool: vi.fn(),
      abortTurn: vi.fn(),
    } as unknown as Scrollback;
    const translator = new TurnTranslator(log);
    translator.toolStart("read", {}, "a");
    translator.toolStart("read", {}, "b");
    translator.toolEnd("A", "a");
    expect(log.endTool).toHaveBeenCalledWith("a", expect.objectContaining({ output: "A" }));
    translator.toolEnd("stray", "unknown");
    translator.abort();
    expect(log.endTool).toHaveBeenCalledWith("b", expect.objectContaining({ aborted: true }));
    expect(log.endTool).toHaveBeenCalledTimes(2);
  });

  it("CLI adapter forwards local identity and does not clear another active tool", () => {
    const log = {
      startTool: vi.fn((_name, _args, id) => id),
      endTool: vi.fn(),
    } as unknown as Scrollback;
    const translator = new TurnTranslator(log);
    const setOngoingTool = vi.fn();
    const setToolProgress = vi.fn();
    const toolStartedAtRef = { current: null as number | null };
    const startCtx = {
      translator,
      setOngoingTool,
      setToolProgress,
      toolStartedAtRef,
      codeModeOn: false,
      recordRecentFile: vi.fn(),
    };
    handleToolStart(
      event({ role: "tool_start", toolName: "read", callId: "provider-a", localCallId: "a" }),
      startCtx,
    );
    handleToolStart(event({ role: "tool_start", toolName: "read", localCallId: "b" }), startCtx);
    const before = setOngoingTool.mock.calls.length;
    handleToolEvent(event({ role: "tool", content: "A", callId: "provider-a", localCallId: "a" }), {
      ...startCtx,
      flush: vi.fn(),
      log,
    } as unknown as ToolEventContext);
    expect(log.endTool).toHaveBeenCalledWith("a", expect.objectContaining({ output: "A" }));
    expect(setOngoingTool.mock.calls.length).toBe(before);
  });

  it("CLI global tool abort closes all active IDs and late starts cannot reopen terminal cards", () => {
    const log = {
      startTool: vi.fn((_name, _args, id) => id),
      endTool: vi.fn(),
    } as unknown as Scrollback;
    const translator = new TurnTranslator(log);
    translator.toolStart("read", {}, "a");
    translator.toolStart("read", {}, "b");
    translator.toolAbort("cancelled");
    expect(log.endTool).toHaveBeenCalledTimes(2);
    translator.toolStart("read", {}, "a");
    expect(log.startTool).toHaveBeenCalledTimes(2);
  });

  it("kernel cancellation keeps request/provider identity on each card", () => {
    const e = new Eventizer();
    e.consume(
      event({
        role: "tool_call_delta",
        toolName: "read",
        toolCallIndex: 0,
        localCallId: "local",
        requestId: "request",
        providerCallId: "provider",
        toolCallArgsChars: 42,
      }),
      ctx,
    );
    const out = e.consume(event({ role: "error", content: "abort" }), ctx);
    expect(out.find((ev) => ev.type === "tool.result")).toMatchObject({
      callId: "local",
      requestId: "request",
      providerCallId: "provider",
      terminalState: "cancelled",
      executed: false,
    });
  });

  it("does not invent a conversation tool result for an unexecuted dropped card", () => {
    const e = new Eventizer();
    e.consume(
      event({ role: "tool_call_delta", toolName: "read", toolCallIndex: 0, callId: "local" }),
      ctx,
    );
    const terminal = e
      .consume(event({ role: "tool_call_drop", callId: "local", content: "storm" }), ctx)
      .at(-1)!;
    expect(conversation(emptyConversation(), terminal).messages).toEqual([]);
  });

  it("preserves declared identity through repair and assigns unique scavenged identity", async () => {
    const { result } = await stream("repair-request", 1);
    const before = getToolCallIdentity(result.toolCalls[0]!);
    const repair = new ToolCallRepair({ allowedToolNames: new Set(["read"]) });
    const repaired = repair.process(
      result.toolCalls,
      null,
      '{"name":"read","arguments":{"q":"other"}}',
      result.requestId,
    );
    expect(getToolCallIdentity(repaired.calls[0]!)).toEqual(before);
    expect(getToolCallIdentity(repaired.calls[1]!)).toMatchObject({
      requestId: "repair-request",
      localCallId: "repair-request:tool:1",
    });
    expect(JSON.stringify(repaired.calls)).not.toContain("repair-request");
  });

  it("CLI drops an unstarted call and ignores a late tool_start without touching another card", () => {
    const log = {
      startTool: vi.fn((_name, _args, id) => id),
      endTool: vi.fn(),
    } as unknown as Scrollback;
    const translator = new TurnTranslator(log);
    const startCtx = {
      translator,
      setOngoingTool: vi.fn(),
      setToolProgress: vi.fn(),
      toolStartedAtRef: { current: null as number | null },
      codeModeOn: false,
      recordRecentFile: vi.fn(),
    };
    handleToolStart(
      event({ role: "tool_start", toolName: "read", localCallId: "running" }),
      startCtx,
    );
    handleToolDrop(
      event({ role: "tool_call_drop", content: "guard", localCallId: "drop" }),
      startCtx,
    );
    const before = startCtx.setOngoingTool.mock.calls.length;
    handleToolStart(event({ role: "tool_start", toolName: "read", localCallId: "drop" }), startCtx);
    expect(log.startTool).toHaveBeenCalledTimes(1);
    expect(startCtx.setOngoingTool.mock.calls.length).toBe(before);
    expect(translator.isActiveTool("running")).toBe(true);
  });

  it("stream to dispatch retains stable local ID and keeps provider ID only in protocol messages", async () => {
    const { events: progress, result } = await stream("dispatch-request", 1);
    const events: LoopEvent[] = [];
    const persisted: unknown[] = [];
    for await (const ev of dispatchToolCallsChunked(result.toolCalls, {
      turn: 1,
      signal: new AbortController().signal,
      isParallelSafe: () => false,
      inflightIdFor: (c) => getToolCallIdentity(c)!.localCallId,
      inflightAdd: () => {},
      inflightDelete: () => {},
      appendAndPersist: (m) => persisted.push(m),
      rateLimitState: { shown: false },
      runOne: async () => ({ result: "ok", preWarnings: [], postWarnings: [] }),
    }))
      events.push(ev);
    expect(events.map((ev) => ev.callId)).toEqual([
      progress.find((ev) => ev.role === "tool_call_delta")?.callId,
      "dispatch-request:tool:0",
    ]);
    expect(events.every((ev) => ev.providerCallId === "provider-late")).toBe(true);
    expect(persisted).toEqual([
      { role: "tool", tool_call_id: "provider-late", name: "read", content: "ok" },
    ]);
  });

  it("legacy same-name ambiguous results are not claimed by FIFO", () => {
    const e = new Eventizer();
    e.consume(event({ role: "tool_start", toolName: "read", callId: "a" }), ctx);
    e.consume(event({ role: "tool_start", toolName: "read", callId: "b" }), ctx);
    const out = e.consume(event({ role: "tool", toolName: "read", content: "unknown" }), ctx);
    const terminal = out.find((ev) => ev.type === "tool.result");
    expect(terminal?.callId).not.toBe("a");
    expect(terminal?.callId).not.toBe("b");
  });

  it("legacy same-turn iterations get fresh index identities after assistant_final", () => {
    const e = new Eventizer();
    const delta = event({ role: "tool_call_delta", toolName: "read", toolCallIndex: 0 });
    const first = e.consume(delta, ctx).find((ev) => ev.type === "tool.preparing");
    e.consume(event({ role: "assistant_final", content: "" }), ctx);
    const second = e.consume(delta, ctx).find((ev) => ev.type === "tool.preparing");
    expect(second).toBeDefined();
    expect(first?.callId).not.toBe(second?.callId);
  });

  it("forwards activeImageIds as host options but excludes host identity and gate from provider JSON", async () => {
    const { result } = await stream("host-only-call", 1);
    let body: Record<string, unknown> | undefined;
    const client = new DeepSeekClient({
      apiKey: "unit-test-only",
      baseUrl: "https://gateway.example/v1",
      retry: { maxAttempts: 1 },
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    const spy = vi.spyOn(client, "stream");
    const activeImageIds = ["host-only-image"];
    const gen = streamModelResponse({
      client,
      model: "test",
      messages: [{ role: "assistant", content: "", tool_calls: result.toolCalls }],
      toolSpecs: [],
      signal: new AbortController().signal,
      thinkingEnabled: false,
      reasoningEffort: "high",
      turn: 1,
      requestId: "host-only-request",
      activeImageIds,
    });
    while (!(await gen.next()).done) {}
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ activeImageIds }));
    expect(body).toBeDefined();
    expect(JSON.stringify(body)).not.toMatch(/host-only|activeImageIds|localCallId|requestId/);
    expect(JSON.stringify(body)).toContain("provider-late");
  });

  it("throttles at 50ms and flushes pending counters before a stream error", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const client = {
        async *stream() {
          yield { toolCallDeltas: [{ index: 0, name: "read", argumentsDelta: '{"q":"' }] };
          now = 49;
          yield { toolCallDeltas: [{ index: 0, argumentsDelta: "x" }] };
          now = 50;
          yield { toolCallDeltas: [{ index: 0, argumentsDelta: "x" }] };
          now = 51;
          yield { toolCallDeltas: [{ index: 0, argumentsDelta: "x" }] };
          throw new Error("mock stream interrupted");
        },
      } as unknown as DeepSeekClient;
      const gen = streamModelResponse({
        client,
        model: "test",
        messages: [],
        toolSpecs: [],
        signal: new AbortController().signal,
        thinkingEnabled: false,
        reasoningEffort: "high",
        turn: 1,
      });
      const events: LoopEvent[] = [];
      await expect(
        (async () => {
          for await (const ev of gen) events.push(ev);
        })(),
      ).rejects.toThrow("mock stream interrupted");
      const progress = events.filter((ev) => ev.role === "tool_call_delta");
      expect(progress.map((ev) => ev.toolCallArgsChars)).toEqual([6, 8, 9]);
      expect(progress.map((ev) => ev.toolArgsChars)).toEqual([6, 8, 9]);
      expect(events.at(-1)).toMatchObject({ role: "tool_call_drop", terminalState: "dropped" });
    } finally {
      clock.mockRestore();
    }
  });
});
