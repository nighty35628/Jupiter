import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planDesktopTabRestore } from "../src/desktop/tab-restore.js";
import { guardedAndroidIdleStop, requestAndroidActivity } from "../src/mobile/host.js";
import { SequencedPacketBuffer, type WebSidecar } from "../src/web/sidecar.js";

const desktop = ts.createSourceFile(
  "desktop.ts",
  readFileSync("src/cli/commands/desktop.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const host = ts.createSourceFile(
  "host.ts",
  readFileSync("src/mobile/host.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
);

function declaration(source: ts.SourceFile, name: string): string {
  let result = "";
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      result = node.getText(source).replace(/^export /, "");
    else ts.forEachChild(node, visit);
  };
  visit(source);
  expect(result).not.toBe("");
  return result;
}

function compile(code: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}

class ActivitySidecar implements WebSidecar {
  runtimeEpoch = "epoch-one";
  buffer = new SequencedPacketBuffer();
  active = 0;
  respond = true;
  beforeReply?: (command: Record<string, unknown>) => void;
  commands: Record<string, unknown>[] = [];
  close = vi.fn(async () => {});
  get latestSequence() {
    return this.buffer.latestSequence;
  }
  subscribe: WebSidecar["subscribe"] = (listener) => this.buffer.subscribe(listener);
  replayAfter: WebSidecar["replayAfter"] = (...args) => this.buffer.replayAfter(...args);
  event(value: object) {
    this.buffer.append({ channel: "rpc:event", payload: { data: JSON.stringify(value) } });
  }
  async send(command: Record<string, unknown>) {
    this.commands.push(command);
    this.beforeReply?.(command);
    if (this.respond)
      this.event({
        type: "$android_activity",
        requestId: command.requestId,
        runtimeEpoch: this.runtimeEpoch,
        active: this.active,
        idleReady: this.active === 0,
        ...(command.cmd === "android_guarded_idle_stop" ? { stopped: this.active === 0 } : {}),
      });
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function owner(extra: Record<string, unknown> = {}) {
  const tab = {
    turnAdmission: { running: false },
    aborter: null,
    toolset: { jobs: { runningCount: () => 0 } },
    ...extra,
  };
  return compile(`${declaration(desktop, "readAndroidActivity")} return readAndroidActivity;`, {
    pendingRpc: 0,
    androidBackgroundOperations: 0,
    sharedCompactions: new Map(),
    tabs: new Map([["one", tab]]),
    scheduledEngine: { hasPendingActivity: () => false },
  }) as () => number;
}

describe("Android real-owner idle readiness", { retry: 0 }, () => {
  it.each([
    { turnAdmission: { running: true } },
    { aborter: new AbortController() },
    { sharedTurnDone: Promise.resolve() },
    { switching: true },
    { sharedClosing: true },
    { initializing: true },
    { historyRestore: Promise.resolve() },
    { toolset: { jobs: { runningCount: () => 2 } } },
  ])("keeps real work busy without any model event: %j", (state) => {
    expect(owner(state)()).toBeGreaterThan(0);
  });

  it("re-samples jobs rather than retaining a stale jobs event", () => {
    let jobs = 1;
    const read = owner({ toolset: { jobs: { runningCount: () => jobs } } });
    expect(read()).toBe(1);
    jobs = 0;
    expect(read()).toBe(0);
  });

  it.each(["pendingRpc", "sharedCompactions", "scheduledEngine", "androidBackgroundOperations"])(
    "includes %s",
    (name) => {
      const bindings = {
        pendingRpc: 0,
        androidBackgroundOperations: 0,
        sharedCompactions: new Map(),
        tabs: new Map(),
        scheduledEngine: { hasPendingActivity: () => false },
      };
      if (name === "pendingRpc") bindings.pendingRpc = 1;
      if (name === "androidBackgroundOperations") bindings.androidBackgroundOperations = 1;
      if (name === "sharedCompactions") bindings.sharedCompactions.set("one", {});
      if (name === "scheduledEngine") bindings.scheduledEngine.hasPendingActivity = () => true;
      expect(
        compile(
          `${declaration(desktop, "readAndroidActivity")} return readAndroidActivity();`,
          bindings,
        ),
      ).toBe(1);
    },
  );

  it("commits the dispatch fence before acknowledging an idle stop", () => {
    const writeDesktopEvent = vi.fn();
    const gracefulShutdown = vi.fn(async () => {});
    const fixture = compile(
      `let androidIdleClosing = false;
      ${declaration(desktop, "handleAndroidActivity")}
      return { handle: handleAndroidActivity, closing: () => androidIdleClosing };`,
      {
        trustedAndroid: true,
        scheduledChild: false,
        webRuntimeEpoch: "epoch-one",
        shuttingDown: false,
        readAndroidActivity: () => 0,
        writeDesktopEvent,
        gracefulShutdown,
      },
    );
    writeDesktopEvent.mockImplementation(() => expect(fixture.closing()).toBe(true));
    fixture.handle({
      cmd: "android_guarded_idle_stop",
      requestId: "guard",
      runtimeEpoch: "epoch-one",
    });
    expect(writeDesktopEvent).toHaveBeenCalledWith(expect.objectContaining({ stopped: true }));
    expect(gracefulShutdown).toHaveBeenCalledTimes(1);
  });

  it("protects RPC before dispatch and rejects new dispatch after the idle commit", async () => {
    let listener = "";
    const visit = (node: ts.Node) => {
      if (ts.isExpressionStatement(node) && node.getText(desktop).startsWith('rl.on("line",'))
        listener = node.getText(desktop);
      else ts.forEachChild(node, visit);
    };
    visit(desktop);
    expect(listener).not.toBe("");
    const input = new EventEmitter();
    let finish!: () => void;
    const dispatchRpcMessage = vi.fn(
      () =>
        new Promise<void>((done) => {
          finish = done;
        }),
    );
    const writeDesktopEvent = vi.fn();
    const gracefulShutdown = vi.fn();
    const fixture = compile(
      `let androidIdleClosing = false; let pendingRpc = 0;
      let rpcDispatchChain = Promise.resolve();
      ${declaration(desktop, "readAndroidActivity")}
      ${declaration(desktop, "handleAndroidActivity")}
      ${listener}
      return { active: readAndroidActivity, drain: () => rpcDispatchChain };`,
      {
        rl: input,
        androidBackgroundOperations: 0,
        immediateCommands: new Set(["abort"]),
        dispatchRpcMessage,
        emit: vi.fn(),
        sharedCompactions: new Map(),
        tabs: new Map(),
        scheduledEngine: undefined,
        trustedAndroid: true,
        scheduledChild: false,
        webRuntimeEpoch: "epoch-one",
        shuttingDown: false,
        writeDesktopEvent,
        gracefulShutdown,
      },
    );
    const guard = () =>
      input.emit(
        "line",
        JSON.stringify({
          cmd: "android_guarded_idle_stop",
          requestId: "guard",
          runtimeEpoch: "epoch-one",
        }),
      );
    input.emit("line", JSON.stringify({ cmd: "user_input" }));
    expect(fixture.active()).toBe(1);
    guard();
    expect(writeDesktopEvent.mock.calls.at(-1)?.[0]).toMatchObject({ active: 1, stopped: false });
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish();
    await fixture.drain();
    expect(fixture.active()).toBe(0);
    guard();
    expect(gracefulShutdown).toHaveBeenCalledOnce();
    input.emit("line", JSON.stringify({ cmd: "user_input" }));
    await fixture.drain();
    expect(dispatchRpcMessage).toHaveBeenCalledOnce();
  });

  it.each(["busy", "unknown", "web", "scheduled", "ordinary", "stale"])(
    "does not commit for %s",
    (kind) => {
      const writeDesktopEvent = vi.fn();
      const gracefulShutdown = vi.fn();
      const fixture = compile(
        `let androidIdleClosing = false;
      ${declaration(desktop, "handleAndroidActivity")}
      return { handle: handleAndroidActivity, closing: () => androidIdleClosing };`,
        {
          trustedAndroid: kind !== "ordinary",
          scheduledChild: kind === "scheduled",
          webRuntimeEpoch: "epoch-one",
          shuttingDown: false,
          readAndroidActivity: () => {
            if (kind === "unknown") throw Error("unreadable store");
            return kind === "busy" ? 1 : 0;
          },
          writeDesktopEvent,
          gracefulShutdown,
        },
      );
      fixture.handle({
        cmd: "android_guarded_idle_stop",
        requestId: "guard",
        runtimeEpoch: kind === "stale" ? "old" : "epoch-one",
        ...(kind === "web" ? { __web: {} } : {}),
      });
      expect(fixture.closing()).toBe(false);
      expect(gracefulShutdown).not.toHaveBeenCalled();
      expect(writeDesktopEvent.mock.calls.every(([event]) => event.stopped === false)).toBe(true);
    },
  );

  it("keeps nonshared compaction busy through settlement", async () => {
    let finish!: (value: object) => void;
    const tab = {
      runtime: {
        loop: {
          manualCompactHistory: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        },
      },
    };
    const fixture = compile(
      `let androidBackgroundOperations = 0;
      ${declaration(desktop, "compactSharedHistory")}
      return { compact: compactSharedHistory, active: () => androidBackgroundOperations };`,
      {},
    );
    const task = fixture.compact(tab);
    expect(fixture.active()).toBe(1);
    finish({ folded: false });
    await task;
    expect(fixture.active()).toBe(0);
  });

  it("keeps overlapping shared compactions busy even when the latest map entry finishes first", async () => {
    const finish: Array<(value: object) => void> = [];
    const sharedSession = { activeTurns: 0, version: 1 };
    const tabs = new Map(
      ["one", "two"].map((id) => [
        id,
        {
          id,
          sessionId: "same",
          sharedSession,
          turnAdmission: { running: false },
          runtime: {
            loop: {
              manualCompactHistory: () =>
                new Promise((resolve) => {
                  finish.push(resolve);
                }),
            },
          },
        },
      ]),
    );
    const fixture = compile(
      `let androidBackgroundOperations = 0;
      ${declaration(desktop, "compactSharedHistory")}
      ${declaration(desktop, "readAndroidActivity")}
      return { compact: compactSharedHistory, active: readAndroidActivity };`,
      {
        tabs,
        pendingRpc: 0,
        sharedCompactions: new Map(),
        scheduledEngine: undefined,
      },
    );
    const a = fixture.compact(tabs.get("one"));
    const b = fixture.compact(tabs.get("two"));
    finish[1]({ folded: false });
    await b;
    expect(fixture.active()).toBeGreaterThan(0);
    finish[0]({ folded: false });
    await a;
    expect(fixture.active()).toBe(0);
  });

  it.each([
    [true, true, false, true],
    [true, false, false, false],
    [true, true, true, false],
    [false, false, false, true],
  ])(
    "reuses open-tab persistence for web=%s android=%s scheduled=%s",
    (isWebSurface, trustedAndroid, scheduledChild, allowed) => {
      const saveDesktopOpenTabs = vi.fn();
      const tab = {
        id: "one",
        rootDir: "/workspaces/one",
        currentSession: "saved",
        conversationViewId: "view-one",
      };
      compile(`${declaration(desktop, "persistOpenTabs")} persistOpenTabs();`, {
        isWebSurface,
        trustedAndroid,
        scheduledChild,
        saveDesktopOpenTabs,
        tabs: new Map([[tab.id, tab]]),
        lastActiveTabId: "one",
      });
      expect(saveDesktopOpenTabs).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (allowed)
        expect(saveDesktopOpenTabs).toHaveBeenCalledWith([
          {
            dir: "/workspaces/one",
            session: "saved",
            conversationViewId: "view-one",
            active: true,
          },
        ]);
    },
  );

  it("restores Android's saved focused view instead of overriding it with the host startup dir", () => {
    const declarations: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((item) =>
          ["savedTabs", "restorePlan"].includes(item.name.getText(desktop)),
        )
      )
        declarations.push(node.getText(desktop));
      else ts.forEachChild(node, visit);
    };
    visit(desktop);
    const saved = [
      { dir: "/workspaces/default", session: "a", conversationViewId: "view-a" },
      { dir: "/workspaces/other", session: "b", conversationViewId: "view-b", active: true },
    ];
    const restored = compile(`${declarations.join("\n")} return restorePlan;`, {
      isWebSurface: true,
      trustedAndroid: true,
      scheduledChild: false,
      loadDesktopOpenTabs: () => saved,
      resolveDesktopRoot: (dir: string) => dir,
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
      planDesktopTabRestore,
      opts: { dir: "/workspaces/default" },
    });
    expect(restored.tabs).toHaveLength(2);
    expect(restored.activeConversationViewId).toBe("view-b");
  });

  it("tracks btw until its own promise finishes even after its tab is removed", async () => {
    let finish!: (value: object) => void;
    const tab = {
      id: "one",
      currentModel: "test",
      runtime: {
        loop: {
          client: {
            chat: () =>
              new Promise((resolve) => {
                finish = resolve;
              }),
          },
        },
      },
    };
    const emit = vi.fn();
    const tabs = new Map([[tab.id, tab]]);
    const fixture = compile(
      `let androidBackgroundOperations = 0;
      ${declaration(desktop, "runBtwOnTab")}
      ${declaration(desktop, "readAndroidActivity")}
      return { btw: runBtwOnTab, active: readAndroidActivity };`,
      {
        emit,
        tabs,
        pendingRpc: 0,
        sharedCompactions: new Map(),
        scheduledEngine: undefined,
      },
    );
    fixture.btw(tab, "question");
    tabs.delete(tab.id);
    expect(fixture.active()).toBe(1);
    finish({ content: "answer" });
    await vi.waitFor(() => expect(fixture.active()).toBe(0));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "$btw_result" }), "one");
  });
});

