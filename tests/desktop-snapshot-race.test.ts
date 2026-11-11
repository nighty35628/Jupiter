import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const ast = ts.createSourceFile(
  "desktop.ts",
  readFileSync("src/cli/commands/desktop.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
function declaration(name: string) {
  let text = "";
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(ast);
    else ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(text).not.toBe("");
  return text;
}
function compile(code: string, deps: Record<string, unknown>) {
  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(deps), js)(...Object.values(deps));
}

describe("superseded history snapshots", { retry: 0 }, () => {
  it.each(["superseded", "stale", "io-error"])(
    "handles %s bootstrap restore without leaking stale errors",
    async (outcome) => {
      let initializer = "";
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "historyRestore")
          initializer = node.getText(ast);
        ts.forEachChild(node, visit);
      };
      visit(ast);
      expect(initializer).not.toBe("");
      let reject!: (error: Error) => void;
      const pending = new Promise<never>((_resolve, fail) => {
        reject = fail;
      });
      const read = vi
        .fn()
        .mockReturnValueOnce(pending)
        .mockResolvedValue({ type: "$session_loaded", name: "chat", snapshot: { bindingId: 1 } });
      const emit = vi.fn();
      const tab = { id: "t1", currentSession: "chat", bindingId: 1, sessionId: "chat-id" };
      const deps = {
        tab,
        tabs: new Map([[tab.id, tab]]),
        bootstrapBinding: 1,
        bootstrapSession: "chat",
        restore: {},
        currentSessionSnapshot: read,
        emit,
        emitPendingGateEvents: vi.fn(),
      };
      const result = compile(
        `${declaration("emitCurrentSessionLoaded")} const ${initializer}; return historyRestore;`,
        deps,
      );
      if (outcome === "superseded") {
        tab.bindingId++;
        tab.currentSession = "other";
      }
      reject(
        Object.assign(new Error("read failed"), {
          code: outcome === "io-error" ? "EIO" : "SESSION_SNAPSHOT_STALE",
        }),
      );
      await result;
      const types = emit.mock.calls.map(([event]) => event.type);
      expect(types.includes("$error")).toBe(outcome === "io-error");
      expect(types.includes("$session_loaded")).toBe(outcome === "stale");
      expect(read).toHaveBeenCalledTimes(outcome === "stale" ? 2 : 1);
    },
  );

  it("retries a stale generation refresh before enabling the loaded session", async () => {
    const noop = vi.fn();
    const tab = {
      id: "t1",
      currentSession: "before",
      bindingId: 1,
      rootDir: "/qa",
      turnAdmission: { running: false, invalidate: noop },
      toolset: {},
      runtime: null,
    };
    const read = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("Shared history changed during history read"), {
          code: "SESSION_SNAPSHOT_STALE",
        }),
      )
      .mockResolvedValue({ type: "$session_loaded", name: "chat", snapshot: { bindingId: 2 } });
    const emit = vi.fn();
    const deps = {
      currentSessionSnapshot: read,
      emit,
      emitPendingGateEvents: noop,
      readSessionHistoryPage: vi
        .fn()
        .mockResolvedValueOnce({ records: [], generation: "old" })
        .mockResolvedValue({ records: [], generation: "new" }),
      patchSessionWorkspaceIfMissing: () => false,
      loadSessionMeta: () => ({}),
      ensureSessionId: () => "chat-id",
      buildLoadedMessages: () => [{ role: "user", content: "synthetic" }],
      collectSessionFiles: () => [],
      historyPageInfo: () => ({}),
      transcriptPayloadBytes: () => 1,
      buildRuntimeFor: () => ({}),
      emitCtxBreakdown: noop,
      emitUsageHistory: noop,
      emitSessions: noop,
    };
    const run = compile(
      `${declaration("emitCurrentSessionLoaded")} ${declaration("loadSessionIntoTab")} return loadSessionIntoTab;`,
      deps,
    );
    await run(tab, "chat", { abortTurn: noop, cancelPendingGates: noop, persistOpenTabs: noop });
    expect(read).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual([
      "$session_loaded",
      "$session_loaded",
      "$ready",
    ]);
  });

  it.each(["recovered", "stale", "io-error"])(
    "handles %s startup resync through the shared snapshot entrance",
    async (outcome) => {
      const source = ts.createSourceFile(
        "desktop.ts",
        readFileSync("src/cli/commands/desktop.ts", "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      let helper = "";
      let branch = "";
      const visit = (node: ts.Node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === "emitCurrentSessionLoaded")
          helper = node.getText(source);
        if (
          ts.isIfStatement(node) &&
          node.expression.getText(source) === 'msg.cmd === "desktop_resync"'
        )
          branch = node.getText(source);
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(helper).not.toBe("");
      expect(branch).not.toBe("");
      const tab = {
        id: "t1",
        currentSession: "chat",
        sessionId: "chat-id",
        bindingId: 1,
        runtime: {},
      };
      const read = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("Shared history changed during history read"), {
            code: "SESSION_SNAPSHOT_STALE",
          }),
        )
        .mockResolvedValue({ type: "$session_loaded", name: "chat", snapshot: { bindingId: 1 } });
      if (outcome !== "recovered")
        read.mockRejectedValueOnce(
          Object.assign(new Error("read failed"), {
            code: outcome === "stale" ? "SESSION_SNAPSHOT_STALE" : "EIO",
          }),
        );
      const emit = vi.fn();
      const deps = {
        currentSessionSnapshot: read,
        emit,
        emitPendingGateEvents: vi.fn(),
        randomUUID: () => "snapshot",
        emitAtomicDesktopSnapshot: (callback: () => Promise<void>) => callback(),
        loadApiKey: () => "synthetic",
        tabs: new Map([[tab.id, tab]]),
        lastActiveTabId: tab.id,
        emitSessions: vi.fn(),
        emitSettings: vi.fn(),
        emitMcpSpecs: vi.fn(),
        emitSkills: vi.fn(),
        emitMemory: vi.fn(),
        emitLibrary: vi.fn(),
        emitQQSettings: vi.fn(),
        emitUsageHistory: vi.fn(),
        emitBalance: vi.fn(),
        emitCtxBreakdown: vi.fn(),
        predictionIdentity: () => null,
        desktopIntegrationsAllowed: false,
      };
      const code = ts.transpileModule(`${helper}\nasync function run(msg: any) { ${branch} }`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const run = new Function(...Object.keys(deps), `${code}; return run;`)(
        ...Object.values(deps),
      );
      await run({ cmd: "desktop_resync", historyPaging: true });
      expect(read).toHaveBeenCalledTimes(2);
      const types = emit.mock.calls.map(([event]) => event.type);
      expect(types.includes("$session_loaded")).toBe(outcome === "recovered");
      expect(types.includes("$ready")).toBe(outcome === "recovered");
      expect(types.includes("$error")).toBe(outcome === "io-error");
      expect(emit.mock.calls.at(-1)?.[0].type).toBe("$resync_complete");
    },
  );

  it("does not retry into a new binding or render an obsolete read as an error", async () => {
    const source = ts.createSourceFile(
      "desktop.ts",
      readFileSync("src/cli/commands/desktop.ts", "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    let body = "";
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "emitCurrentSessionLoaded")
        body = node.getText(source);
      else ts.forEachChild(node, visit);
    };
    visit(source);
    const code = ts.transpileModule(body, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const read = vi.fn(() => pending);
    const emit = vi.fn();
    const run = new Function(
      "currentSessionSnapshot",
      "emit",
      "emitPendingGateEvents",
      `${code}; return emitCurrentSessionLoaded;`,
    )(read, emit, vi.fn());
    const tab = { currentSession: "before", sessionId: "before-id", bindingId: 1 };
    const result = run(tab);
    tab.currentSession = "after";
    tab.sessionId = "after-id";
    tab.bindingId++;
    reject(new Error("Session changed during history read"));
    expect(await result).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });
});
