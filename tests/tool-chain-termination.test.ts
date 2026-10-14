import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { Eventizer } from "../src/core/eventize.js";
import type { Event } from "../src/core/events.js";
import { predictionTurnSucceeded } from "../src/desktop/prompt-prediction-state.js";
import { DesktopTurnAdmission } from "../src/desktop/turn-admission.js";
import { CacheFirstLoop } from "../src/loop.js";
import { dispatchToolCallsChunked } from "../src/loop/dispatch.js";
import type { DispatchContext } from "../src/loop/dispatch.js";
import type { LoopEvent } from "../src/loop/types.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { generateSessionTitle, shouldAutoNameSession } from "../src/session-title.js";
import type { ToolCall } from "../src/types.js";

const ctx = { model: "mock", prefixHash: "mock", reasoningEffort: "high" } as const;
const ev = (partial: Partial<LoopEvent>): LoopEvent => ({
  turn: 1,
  role: "status",
  content: "",
  ...partial,
});
const call: ToolCall = {
  id: "provider-1",
  type: "function",
  function: { name: "missing_tool", arguments: "{}" },
};

function makeLoop() {
  return new CacheFirstLoop({
    client: new DeepSeekClient({
      apiKey: "unit-test-only",
      baseUrl: "https://gateway.example/v1",
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
      ),
    }),
    prefix: new ImmutablePrefix({ system: "test" }),
    stream: false,
  });
}

function makeStreamingLoop(session: string) {
  let request = 0;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (request++ === 0) {
      const signal = init?.signal;
      let onAbort: (() => void) | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"provider-stream","function":{"name":"read","arguments":"{"}}]}}]}\n\n',
            ),
          );
          onAbort = () => controller.error(new DOMException("mock fetch aborted", "AbortError"));
          signal?.addEventListener("abort", onAbort, { once: true });
        },
        cancel() {
          if (onAbort) signal?.removeEventListener("abort", onAbort);
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(
      'data: {"choices":[{"delta":{"content":"next turn reached provider"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const loop = new CacheFirstLoop({
    client: new DeepSeekClient({
      apiKey: "unit-test-only",
      baseUrl: "https://gateway.example/v1",
      fetch: fetcher,
      retry: { maxAttempts: 1 },
    }),
    prefix: new ImmutablePrefix({ system: "test" }),
    stream: true,
    session,
  });
  return { loop, fetcher };
}

function dispatchContext(
  inflight: { add(id: string): unknown; delete(id: string): unknown },
  runOne: DispatchContext["runOne"],
): DispatchContext {
  return {
    turn: 1,
    signal: new AbortController().signal,
    isParallelSafe: () => true,
    inflightIdFor: (c) => c.id!,
    inflightAdd: (id) => {
      inflight.add(id);
    },
    inflightDelete: (id: string) => {
      inflight.delete(id);
    },
    runOne,
    appendAndPersist: () => {},
    rateLimitState: { shown: false },
  };
}

// Execute the real nested host function without importing desktop startup side effects.
function desktopRunTurn(dependencies: Record<string, unknown>) {
  const bindings = { predictionTurnSucceeded, offerPrediction: () => {}, ...dependencies };
  const source = ts.createSourceFile(
    "desktop.ts",
    readFileSync("src/cli/commands/desktop.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      ["runTurn", "scheduleGeneratedSessionTitle", "commitGeneratedDesktopSessionTitle"].includes(
        node.name.text,
      )
    )
      declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (declarations.length !== 3) throw new Error("desktop host/title functions not found");
  const compiled = ts.transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function("exports", ...Object.keys(bindings), `${compiled}\nreturn runTurn;`)(
    {},
    ...Object.values(bindings),
  );
}