describe("Android host private activity protocol", { retry: 0 }, () => {
  it("subscribes before send and correlates owner replies", async () => {
    const sidecar = new ActivitySidecar();
    expect(await requestAndroidActivity(sidecar, "android_activity")).toMatchObject({
      active: 0,
      idleReady: true,
    });
    expect(sidecar.commands[0]).toMatchObject({
      cmd: "android_activity",
      runtimeEpoch: "epoch-one",
    });
  });

  it.each(["timeout", "restart", "stale", "malformed", "noise", "exit", "send"])(
    "fails closed on %s",
    async (kind) => {
      vi.useFakeTimers();
      const sidecar = new ActivitySidecar();
      sidecar.respond = false;
      sidecar.beforeReply = (command) => {
        if (kind === "noise")
          sidecar.buffer.append({ channel: "rpc:event", payload: { data: "null" } });
        if (kind === "restart") {
          sidecar.runtimeEpoch = "two";
          sidecar.event({ type: "$runtime_restarted" });
        }
        if (kind === "stale" || kind === "malformed")
          sidecar.event({
            type: "$android_activity",
            requestId: command.requestId,
            runtimeEpoch: kind === "stale" ? "old" : "epoch-one",
            active: kind === "malformed" ? -1 : 0,
            idleReady: true,
          });
        if (kind === "exit") sidecar.buffer.append({ channel: "rpc:exit", payload: { code: 1 } });
        if (kind === "send") throw Error("write failed");
      };
      const task = requestAndroidActivity(sidecar, "android_activity", 10);
      const rejected = expect(task).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("queries the owner only inside the server close fence", async () => {
    const sidecar = new ActivitySidecar();
    let fenced = false;
    sidecar.beforeReply = () => expect(fenced).toBe(true);
    expect(
      await guardedAndroidIdleStop(
        {
          guardedClose: async (prepare) => {
            fenced = true;
            return prepare();
          },
        },
        sidecar,
      ),
    ).toBe(true);
    expect(sidecar.commands[0]?.cmd).toBe("android_guarded_idle_stop");
  });

  it("reports native guarded_idle_stop and exits only after an accepted close", async () => {
    const sidecar = new ActivitySidecar();
    const ordering: string[] = [];
    const input = new EventEmitter() as EventEmitter & { close(): void };
    input.close = () => {
      ordering.push("stdin-close");
      input.emit("close");
    };
    const packets: Record<string, any>[] = [];
    const close = vi.fn(async () => {
      ordering.push("http-sidecar-close");
    });
    const sampleIntervals: number[] = [];
    const handle = {
      url: "http://127.0.0.1:1234/#bootstrap=test",
      port: 1234,
      close,
      activityCount: () => 0,
      guardedClose: async (prepare: () => Promise<boolean>) => {
        if (!(await prepare())) return false;
        await close();
        return true;
      },
    };
    let create!: () => WebSidecar;
    const start = compile(`${declaration(host, "startAndroidHost")} return startAndroidHost;`, {
      getAndroidRuntimeContext: () => ({ role: "host", runId: "run-one" }),
      mkdir: async () => {},
      readdir: async () => [],
      loadWorkspaceDir: () => undefined,
      readConfig: () => ({}),
      installProxyIfConfigured: () => {},
      saveDashboardPort: () => {},
      WorkspaceRegistry: class {
        list() {
          return [];
        }
      },
      DesktopSidecar: function FakeDesktopSidecar() {
        return sidecar;
      },
      SupervisedSidecar: function FakeSupervisedSidecar(opts: { create: () => WebSidecar }) {
        create = opts.create;
        return opts.create();
      },
      startWebServer: async () => handle,
      requestAndroidActivity,
      guardedAndroidIdleStop,
      createInterface: () => input,
      setInterval: (callback: () => void, interval: number) => {
        sampleIntervals.push(interval);
        return setInterval(callback, interval);
      },
      join,
      relative,
      resolve,
      basename,
      DIRECTORY: /^(?:default|[0-9a-f-]{36})$/,
      UUID: /^[0-9a-f-]{36}$/,
      process: {
        env: {},
        argv: ["node", "app"],
        stdin: {},
        once: vi.fn(),
        off: vi.fn(),
        stdout: {
          write: (line: string) => {
            const packet = JSON.parse(line);
            packets.push(packet);
            if (packet.type === "android-result" && packet.result?.stopped === true)
              ordering.push("stopped-result");
          },
        },
      },
    });
    const task = start();
    const send = (command: string) => {
      const requestId = randomUUID();
      input.emit(
        "line",
        JSON.stringify({
          type: "android-control",
          version: 1,
          runId: "run-one",
          requestId,
          command,
        }),
      );
      return requestId;
    };
    try {
      await vi.waitFor(() => expect(packets.some((p) => p.type === "android-ready")).toBe(true));
      await vi.waitFor(() =>
        expect(
          packets.some(
            (p) => p.type === "android-activity" && p.idleReady === true && p.active === 0,
          ),
        ).toBe(true),
      );
      const queued = send("guarded_idle_stop");
      send("list_workspaces");
      await vi.waitFor(() =>
        expect(packets.find((p) => p.requestId === queued)?.result?.stopped).toBe(false),
      );
      expect(sidecar.commands.some((command) => command.cmd === "android_guarded_idle_stop")).toBe(
        false,
      );
      sidecar.active = 1;
      const busy = send("guarded_idle_stop");
      await vi.waitFor(() =>
        expect(packets.find((p) => p.requestId === busy)?.result?.stopped).toBe(false),
      );
      expect(close).not.toHaveBeenCalled();
      sidecar.active = 0;
      sidecar.beforeReply = (command) => {
        if (command.cmd === "android_guarded_idle_stop")
          expect(() => create()).toThrow(/idle shutdown/);
      };
      send("guarded_idle_stop");
      await task;
      expect(
        packets.some(
          (p) =>
            p.type === "android-result" &&
            p.ok &&
            p.result?.stopped === true &&
            p.runId === "run-one" &&
            p.version === 1,
        ),
      ).toBe(true);
      expect(close).toHaveBeenCalled();
      expect(sampleIntervals).toEqual([5000]);
      expect(ordering.indexOf("stopped-result")).toBeGreaterThan(
        ordering.indexOf("http-sidecar-close"),
      );
      expect(ordering.indexOf("stdin-close")).toBeGreaterThan(ordering.indexOf("stopped-result"));
    } finally {
      send("stop");
      await task;
    }
  });
});
