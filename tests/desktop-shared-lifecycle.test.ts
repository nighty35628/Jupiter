import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { DesktopTurnAdmission } from "../src/desktop/turn-admission.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { readSessionHistoryPage } from "../src/memory/session-history.js";
import { sessionWriterLockExists } from "../src/memory/session-writer-lock.js";
import {
  loadSessionMessages,
  loadSessionMeta,
  patchSessionMeta,
  rewriteSession,
  sessionPath,
} from "../src/memory/session.js";
import { SharedSessionCoordinator, type SharedTurnStorage } from "../src/memory/shared-session.js";
import { ToolRegistry } from "../src/tools.js";

const source = ts.createSourceFile(
  "desktop.ts",
  readFileSync("src/cli/commands/desktop.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
);

function extract(name: string): string {
  let result = "";
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(source);
    else ts.forEachChild(node, visit);
  }
  visit(source);
  expect(result).not.toBe("");
  return result;
}

interface TestTab {
  id: string;
  currentSession: string;
  sessionId: string;
  conversationViewId: string;
  rootDir: string;
  currentModel: string;
  system: string;
  hooks: never[];
  budgetUsd: null;
  sharedSession?: SharedSessionCoordinator;
  sharedStorage?: SharedTurnStorage;
  sharedClosing?: boolean;
  sharedTurnDone?: Promise<void>;
  bindingId: number;
  historyPaging: boolean;
  switching?: boolean;
  aborter: AbortController | null;
  runtime: { loop: CacheFirstLoop } | null;
  turnAdmission: DesktopTurnAdmission;
  prediction: { invalidate: ReturnType<typeof vi.fn> };
  toolset: { tools: ToolRegistry; jobs: { list: () => never[]; shutdown: () => Promise<void> } };
}

const owners = new Set<SharedSessionCoordinator>();
const loops = new Set<CacheFirstLoop>();