async function runHost(
  mode: "stop" | "throw" | "done" | "session" | "binding" | "runtime" | "generation" | "switching",
  actualLoop?: CacheFirstLoop,
  stopAt: "delta" | "drop" = "delta",
) {
  const eventizer = new Eventizer();
  const admission = new DesktopTurnAdmission();
  const tab = {
    id: "tab",
    runtime: undefined as unknown,
    currentSession: actualLoop?.sessionName ?? (null as string | null),
    sessionId: "host-session",
    bindingId: 1,
    currentModel: "mock",
    rootDir: "/mock",
    hooks: [],
    turnAdmission: admission,
    aborter: null as AbortController | null,
    switching: false,
    planTotalSteps: 0,
  };
  let returned = false;
  const loop = actualLoop ?? {
    client: { supportsImages: () => false },
    async *step() {
      try {
        yield ev({
          role: "tool_start",
          localCallId: "running",
          requestId: "request",
          providerCallId: "provider-running",
          toolName: "read",
          toolArgs: "{}",
        });
        yield ev({
          role: "tool_call_delta",
          localCallId: "preparing",
          requestId: "request",
          providerCallId: "provider-preparing",
          toolName: "read",
          toolCallIndex: 1,
        });
        if (mode === "throw") throw new Error("mock host stream failure");
        yield ev({
          role: "tool",
          localCallId: "running",
          requestId: "request",
          toolName: "read",
          content: "ok",
        });
        yield ev({ role: "done" });
      } finally {
        returned = true;
      }
    },
  };
  tab.runtime = { loop, eventizer, ctx };
  const emitted: Array<Event | { type: string }> = [];
  const emit = (event: Event | { type: string }) => {
    emitted.push(event);
    if (actualLoop && event.type === "tool.preparing") actualLoop.abort();
    const stopType = actualLoop && stopAt === "drop" ? "tool.result" : "tool.preparing";
    if (event.type !== stopType || mode === "done" || mode === "throw") return;
    tab.aborter?.abort();
    if (mode === "session") tab.sessionId = "replacement-session";
    if (mode === "binding") tab.bindingId += 1;
    if (mode === "runtime") tab.runtime = {};
    if (mode === "generation") admission.invalidate();
    if (mode === "switching") tab.switching = true;
  };
  const runTurn = desktopRunTurn({
    startComputerUse: async () => {},
    acceptedClientTurn: () => undefined,
    attachments: { resolveAll: async () => [] },
    prepareHelpContext: () => ({}),
    desktopHelpContext: () => ({}),
    tabContext: { run: async (_id: string, fn: () => Promise<void>) => fn() },
    emit,
    emitCtxBreakdown: () => {},
    emitSessions: () => {},
    emitBalance: async () => {},
    mergeLoadedSessionFiles: () => [],
    sessionFilesFromTool: () => [],
    loadSessionMeta: () => ({}),
    patchSessionMeta: () => {},
    emitTurnCommitted: () => {},
    tabs: new Map([[tab.id, tab]]),
  });
  await runTurn(tab, "go");
  return { emitted, returned, admission, eventizer };
}

