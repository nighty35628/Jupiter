import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { abortDesktopTurnControllers } from "../src/cli/commands/desktop.js";
import { classifyDesktopNaturalCommandIntent } from "../src/desktop/natural-command-intent.js";
import { DesktopTurnAdmission } from "../src/desktop/turn-admission.js";
import { classifyWorkflowIntent } from "../src/workflows/intent.js";

const source = ts.createSourceFile(
  "desktop.ts",
  readFileSync("src/cli/commands/desktop.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
);

function extract(predicate: (node: ts.Node) => boolean): string {
  let result = "";
  function visit(node: ts.Node) {
    if (predicate(node)) result = node.getText(source);
    else ts.forEachChild(node, visit);
  }
  visit(source);
  expect(result).not.toBe("");
  return result;
}

function fixture(ignoreAbort = false) {
  const pending: Array<{
    signal?: AbortSignal;
    resolve: (value: { content: string }) => void;
    reject: (reason: Error) => void;
  }> = [];
  const chat = vi.fn(
    ({ signal }: { signal?: AbortSignal }) =>
      new Promise<{ content: string }>((resolve, reject) => {
        pending.push({ signal, resolve, reject });
        if (signal?.aborted) reject(signal.reason);
        else if (!ignoreAbort)
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  const loop = {
    client: { chat, supportsImages: () => false },
    model: "synthetic-model",
    step: vi.fn(async function* (
      _text: string,
      _options: { onUserPersisted: (turn: number) => void; onUserPersistFailed: () => void },
    ) {}),
    manualCompactHistory: vi.fn(async () => ({ folded: false, reason: "not-needed" })),
    abort: vi.fn(),
  };
  const tab = {
    id: "t1",
    runtime: {
      loop,
      eventizer: {
        finishTurn: () => [],
        emitUserMessage: (turn: number, text: string) => ({ type: "user.message", turn, text }),
      },
    },
    currentModel: "synthetic-model",
    currentSession: "synthetic-session",
    sessionId: "session-1",
    bindingId: 1,
    rootDir: "/synthetic/workspace",
    aborter: null as AbortController | null,
    turnAdmission: new DesktopTurnAdmission(),
    hooks: [],
    planTotalSteps: 0,
    switching: false,
    pendingModel: undefined,
    runtimeRefreshPending: false,
  };
  const emit = vi.fn();
  const tabs = new Map([[tab.id, tab]]);
  const classify = vi.fn(classifyDesktopNaturalCommandIntent);
  const accepted = new Map<string, number>();
  const dependencies = {
    tab,
    tabs,
    emit,
    classifyDesktopNaturalCommandIntent: classify,
    classifyWorkflowIntent,
    getWorkflowTemplate: () => ({ title: "synthetic workflow" }),
    emitStatus: vi.fn(),
    emitCompactResult: vi.fn(),
    emitCurrentSessionLoaded: vi.fn(),
    emitCtxBreakdown: vi.fn(),
    finishDesktopCommand: vi.fn(),
    startComputerUse: vi.fn(async () => {}),
    acceptedClientTurn: (session: string, id?: string) =>
      id ? accepted.get(`${session}:${id}`) : undefined,
    rememberAcceptedClientMessage: (session: string, id: string, turn: number) =>
      accepted.set(`${session}:${id}`, turn),
    attachments: { resolveAll: async () => [] },
    prepareHelpContext: () => ({ topics: [] }),
    desktopHelpContext: () => ({}),
    loadSessionMeta: () => ({}),
    patchSessionMeta: vi.fn(),
    shouldAutoNameSession: () => false,
    emitSessions: vi.fn(),
    emitBalance: vi.fn(),
    predictionTurnSucceeded: vi.fn(() => false),
    restoreOneShotPlanGuard: vi.fn(),
    tabContext: { run: (_id: string, fn: () => Promise<void>) => fn() },
    shouldUseLightAskForDesktopInput: () => false,
    desktopRuntimeUnavailableMessage: () => "unavailable",
    loadApiKey: () => "synthetic",
    t: (key: string) => key,
  };
  const functions = ["runTurn", "maybeSuggestWorkflow"]
    .map((name) => extract((node) => ts.isFunctionDeclaration(node) && node.name?.text === name))
    .join("\n");
  const branch = extract(
    (node) =>
      ts.isIfStatement(node) && node.expression.getText(source) === 'msg.cmd === "user_input"',
  );
  // Execute the production handlers themselves, with only host services replaced.
  const program = ts.transpileModule(
    `${functions}
    const tasks = [];
    const originalRunTurn = runTurn;
    runTurn = (...args) => { const task = originalRunTurn(...args); tasks.push(task); return task; };
    return { tasks, dispatch: async (msg) => { ${branch} } };
  `,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const handlers = new Function(...Object.keys(dependencies), program)(
    ...Object.values(dependencies),
  ) as {
    tasks: Promise<void>[];
    dispatch: (msg: { cmd: string; text: string; clientId?: string }) => Promise<void>;
  };
  const send = (text = "ordinary Agent task", clientId?: string) =>
    handlers.dispatch({ cmd: "user_input", text, clientId });
  const settle = async (dispatch: Promise<void>) => {
    await dispatch;
    await Promise.all(handlers.tasks);
  };
  return { tab, loop, pending, chat, emit, classify, send, settle, handlers, dependencies };
}

describe("production Agent preflight cancellation", { retry: 0 }, () => {
  it("owns cancellation before classification, closes it, and never enters later branches", async () => {
    const f = fixture();
    const dispatch = f.send("cancel during classification", "cancelled-client");
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));
    expect(f.tab.turnAdmission.kind).toBe("agent");
    expect(f.tab.aborter).not.toBeNull();
    abortDesktopTurnControllers(f.tab);
    expect(f.pending[0].signal?.aborted).toBe(true);
    await f.settle(dispatch);
    expect(f.chat).toHaveBeenCalledTimes(1);
    expect(f.loop.step).not.toHaveBeenCalled();
    expect(f.loop.manualCompactHistory).not.toHaveBeenCalled();
    expect(f.loop.abort).not.toHaveBeenCalled();
    expect(f.tab.turnAdmission.running).toBe(false);
    expect(f.tab.aborter).toBeNull();
    expect(f.emit.mock.calls.filter(([e]) => e.type === "$turn_complete")).toHaveLength(1);
    expect(f.emit).toHaveBeenCalledWith(
      { type: "$turn_complete", unacceptedClientId: "cancelled-client" },
      "t1",
    );
    expect(f.emit.mock.calls.some(([e]) => e.type === "$error")).toBe(false);
  });

  it("does not run compaction if its classification is cancelled just before returning", async () => {
    const f = fixture();
    const dispatch = f.send();
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));
    f.pending[0].resolve({ content: '{"command":"compact_history"}' });
    abortDesktopTurnControllers(f.tab);
    await f.settle(dispatch);
    expect(f.loop.manualCompactHistory).not.toHaveBeenCalled();
    expect(f.loop.step).not.toHaveBeenCalled();
    expect(f.chat).toHaveBeenCalledTimes(1);
  });

  it("drops stale classifications after switching sessions", async () => {
    const f = fixture();
    const dispatch = f.send();
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));
    abortDesktopTurnControllers(f.tab);
    f.tab.turnAdmission.invalidate();
    f.tab.sessionId = "session-2";
    f.tab.bindingId++;
    await f.settle(dispatch);
    expect(f.loop.step).not.toHaveBeenCalled();
    expect(f.loop.manualCompactHistory).not.toHaveBeenCalled();
    expect(f.emit).not.toHaveBeenCalled();
  });

  it("does not let an ignored late cancellation release a newer turn", async () => {
    const f = fixture(true);
    const oldDispatch = f.send();
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));
    abortDesktopTurnControllers(f.tab);
    f.tab.turnAdmission.invalidate();
    f.tab.sessionId = "session-2";
    f.tab.bindingId++;
    const newDispatch = f.send("new session task");
    await vi.waitFor(() => expect(f.pending).toHaveLength(2));
    const newController = f.tab.aborter;
    f.pending[0].resolve({ content: '{"command":"compact_history"}' });
    await oldDispatch;
    await f.handlers.tasks[0];
    expect(f.tab.aborter).toBe(newController);
    expect(newController?.signal.aborted).toBe(false);
    expect(f.tab.turnAdmission.running).toBe(true);
    expect(f.loop.manualCompactHistory).not.toHaveBeenCalled();
    expect(f.emit).not.toHaveBeenCalled();
    f.pending[1].resolve({ content: '{"command":"none"}' });
    await f.settle(newDispatch);
    expect(f.loop.step).toHaveBeenCalledTimes(1);
    expect(f.emit.mock.calls.filter(([e]) => e.type === "$turn_complete")).toHaveLength(1);
  });

  it("preserves normal compaction as a terminal branch", async () => {
    const f = fixture();
    const dispatch = f.send();
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));
    f.pending[0].resolve({ content: '{"command":"compact_history"}' });
    await f.settle(dispatch);
    expect(f.loop.manualCompactHistory).toHaveBeenCalledTimes(1);
    expect(f.loop.step).not.toHaveBeenCalled();
    expect(f.chat).toHaveBeenCalledTimes(1);
    expect(f.dependencies.emitCompactResult).toHaveBeenCalledTimes(1);
    expect(f.tab.turnAdmission.running).toBe(false);
    expect(f.emit.mock.calls.filter(([e]) => e.type === "$turn_complete")).toHaveLength(1);
  });

  it("does not discard an accepted user message and deduplicates its completed replay", async () => {
    const f = fixture();
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.loop.step.mockImplementation(async function* (_text, options) {
      options.onUserPersisted(1);
      await running;
      yield* [];
    });
    f.loop.abort.mockImplementation(() => finish());
    const dispatch = f.send("accepted then cancelled", "accepted-client");
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));
    f.pending[0].resolve({ content: '{"command":"none"}' });
    await vi.waitFor(() => expect(f.loop.step).toHaveBeenCalledTimes(1));
    abortDesktopTurnControllers(f.tab);
    await f.settle(dispatch);
    expect(f.emit).toHaveBeenCalledWith({ type: "$turn_complete" }, "t1");
    expect(f.emit.mock.calls.some(([e]) => e.unacceptedClientId)).toBe(false);
    const calls = f.chat.mock.calls.length;
    await f.settle(f.send("accepted then cancelled", "accepted-client"));
    expect(f.chat).toHaveBeenCalledTimes(calls);
    expect(f.loop.step).toHaveBeenCalledTimes(1);
  });

  it("preserves an in-memory user message when disk persistence fails before cancellation", async () => {
    const f = fixture();
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.loop.step.mockImplementation(async function* (_text, options) {
      options.onUserPersistFailed();
      await running;
      yield* [];
    });
    f.loop.abort.mockImplementation(() => finish());
    const dispatch = f.send("running despite failed persistence", "not-on-disk");
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));
    f.pending[0].resolve({ content: '{"command":"none"}' });
    await vi.waitFor(() => expect(f.loop.step).toHaveBeenCalledTimes(1));
    abortDesktopTurnControllers(f.tab);
    await f.settle(dispatch);
    expect(f.emit.mock.calls.some(([e]) => e.unacceptedClientId)).toBe(false);
    expect(f.emit).toHaveBeenCalledWith({ type: "$turn_complete" }, "t1");
  });

  it("cancels manual compaction through the loop owner and restores Agent admission", async () => {
    const f = fixture();
    let complete!: (result: { folded: boolean; reason: string }) => void;
    f.loop.manualCompactHistory.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    f.loop.abort.mockImplementation(() => complete({ folded: false, reason: "summary-cancelled" }));
    const dispatch = f.send();
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));
    f.pending[0].resolve({ content: '{"command":"compact_history"}' });
    await vi.waitFor(() => expect(f.loop.manualCompactHistory).toHaveBeenCalledTimes(1));
    expect(f.tab.turnAdmission.loopEntered).toBe(true);
    abortDesktopTurnControllers(f.tab);
    await f.settle(dispatch);
    expect(f.loop.abort).toHaveBeenCalledTimes(1);
    expect(f.dependencies.emitCurrentSessionLoaded).not.toHaveBeenCalled();
    expect(f.loop.step).not.toHaveBeenCalled();
    const recovery = f.send("new Agent after compact cancellation");
    await vi.waitFor(() => expect(f.pending).toHaveLength(2));
    f.pending[1].resolve({ content: '{"command":"none"}' });
    await f.settle(recovery);
    expect(f.loop.step).toHaveBeenCalledTimes(1);
  });

  it("keeps non-cancellation classifier failures on the existing normal chat route", async () => {
    const f = fixture();
    const dispatch = f.send();
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));
    f.pending[0].reject(new Error("synthetic provider offline"));
    await f.settle(dispatch);
    expect(f.loop.step).toHaveBeenCalledTimes(1);
    expect(f.tab.turnAdmission.running).toBe(false);
  });

  it("rejects duplicate admission during preflight and allows a fresh Agent after cancellation", async () => {
    const f = fixture();
    const dispatch = f.send();
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));
    await f.send("duplicate while classifying");
    expect(f.chat).toHaveBeenCalledTimes(1);
    abortDesktopTurnControllers(f.tab);
    await f.settle(dispatch);
    const recovered = f.send("fresh Agent after cancellation");
    await vi.waitFor(() => expect(f.pending).toHaveLength(2));
    expect(f.pending[1].signal?.aborted).toBe(false);
    f.pending[1].resolve({ content: '{"command":"none"}' });
    await f.settle(recovered);
    expect(f.loop.step).toHaveBeenCalledTimes(1);
    expect(f.tab.turnAdmission.running).toBe(false);
  });

  it("cancels auxiliary workflow requests at turn completion without late suggestions", async () => {
    const f = fixture();
    const dispatch = f.send();
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));
    f.pending[0].resolve({ content: '{"command":"none"}' });
    await f.settle(dispatch);
    expect(f.loop.step).toHaveBeenCalledTimes(1);
    expect(f.pending).toHaveLength(2);
    expect(f.pending[1].signal?.aborted).toBe(true);
    expect(f.dependencies.predictionTurnSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ aborted: false }),
    );
    f.pending[1].resolve({
      content: '{"shouldSuggest":true,"workflowId":"release-readiness-check","confidence":1}',
    });
    await Promise.resolve();
    expect(f.dependencies.emitStatus).not.toHaveBeenCalled();
  });

  it("suppresses a late workflow response even if its transport ignores cancellation", async () => {
    const f = fixture(true);
    const dispatch = f.send();
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));
    f.pending[0].resolve({ content: '{"command":"none"}' });
    await f.settle(dispatch);
    expect(f.pending[1].signal?.aborted).toBe(true);
    f.pending[1].resolve({
      content: '{"shouldSuggest":true,"workflowId":"release-readiness-check","confidence":1}',
    });
    await vi.waitFor(() => expect(f.chat).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(f.dependencies.emitStatus).not.toHaveBeenCalled();
    expect(f.emit.mock.calls.some(([e]) => e.type === "$error")).toBe(false);
  });

  it("still publishes a timely workflow suggestion while its Agent is running", async () => {
    const f = fixture();
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.loop.step.mockImplementation(async function* () {
      await running;
      yield* [];
    });
    const dispatch = f.send();
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));
    f.pending[0].resolve({ content: '{"command":"none"}' });
    await vi.waitFor(() => expect(f.pending).toHaveLength(2));
    f.pending[1].resolve({
      content: '{"shouldSuggest":true,"workflowId":"release-readiness-check","confidence":1}',
    });
    await vi.waitFor(() => expect(f.dependencies.emitStatus).toHaveBeenCalledTimes(1));
    finish();
    await f.settle(dispatch);
    expect(f.tab.turnAdmission.running).toBe(false);
    expect(f.pending[1].signal?.aborted).toBe(true);
  });
});