function fixture() {
  const tabs = new Map<string, TestTab>();
  const registry = new Map<string, SharedSessionCoordinator>();
  const emit = vi.fn();
  const snapshots = vi.fn();
  const fetch = vi.fn(async () => {
    throw new Error("Lifecycle transitions must not call the provider or replay tools");
  });
  const dependencies = {
    tabs,
    desktopLiveTabs: tabs,
    desktopSharedSessions: registry,
    SharedSessionCoordinator: class extends SharedSessionCoordinator {
      constructor(name: string, sessionId: string) {
        super(name, sessionId);
        owners.add(this);
      }
    },
    CacheFirstLoop: class extends CacheFirstLoop {
      constructor(options: ConstructorParameters<typeof CacheFirstLoop>[0]) {
        super(options);
        loops.add(this);
      }
    },
    ImmutablePrefix,
    Eventizer: class {},
    applyPlanMode: vi.fn(),
    loadDesktopEditMode: () => "review",
    resolveProviderSnapshot: () => ({}),
    createProviderClient: () => new DeepSeekClient({ apiKey: "synthetic", fetch }),
    providerSessionBinding: () => ({
      providerId: "synthetic",
      endpointIdentity: "https://synthetic.invalid/v1",
      label: "Synthetic",
      dialect: "deepseek",
      model: "deepseek-chat",
    }),
    loadSessionMeta,
    loadSessionMessages,
    readSessionHistoryPage,
    patchSessionMeta,
    loadReasoningEffort: () => undefined,
    loadThinkingEnabled: () => false,
    loadDeepSeekAutoContinue: () => false,
    getWorkspaceMutationRevision: () => 0,
    collectSessionFiles: () => [],
    abortTurn: vi.fn(),
    stopComputerUse: vi.fn(async () => {}),
    emit,
    emitCurrentSessionLoaded: snapshots,
    persistOpenTabs: vi.fn(),
    cancelPendingGates: vi.fn(),
    mintSessionFor: vi.fn(() => "new-chat"),
    loadModel: () => "deepseek-chat",
    ensureSessionId: (name: string) => `${name}-id`,
    patchSessionWorkspaceIfMissing: () => false,
    buildLoadedMessages: (records: unknown[]) => records,
    transcriptPayloadBytes: (records: unknown[]) => JSON.stringify(records).length,
    statSync,
    existsSync,
    resolveDesktopRoot: (path: string) => path,
    sessionPath,
    setTimeout,
    emitPendingGateEvents: vi.fn(),
    emitCtxBreakdown: vi.fn(),
    emitUsageHistory: vi.fn(),
    emitSessions: vi.fn(),
    emptySessionLoadedEvent: () => ({ type: "$session_loaded" }),
    first: undefined,
  };
  // Execute production lifecycle functions; replace only host services, not shared storage.
  const program = ts.transpileModule(
    `${[
      "buildRuntimeFor",
      "replaceRuntimeFor",
      "publishSharedTurn",
      "closeTab",
      "startNewChatInTab",
      "loadSessionIntoTab",
      "switchWorkspace",
      "historyPageInfo",
    ]
      .map(extract)
      .join("\n")}
    return { buildRuntimeFor, closeTab, startNewChatInTab, loadSessionIntoTab, switchWorkspace };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const handlers = new Function(...Object.keys(dependencies), program)(
    ...Object.values(dependencies),
  ) as {
    buildRuntimeFor(tab: TestTab): { loop: CacheFirstLoop };
    closeTab(tab: TestTab): Promise<void>;
    startNewChatInTab(tab: TestTab): void;
    loadSessionIntoTab(tab: TestTab, name: string, actions: typeof dependencies): Promise<void>;
    switchWorkspace(tab: TestTab, directory: string): Promise<void>;
  };
  const build = (tab: TestTab) => {
    tab.runtime = handlers.buildRuntimeFor(tab);
    loops.add(tab.runtime.loop);
    for (const owner of registry.values()) owners.add(owner);
    return tab.sharedSession!;
  };
  const open = (id: string, name = "shared"): TestTab => {
    const tab: TestTab = {
      id,
      currentSession: name,
      sessionId: `${name}-id`,
      conversationViewId: `${id}-view`,
      rootDir: "/synthetic/workspace",
      currentModel: "deepseek-chat",
      system: "Synthetic lifecycle fixture",
      hooks: [],
      budgetUsd: null,
      bindingId: 1,
      historyPaging: false,
      aborter: null,
      runtime: null,
      turnAdmission: new DesktopTurnAdmission(),
      prediction: { invalidate: vi.fn() },
      toolset: { tools: new ToolRegistry(), jobs: { list: () => [], shutdown: async () => {} } },
    };
    tabs.set(id, tab);
    build(tab);
    return tab;
  };
  const rebind = (tab: TestTab, name = "next") => {
    const previous = tab.runtime;
    tab.currentSession = name;
    tab.sessionId = `${name}-id`;
    const owner = build(tab);
    previous?.loop.dispose();
    return owner;
  };
  const failWithTools = (tab: TestTab) => {
    const store = tab.sharedStorage!;
    store.appendMessage({ role: "user", content: "private question" });
    store.appendMessage({
      role: "assistant",
      content: null,
      tool_calls: ["completed", "interrupted"].map((id) => ({
        id,
        type: "function" as const,
        function: { name: "write_once", arguments: "{}" },
      })),
    });
    store.appendMessage({ role: "tool", tool_call_id: "completed", content: "written once" });
    store.markFailed();
    return store;
  };
  return {
    ...handlers,
    tabs,
    registry,
    emit,
    snapshots,
    fetch,
    open,
    rebind,
    failWithTools,
    abortTurn: dependencies.abortTurn,
    stopComputerUse: dependencies.stopComputerUse,
    mintSession: dependencies.mintSessionFor,
    load: (tab: TestTab, name = "target") => {
      rewriteSession(name, [{ role: "user", content: "target history" }]);
      return handlers.loadSessionIntoTab(tab, name, dependencies);
    },
    running: (tab: TestTab) => {
      const generation = tab.turnAdmission.begin("agent")!;
      tab.aborter = new AbortController();
      let finish!: () => void;
      tab.sharedTurnDone = new Promise<void>((resolve) => {
        finish = resolve;
      });
      return () => {
        tab.aborter = null;
        tab.switching = false;
        tab.turnAdmission.finish(generation);
        finish();
        tab.sharedTurnDone = undefined;
      };
    },
  };
}

describe("desktop shared-session lifecycle", { retry: 0 }, () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jupiter-shared-lifecycle-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(home);
  });

  it("waits for a running turn before tearing down the old workspace", async () => {
    const f = fixture();
    const tab = f.open("a");
    const end = f.running(tab);
    f.stopComputerUse.mockRejectedValueOnce(new Error("stopped after turn settled"));
    const switching = f.switchWorkspace(tab, home);
    await Promise.resolve();
    expect(f.stopComputerUse).not.toHaveBeenCalled();
    expect(tab.rootDir).toBe("/synthetic/workspace");
    end();
    await expect(switching).rejects.toThrow("stopped after turn settled");
    expect(f.stopComputerUse).toHaveBeenCalledTimes(1);
  });

  it("keeps the old workspace and its failed turn when recovery cannot be committed", async () => {
    const f = fixture();
    const tab = f.open("a");
    const store = f.failWithTools(tab);
    vi.spyOn(store.owner, "commit").mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    await expect(f.switchWorkspace(tab, home)).rejects.toThrow("still unsaved");
    expect(tab.rootDir).toBe("/synthetic/workspace");
    expect(tab.currentSession).toBe("shared");
    expect(tab.sharedStorage).toBe(store);
    expect(f.stopComputerUse).not.toHaveBeenCalled();
  });
  afterEach(() => {
    for (const loop of loops) loop.dispose();
    for (const owner of owners) owner.dispose();
    loops.clear();
    owners.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("finalizes a stopped failed turn on close, notifies peers, and never replays tools", async () => {
    const f = fixture();
    const a = f.open("a");
    const b = f.open("b");
    const store = f.failWithTools(a);
    const owner = a.sharedSession!;
    await f.closeTab(a);
    const rows = loadSessionMessages("shared");
    expect(rows.filter((row) => row.content === "written once")).toHaveLength(1);
    expect(rows.find((row) => row.tool_call_id === "interrupted")?.content).toContain(
      "unknown_after_cancel",
    );
    expect(owner.activeTurns).toBe(0);
    expect(existsSync(store.path)).toBe(false);
    expect(f.tabs.has(a.id)).toBe(false);
    expect(f.tabs.has(b.id)).toBe(true);
    expect(sessionWriterLockExists(owner.sessionId)).toBe(true);
    expect(f.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "$shared_session_updated", sourceTurnId: store.turnId }),
      b.id,
    );
    expect(f.snapshots).toHaveBeenCalledWith(b, "resync");
    expect(b.prediction.invalidate).toHaveBeenCalled();
    await f.closeTab(a);
    expect(loadSessionMessages("shared")).toEqual(rows);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("waits for the closing turn to settle before committing its final tool outcome", async () => {
    const f = fixture();
    const a = f.open("a");
    f.open("b");
    const store = f.failWithTools(a);
    let settle!: () => void;
    a.sharedTurnDone = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const closing = f.closeTab(a);
    await Promise.resolve();
    expect(loadSessionMessages("shared")).toEqual([]);
    store.appendMessage({ role: "tool", tool_call_id: "interrupted", content: "late result" });
    settle();
    await closing;
    expect(
      loadSessionMessages("shared").find((row) => row.tool_call_id === "interrupted"),
    ).toMatchObject({ content: "late result" });
  });

  it("keeps an unsaved failed tab recoverable and permits a later close retry", async () => {
    const f = fixture();
    const a = f.open("a");
    f.open("b");
    const store = f.failWithTools(a);
    const commit = vi.spyOn(a.sharedSession!, "commit");
    commit.mockImplementationOnce(() => {
      throw Object.assign(new Error("Synthetic ENOSPC"), { code: "ENOSPC" });
    });
    await f.closeTab(a);
    expect(f.tabs.has(a.id)).toBe(true);
    expect(a.sharedClosing).toBe(false);
    expect(a.runtime).not.toBeNull();
    expect(existsSync(store.path)).toBe(true);
    expect(loadSessionMessages("shared")).toEqual([]);
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "$error" }), a.id);
    expect(f.emit.mock.calls.some(([event]) => event.type === "$tab_closed")).toBe(false);
    expect(f.abortTurn).not.toHaveBeenCalled();
    await f.closeTab(a);
    expect(f.tabs.has(a.id)).toBe(false);
    expect(loadSessionMessages("shared").filter((row) => row.role === "user")).toHaveLength(1);
  });

  it("releases the last empty view's coordinator and writer lease on close", async () => {
    const f = fixture();
    const a = f.open("a");
    const owner = a.sharedSession!;
    await f.closeTab(a);
    expect(sessionWriterLockExists(owner.sessionId)).toBe(false);
    expect(f.registry.has(owner.sessionId)).toBe(false);
  });

  it("marks a user-only failed request interrupted when closing its last view", async () => {
    const f = fixture();
    const a = f.open("a");
    const owner = a.sharedSession!;
    a.sharedStorage!.appendMessage({ role: "user", content: "unanswered" });
    a.sharedStorage!.markFailed();
    await f.closeTab(a);
    expect(loadSessionMessages("shared")).toEqual([
      expect.objectContaining({ role: "user", content: "unanswered" }),
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("Interrupted"),
      }),
    ]);
    expect(sessionWriterLockExists(owner.sessionId)).toBe(false);
    expect(f.registry.has(owner.sessionId)).toBe(false);
  });

  it("closing a failed view does not commit or cancel its active sibling", async () => {
    const f = fixture();
    const a = f.open("a");
    const b = f.open("b");
    f.failWithTools(a);
    const generation = b.turnAdmission.begin("agent")!;
    const store = b.sharedStorage!;
    store.appendMessage({ role: "user", content: "private sibling" });
    await f.closeTab(a);
    expect(b.turnAdmission.isCurrent(generation)).toBe(true);
    expect(store.staged.state).toBe("running");
    expect(loadSessionMessages("shared").some((row) => row.content === "private sibling")).toBe(
      false,
    );
    store.appendMessage({ role: "assistant", content: "sibling answer" });
    b.sharedSession!.commit(store);
    expect(loadSessionMessages("shared").at(-1)?.content).toBe("sibling answer");
  });

  it("disposes the previous coordinator when its last view rebinds", () => {
    const f = fixture();
    const a = f.open("a");
    const previous = a.sharedSession!;
    const next = f.rebind(a);
    expect(a.sharedSession).toBe(next);
    expect(sessionWriterLockExists(previous.sessionId)).toBe(false);
    expect(f.registry.has(previous.sessionId)).toBe(false);
    expect(sessionWriterLockExists(next.sessionId)).toBe(true);
  });

  it("preserves the previous coordinator and an active sibling's private turn on rebind", () => {
    const f = fixture();
    const a = f.open("a");
    const b = f.open("b");
    const previous = b.sharedSession!;
    const generation = b.turnAdmission.begin("agent")!;
    b.sharedStorage!.appendMessage({ role: "user", content: "sibling still working" });
    f.rebind(a);
    expect(f.registry.get(previous.sessionId)).toBe(previous);
    expect(sessionWriterLockExists(previous.sessionId)).toBe(true);
    expect(b.turnAdmission.isCurrent(generation)).toBe(true);
    expect(b.sharedStorage!.staged.state).toBe("running");
    b.sharedStorage!.appendMessage({ role: "assistant", content: "sibling finished" });
    previous.commit(b.sharedStorage!);
    expect(loadSessionMessages("shared").map((row) => row.content)).toEqual([
      "sibling still working",
      "sibling finished",
    ]);
  });

  it("finalizes a detached failed view and notifies only peers of its old session", () => {
    const f = fixture();
    const a = f.open("a");
    const b = f.open("b");
    const unrelated = f.open("unrelated", "other");
    const store = f.failWithTools(a);
    const previous = a.sharedSession!;
    f.rebind(a);
    expect(previous.activeTurns).toBe(0);
    expect(existsSync(store.path)).toBe(false);
    expect(loadSessionMessages("shared").some((row) => row.content === "written once")).toBe(true);
    expect(f.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "$shared_session_updated",
        sessionId: previous.sessionId,
        sourceTurnId: store.turnId,
      }),
      b.id,
    );
    expect(f.snapshots).toHaveBeenCalledWith(b, "resync");
    expect(f.snapshots).not.toHaveBeenCalledWith(unrelated, "resync");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("does not detach the failed store or release its lock if rebind persistence fails", () => {
    const f = fixture();
    const a = f.open("a");
    const store = f.failWithTools(a);
    const previous = a.sharedSession!;
    vi.spyOn(previous, "commit").mockImplementationOnce(() => {
      throw new Error("Synthetic commit failure");
    });
    expect(() => f.rebind(a)).toThrow(/commit failure|unsaved/i);
    expect(a.sharedSession).toBe(previous);
    expect(a.sharedStorage).toBe(store);
    expect(f.registry.get(previous.sessionId)).toBe(previous);
    expect(sessionWriterLockExists(previous.sessionId)).toBe(true);
    expect(existsSync(store.path)).toBe(true);
  });

  it("refuses to detach a view whose own turn has not settled", () => {
    const f = fixture();
    const a = f.open("a");
    const previous = a.sharedSession!;
    const store = a.sharedStorage!;
    a.turnAdmission.begin("agent");
    store.appendMessage({ role: "user", content: "still running" });
    expect(() => f.rebind(a)).toThrow(/turn.*stop|unfinished/i);
    expect(a.sharedSession).toBe(previous);
    expect(a.sharedStorage).toBe(store);
    expect(store.staged.state).toBe("running");
    expect(sessionWriterLockExists(previous.sessionId)).toBe(true);
  });

  it("new_chat waits for the current turn before changing identity and releasing its lock", async () => {
    const f = fixture();
    const a = f.open("a");
    const previous = a.sharedSession!;
    const store = f.failWithTools(a);
    const finish = f.running(a);
    f.startNewChatInTab(a);
    expect(a.currentSession).toBe("shared");
    expect(a.sessionId).toBe("shared-id");
    expect(a.bindingId).toBe(1);
    expect(f.mintSession).not.toHaveBeenCalled();
    store.appendMessage({ role: "tool", tool_call_id: "interrupted", content: "late result" });
    finish();
    await vi.waitFor(() => expect(a.currentSession).toBe("new-chat"));
    expect(a.bindingId).toBe(2);
    expect(a.sharedSession).not.toBe(previous);
    expect(sessionWriterLockExists(previous.sessionId)).toBe(false);
    expect(loadSessionMessages("shared").some((row) => row.content === "late result")).toBe(true);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])("session load waits before rebinding (paging=%s)", async (paging) => {
    const f = fixture();
    const a = f.open("a");
    const previous = a.sharedSession!;
    const store = f.failWithTools(a);
    a.historyPaging = paging;
    const finish = f.running(a);
    const loading = f.load(a);
    await vi.waitFor(() => expect(f.abortTurn).toHaveBeenCalled());
    expect(a.currentSession).toBe("shared");
    expect(a.bindingId).toBe(1);
    expect(a.turnAdmission.running).toBe(true);
    store.appendMessage({ role: "tool", tool_call_id: "interrupted", content: "late result" });
    finish();
    await loading;
    expect(a.currentSession).toBe("target");
    expect(a.sessionId).toBe("target-id");
    expect(a.bindingId).toBe(2);
    expect(sessionWriterLockExists(previous.sessionId)).toBe(false);
    expect(a.runtime!.loop.log.toFullHistory()[0]?.content).toBe("target history");
    expect(loadSessionMessages("shared").some((row) => row.content === "late result")).toBe(true);
  });

  it.each(["new_chat", "load"] as const)(
    "%s preserves identity and retry state when the stopped turn cannot be committed",
    async (entrypoint) => {
      const f = fixture();
      const a = f.open("a");
      const store = f.failWithTools(a);
      const runtime = a.runtime;
      const previous = a.sharedSession!;
      vi.spyOn(previous, "commit").mockImplementationOnce(() => {
        throw new Error("ENOSPC");
      });
      if (entrypoint === "load") await expect(f.load(a)).rejects.toThrow("ENOSPC");
      else f.startNewChatInTab(a);
      expect(a.currentSession).toBe("shared");
      expect(a.sessionId).toBe("shared-id");
      expect(a.bindingId).toBe(1);
      expect(a.runtime).toBe(runtime);
      expect(a.sharedStorage).toBe(store);
      expect(a.switching).not.toBe(true);
      expect(f.abortTurn).not.toHaveBeenCalled();
      expect(existsSync(store.path)).toBe(true);
      expect(sessionWriterLockExists(previous.sessionId)).toBe(true);
    },
  );

  it.each(["new_chat", "load"] as const)(
    "%s discards a stale deferred switch after another binding replaces it",
    async (entrypoint) => {
      const f = fixture();
      const a = f.open("a");
      const finish = f.running(a);
      const loading = entrypoint === "load" ? f.load(a) : undefined;
      if (entrypoint === "new_chat") f.startNewChatInTab(a);
      await Promise.resolve();
      a.bindingId++;
      a.currentSession = "newer-binding";
      a.sessionId = "newer-binding-id";
      finish();
      await loading;
      await Promise.resolve();
      expect(a.currentSession).toBe("newer-binding");
      expect(a.sessionId).toBe("newer-binding-id");
      expect(f.mintSession).not.toHaveBeenCalled();
    },
  );

  it("new_chat reports a recovery-write failure without throwing or changing identity", () => {
    const f = fixture();
    const a = f.open("a");
    const store = f.failWithTools(a);
    vi.spyOn(a.sharedSession!, "commit").mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    vi.spyOn(store, "markFailed").mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    expect(() => f.startNewChatInTab(a)).not.toThrow();
    expect(a.currentSession).toBe("shared");
    expect(a.bindingId).toBe(1);
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "$error" }), a.id);
  });

  it("new_chat does not replace a view that is already closing", () => {
    const f = fixture();
    const a = f.open("a");
    a.sharedClosing = true;
    f.startNewChatInTab(a);
    expect(a.currentSession).toBe("shared");
    expect(f.mintSession).not.toHaveBeenCalled();
  });

  it("session load refuses an uncommitted no-op before changing identity", async () => {
    const f = fixture();
    const a = f.open("a");
    const store = f.failWithTools(a);
    vi.spyOn(a.sharedSession!, "commit").mockReturnValueOnce(false);
    await expect(f.load(a)).rejects.toThrow(/unsaved/i);
    expect(a.currentSession).toBe("shared");
    expect(a.bindingId).toBe(1);
    expect(a.sharedStorage).toBe(store);
    expect(f.abortTurn).not.toHaveBeenCalled();
  });
});