function titleHost() {
  const admission = new DesktopTurnAdmission();
  const eventizer = new Eventizer();
  const finishTurn = vi.spyOn(eventizer, "finishTurn");
  const tab = {
    id: "title-tab",
    runtime: undefined as unknown,
    currentSession: "desktop-20261008120000-1",
    sessionId: "stable-session",
    bindingId: 1,
    currentModel: "mock",
    rootDir: "/mock",
    hooks: [] as Array<{ event: string }>,
    turnAdmission: admission,
    aborter: null as AbortController | null,
    switching: false,
    planTotalSteps: 0,
  };
  const phases = {
    attachments: () => {},
    submit: () => {},
    loop: () => {},
    stop: async () => {},
  };
  let turn = 0;
  const loop = {
    client: { supportsImages: () => false, chat: vi.fn() },
    model: "mock",
    rebindSession: vi.fn(),
    stats: { summary: () => ({ turns: turn }) },
    step: vi.fn(async function* (_text: string, opts: { onUserPersisted: (n: number) => void }) {
      const currentTurn = ++turn;
      opts.onUserPersisted(currentTurn);
      yield ev({
        turn: currentTurn,
        role: "tool_call_delta",
        localCallId: `pending-${turn}`,
        toolName: "read",
      });
      phases.loop();
      yield ev({ turn: currentTurn, role: "assistant_final", content: "LOCAL_OK" });
      yield ev({ turn: currentTurn, role: "done" });
    }),
  };
  tab.runtime = { loop, eventizer, ctx };
  const emitted: Array<Event | { type: string }> = [];
  const meta: { turnCount?: number; autoTitleGenerated?: boolean } = {};
  const rename = vi.fn(({ title }: { title: string }) => {
    meta.autoTitleGenerated = true;
    return title;
  });
  const runTurn = desktopRunTurn({
    startComputerUse: async () => {},
    acceptedClientTurn: () => undefined,
    attachments: {
      resolveAll: async () => {
        phases.attachments();
        return [];
      },
    },
    prepareHelpContext: () => ({}),
    desktopHelpContext: () => ({}),
    tabContext: { run: async (_id: string, fn: () => Promise<void>) => fn() },
    emit: (event: Event | { type: string }) => emitted.push(event),
    emitCtxBreakdown: () => {},
    emitSessions: () => {},
    emitBalance: async () => {},
    emitUsageHistory: () => {},
    appendDesktopAssistantFinalUsage: () => {},
    isAbortSyntheticFinal: () => false,
    mergeLoadedSessionFiles: () => [],
    sessionFilesFromTool: () => [],
    loadSessionMeta: () => ({ ...meta }),
    patchSessionMeta: (_name: string, patch: typeof meta) => Object.assign(meta, patch),
    emitTurnCommitted: () => {},
    generateSessionTitle,
    shouldAutoNameSession,
    applyGeneratedDesktopSessionTitle: rename,
    persistOpenTabs: () => {},
    emitSessionRenamed: () => emitted.push({ type: "$session_renamed" }),
    runHooks: async ({ payload }: { payload: { event: string } }) => {
      if (payload.event === "Stop") await phases.stop();
      else phases.submit();
      return { outcomes: [], blocked: false };
    },
    tabs: new Map([[tab.id, tab]]),
  });
  return {
    tab,
    phases,
    loop,
    emitted,
    finishTurn,
    rename,
    admission,
    run: (text = "Rename this session.") => runTurn(tab, text),
  };
}

describe("host stable session identity regressions", { retry: 0 }, () => {
  it("automatic title rename completes exactly once and the next turn can send", async () => {
    const host = titleHost();
    await host.run();
    expect(host.rename).toHaveBeenCalledTimes(1);
    expect(host.tab.currentSession).toBe("Rename this session");
    expect(host.loop.rebindSession).toHaveBeenCalledWith("Rename this session");
    expect(host.tab.sessionId).toBe("stable-session");
    expect(host.tab.bindingId).toBe(1);
    expect(host.emitted.filter((event) => event.type === "$session_renamed")).toHaveLength(1);
    expect(host.emitted.filter((event) => event.type === "model.final")).toHaveLength(1);
    expect(host.emitted.filter((event) => event.type === "$error")).toEqual([]);
    expect(host.finishTurn).toHaveBeenCalledTimes(1);
    expect(host.finishTurn).toHaveBeenCalledWith(1);
    expect(host.emitted.filter((event) => event.type === "$turn_complete")).toHaveLength(1);
    expect(host.admission.running).toBe(false);
    await host.run("Next turn");
    expect(host.loop.step).toHaveBeenCalledTimes(2);
    expect(host.emitted.filter((event) => event.type === "$turn_complete")).toHaveLength(2);
    expect(host.loop.client.chat).not.toHaveBeenCalled();
  });

  it.each(["attachments", "submit", "loop"] as const)(
    "display rename during %s retains ownership",
    async (phase) => {
      const host = titleHost();
      host.tab.hooks = [{ event: "UserPromptSubmit" }];
      host.phases[phase] = () => {
        host.tab.currentSession = "display-title";
      };
      await host.run();
      expect(host.loop.step).toHaveBeenCalledTimes(1);
      expect(host.emitted.filter((event) => event.type === "model.final")).toHaveLength(1);
      expect(host.finishTurn).toHaveBeenCalledTimes(1);
      expect(host.finishTurn).toHaveBeenCalledWith(1);
      expect(host.emitted.filter((event) => event.type === "$turn_complete")).toHaveLength(1);
      expect(host.emitted.filter((event) => event.type === "$error")).toEqual([]);
    },
  );

  it.each(["sessionId", "bindingId"] as const)(
    "same-name %s switch suppresses stale completion and the new session can send",
    async (identity) => {
      const host = titleHost();
      host.tab.currentSession = "named-session";
      host.phases.loop = () => {
        if (identity === "sessionId") host.tab.sessionId = "new-session";
        else host.tab.bindingId += 1;
      };
      await host.run();
      expect(host.finishTurn).not.toHaveBeenCalled();
      expect(host.emitted.filter((event) => event.type === "$turn_complete")).toEqual([]);
      expect(host.admission.running).toBe(false);
      host.phases.loop = () => {};
      await host.run("New session message");
      expect(host.loop.step).toHaveBeenCalledTimes(2);
      expect(host.finishTurn).toHaveBeenCalledTimes(1);
      expect(host.finishTurn).toHaveBeenCalledWith(2);
      expect(host.emitted.filter((event) => event.type === "$turn_complete")).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "Stop hook delays completion, binding switch=%s",
    async (switchBinding) => {
      const host = titleHost();
      host.tab.hooks = [{ event: "Stop" }];
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      host.phases.stop = async () => {
        entered();
        await waiting;
      };
      const running = host.run();
      await started;
      expect(host.emitted.filter((event) => event.type === "$turn_complete")).toEqual([]);
      if (switchBinding) host.tab.bindingId += 1;
      release();
      await running;
      expect(host.emitted.filter((event) => event.type === "$turn_complete")).toHaveLength(
        switchBinding ? 0 : 1,
      );
      expect(host.finishTurn).toHaveBeenCalledTimes(switchBinding ? 0 : 1);
      expect(host.admission.running).toBe(false);
    },
  );
});

describe("stage 3 complete tool termination regressions", { retry: 0 }, () => {
  it.each(["delta", "drop"] as const)(
    "real host early-close at %s consumes only this turn's abort",
    async (stopAt) => {
      const home = mkdtempSync(join(tmpdir(), "jupiter-host-abort-"));
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      const homedir = vi.spyOn(require("node:os"), "homedir").mockReturnValue(home);
      try {
        const { loop, fetcher } = makeStreamingLoop("host-abort");
        const first = await runHost("stop", loop, stopAt);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(first.emitted.filter((event) => event.type === "tool.result")).toHaveLength(1);
        expect(first.emitted.filter((event) => event.type === "$turn_complete")).toHaveLength(1);
        expect(first.emitted.filter((event) => event.type === "$error")).toEqual([]);
        const second: LoopEvent[] = [];
        for await (const event of loop.step("second Agent turn")) second.push(event);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(second.find((event) => event.role === "assistant_final")).toMatchObject({
          content: "next turn reached provider",
        });
        expect(loop.inflight.size).toBe(0);
      } finally {
        homedir.mockRestore();
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("returning a never-started generator preserves pre-step abort carry", async () => {
    const loop = makeLoop();
    const chat = vi.spyOn(loop.client, "chat");
    loop.abort();
    const unused = loop.step("never entered");
    await unused.return(undefined);
    const cancelled: LoopEvent[] = [];
    for await (const event of loop.step("must honor earlier abort")) cancelled.push(event);
    expect(chat).not.toHaveBeenCalled();
    expect(cancelled.find((event) => event.role === "assistant_final")?.forcedSummary).toBe(true);
    for await (const _event of loop.step("fresh after consuming abort")) {
    }
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("a budget rejection before turn setup does not consume pre-step abort", async () => {
    const loop = makeLoop();
    const chat = vi.spyOn(loop.client, "chat");
    loop.abort();
    loop.setBudget(1);
    const spent = vi.spyOn(loop.stats, "totalCost", "get").mockReturnValue(2);
    const rejected: LoopEvent[] = [];
    try {
      for await (const event of loop.step("budget rejected")) rejected.push(event);
    } finally {
      spent.mockRestore();
    }
    expect(rejected.find((event) => event.role === "error")?.errorDetail?.name).toBe(
      "BudgetExhausted",
    );
    loop.setBudget(null);
    const cancelled: LoopEvent[] = [];
    for await (const event of loop.step("must still honor earlier abort")) cancelled.push(event);
    expect(chat).not.toHaveBeenCalled();
    expect(cancelled.find((event) => event.role === "assistant_final")?.forcedSummary).toBe(true);
  });

  it.each(["stop", "throw"] as const)(
    "host %s terminates open calls before one completion",
    async (mode) => {
      const { emitted, returned, admission, eventizer } = await runHost(mode);
      const results = emitted.filter((event) => event.type === "tool.result");
      expect(results).toHaveLength(2);
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            callId: "running",
            terminalState: "cancelled",
            executed: true,
            providerCallId: "provider-running",
          }),
          expect.objectContaining({
            callId: "preparing",
            terminalState: "cancelled",
            executed: false,
            providerCallId: "provider-preparing",
          }),
        ]),
      );
      expect(emitted.filter((event) => event.type === "$turn_complete")).toHaveLength(1);
      expect(emitted.indexOf(results.at(-1)!)).toBeLessThan(
        emitted.findIndex((event) => event.type === "$turn_complete"),
      );
      expect(
        eventizer.consume(
          ev({ role: "tool_start", localCallId: "preparing", toolName: "read" }),
          ctx,
        ),
      ).toEqual([]);
      expect(returned).toBe(true);
      expect(admission.running).toBe(false);
    },
  );

  it.each(["session", "binding", "runtime", "generation", "switching"] as const)(
    "host never emits stale terminal/completion after %s changes",
    async (mode) => {
      const { emitted } = await runHost(mode);
      expect(
        emitted.filter((event) => event.type === "tool.result" || event.type === "$turn_complete"),
      ).toEqual([]);
    },
  );

  it("normal host completion preserves completed results without duplicate terminals", async () => {
    const { emitted } = await runHost("done");
    expect(emitted.filter((event) => event.type === "tool.result")).toEqual([
      expect.objectContaining({ callId: "running", terminalState: "completed", output: "ok" }),
      expect.objectContaining({ callId: "preparing", terminalState: "dropped", executed: false }),
    ]);
    expect(emitted.filter((event) => event.type === "$turn_complete")).toHaveLength(1);
  });

  it.each(["snapshot", "journal-open", "journal-intent"] as const)(
    "cleans actual loop %s early return without clearing unrelated inflight",
    async (mode) => {
      const loop = makeLoop();
      const internals = loop as unknown as {
        turnDefinitions: Map<string, unknown> | null;
        _sessionName: string | null;
        _toolJournal: unknown;
        runOneToolCall: DispatchContext["runOne"];
      };
      if (mode === "snapshot") internals.turnDefinitions = new Map();
      else internals._sessionName = "test-only-no-io";
      if (mode === "journal-intent")
        internals._toolJournal = {
          recordIntent: () => {
            throw new Error("mock intent failure");
          },
        };
      loop.inflight.add("unrelated");
      const events: LoopEvent[] = [];
      for await (const event of dispatchToolCallsChunked(
        [call],
        dispatchContext(loop.inflight, (c, signal) => internals.runOneToolCall(c, signal)),
      ))
        events.push(event);
      expect(events.find((event) => event.role === "tool")?.content).toContain("error");
      expect(loop.inflight.has("unrelated")).toBe(true);
      expect(loop.inflight.size).toBe(1);
    },
  );

  it("returning the dispatcher at tool_start cleans registered IDs without executing", async () => {
    const inflight = new Set(["unrelated"]);
    const runOne = vi.fn(async () => ({ result: "ok", preWarnings: [], postWarnings: [] }));
    const gen = dispatchToolCallsChunked([call], dispatchContext(inflight, runOne));
    expect((await gen.next()).value).toMatchObject({ role: "tool_start" });
    expect(inflight.has(call.id!)).toBe(true);
    await gen.return();
    expect([...inflight]).toEqual(["unrelated"]);
    expect(runOne).not.toHaveBeenCalled();
  });

  it("cleans rejected execution while preserving input result order", async () => {
    const inflight = new Set(["unrelated"]);
    const calls = [call, { ...call, id: "provider-2" }];
    const events: LoopEvent[] = [];
    for await (const event of dispatchToolCallsChunked(
      calls,
      dispatchContext(inflight, async (c) => {
        if (c.id === "provider-1") throw new Error("mock execution failure");
        return { result: "ok", preWarnings: [], postWarnings: [] };
      }),
    ))
      events.push(event);
    expect(events.filter((event) => event.role === "tool").map((event) => event.callId)).toEqual([
      "provider-1",
      "provider-2",
    ]);
    expect([...inflight]).toEqual(["unrelated"]);
  });

  it("aliases one legacy anonymous preparation through provider start/result", () => {
    const e = new Eventizer();
    const prep = e
      .consume(ev({ role: "tool_call_delta", toolName: "read", toolCallIndex: 0 }), ctx)
      .at(-1)!;
    e.consume(ev({ role: "assistant_final" }), ctx);
    const start = e.consume(
      ev({ role: "tool_start", toolName: "read", callId: "provider-1", toolArgs: "{}" }),
      ctx,
    );
    const result = e.consume(
      ev({ role: "tool", toolName: "read", callId: "provider-1", content: "ok" }),
      ctx,
    );
    expect(start.at(-1)).toMatchObject({ callId: (prep as { callId: string }).callId });
    expect(result.at(-1)).toMatchObject({
      callId: (prep as { callId: string }).callId,
      terminalState: "completed",
    });
    expect(e.consume(ev({ role: "done" }), ctx)).toEqual([]);
  });

  it("scopes repeated legacy explicit provider IDs to each turn", () => {
    const e = new Eventizer();
    const ids: string[] = [];
    for (const turn of [1, 2]) {
      const start = e.consume(
        ev({ turn, role: "tool_start", toolName: "read", callId: "call-0" }),
        ctx,
      );
      expect(start.some((event) => event.type === "tool.intent")).toBe(true);
      const result = e
        .consume(
          ev({ turn, role: "tool", toolName: "read", callId: "call-0", content: `result-${turn}` }),
          ctx,
        )
        .at(-1)!;
      expect(result).toMatchObject({ type: "tool.result", output: `result-${turn}` });
      ids.push((result as { callId: string }).callId);
    }
    expect(new Set(ids).size).toBe(2);
    expect(
      e
        .consume(ev({ turn: 1, role: "tool_start", toolName: "read", callId: "call-0" }), ctx)
        .filter((event) => event.type.startsWith("tool.")),
    ).toEqual([]);
  });

  it.each(["request", "local", "explicit", "ambiguous"] as const)(
    "does not name-alias a %s preparation",
    (kind) => {
      const e = new Eventizer();
      const identity =
        kind === "request"
          ? { requestId: "modern" }
          : kind === "local"
            ? { localCallId: "modern" }
            : kind === "explicit"
              ? { callId: "explicit-prep" }
              : {};
      const prep = e
        .consume(
          ev({ role: "tool_call_delta", toolName: "read", toolCallIndex: 0, ...identity }),
          ctx,
        )
        .at(-1)!;
      if (kind === "ambiguous")
        e.consume(ev({ role: "tool_call_delta", toolName: "read", toolCallIndex: 1 }), ctx);
      const start = e
        .consume(ev({ role: "tool_start", toolName: "read", callId: "provider-other" }), ctx)
        .at(-1)!;
      expect((start as { callId: string }).callId).not.toBe((prep as { callId: string }).callId);
    },
  );

  it("an unidentified legacy result cannot name-claim a modern running card", () => {
    const e = new Eventizer();
    e.consume(
      ev({ role: "tool_start", toolName: "read", localCallId: "modern", requestId: "request" }),
      ctx,
    );
    const result = e.consume(ev({ role: "tool", toolName: "read", content: "stray" }), ctx).at(-1)!;
    expect((result as { callId: string }).callId).not.toBe("modern");
  });

  it("a modern start cannot name-claim an anonymous legacy preparation", () => {
    const e = new Eventizer();
    const prep = e
      .consume(ev({ role: "tool_call_delta", toolName: "read", toolCallIndex: 0 }), ctx)
      .at(-1)!;
    const start = e
      .consume(
        ev({ role: "tool_start", toolName: "read", callId: "modern", requestId: "request" }),
        ctx,
      )
      .at(-1)!;
    expect((start as { callId: string }).callId).toBe("modern");
    expect((start as { callId: string }).callId).not.toBe((prep as { callId: string }).callId);
  });

  it("never aliases a formerly anonymous preparation that now has modern identity", () => {
    const e = new Eventizer();
    const prep = e
      .consume(ev({ role: "tool_call_delta", toolName: "read", toolCallIndex: 0 }), ctx)
      .at(-1) as { callId: string };
    e.consume(
      ev({
        role: "tool_call_delta",
        toolName: "read",
        toolCallIndex: 0,
        localCallId: prep.callId,
        requestId: "modern",
      }),
      ctx,
    );
    const start = e
      .consume(ev({ role: "tool_start", toolName: "read", callId: "provider-other" }), ctx)
      .at(-1)!;
    expect((start as { callId: string }).callId).not.toBe(prep.callId);
  });

  it("binds an anonymous preparation to only one late legacy provider identity", () => {
    const e = new Eventizer();
    const prep = e
      .consume(ev({ role: "tool_call_delta", toolName: "read", toolCallIndex: 0 }), ctx)
      .at(-1) as { callId: string };
    const late = e
      .consume(
        ev({
          role: "tool_call_delta",
          toolName: "read",
          toolCallIndex: 0,
          callId: "provider-first",
        }),
        ctx,
      )
      .at(-1)!;
    expect(late).toMatchObject({ type: "tool.progress", callId: prep.callId });
    const other = e
      .consume(
        ev({
          role: "tool_call_delta",
          toolName: "read",
          toolCallIndex: 0,
          callId: "provider-other",
        }),
        ctx,
      )
      .at(-1)!;
    expect((other as { callId: string }).callId).not.toBe(prep.callId);
    const start = e
      .consume(ev({ role: "tool_start", toolName: "read", callId: "provider-first" }), ctx)
      .at(-1)!;
    expect(start).toMatchObject({ callId: prep.callId });
  });

  it("updates a fragmented legacy preparation name before start/result correlation", () => {
    const e = new Eventizer();
    const prep = e
      .consume(ev({ role: "tool_call_delta", toolName: "read_", toolCallIndex: 0 }), ctx)
      .at(-1) as { callId: string };
    e.consume(ev({ role: "tool_call_delta", toolName: "read_file", toolCallIndex: 0 }), ctx);
    e.consume(ev({ role: "assistant_final" }), ctx);
    expect(
      e
        .consume(
          ev({ role: "tool_start", toolName: "read_file", callId: "provider-fragment" }),
          ctx,
        )
        .at(-1),
    ).toMatchObject({ callId: prep.callId });
    expect(
      e
        .consume(
          ev({ role: "tool", toolName: "read_file", callId: "provider-fragment", content: "ok" }),
          ctx,
        )
        .at(-1),
    ).toMatchObject({ callId: prep.callId, terminalState: "completed" });
    expect(e.consume(ev({ role: "done" }), ctx)).toEqual([]);
  });

  it.each([false, true])(
    "scopes reused legacy provider ID across same-turn finals (preparing=%s)",
    (preparing) => {
      const e = new Eventizer();
      const ids: string[] = [];
      for (const iteration of [1, 2]) {
        let prepId: string | undefined;
        if (preparing)
          prepId = (
            e
              .consume(ev({ role: "tool_call_delta", toolName: "read", toolCallIndex: 0 }), ctx)
              .at(-1) as { callId: string }
          ).callId;
        e.consume(ev({ role: "assistant_final" }), ctx);
        const start = e
          .consume(ev({ role: "tool_start", toolName: "read", callId: "call-0" }), ctx)
          .at(-1)!;
        expect(start).toMatchObject({ type: "tool.dispatched" });
        const result = e
          .consume(
            ev({
              role: "tool",
              toolName: "read",
              callId: "call-0",
              content: `iteration-${iteration}`,
            }),
            ctx,
          )
          .at(-1)!;
        expect(result).toMatchObject({ type: "tool.result", output: `iteration-${iteration}` });
        if (preparing) expect((result as { callId: string }).callId).toBe(prepId);
        expect((start as { callId: string }).callId).toBe((result as { callId: string }).callId);
        ids.push((result as { callId: string }).callId);
      }
      expect(new Set(ids).size).toBe(2);
      expect(e.consume(ev({ role: "done" }), ctx)).toEqual([]);
    },
  );
});
