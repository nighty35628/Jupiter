import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionMessages } from "../src/memory/session.js";
import { SharedSessionCoordinator } from "../src/memory/shared-session.js";

const source = ts.createSourceFile(
  "desktop.ts",
  readFileSync("src/cli/commands/desktop.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
function productionFunction(name: string): string {
  let text = "";
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(source);
    else ts.forEachChild(node, visit);
  };
  visit(source);
  expect(text).not.toBe("");
  return text;
}
function compile(names: string[], dependencies: Record<string, unknown>) {
  const code = ts.transpileModule(names.map(productionFunction).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${code}; return ${names.at(-1)};`)(
    ...Object.values(dependencies),
  );
}

describe("desktop shared history command entrances", { retry: 0 }, () => {
  const owners: SharedSessionCoordinator[] = [];
  const homes: string[] = [];
  afterEach(() => {
    for (const owner of owners.splice(0)) owner.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });
  function setup() {
    const home = mkdtempSync(join(tmpdir(), "jupiter-shared-commands-"));
    homes.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(home);
    const owner = new SharedSessionCoordinator("chat", "session-id");
    owners.push(owner);
    for (const id of ["first", "second"]) {
      const turn = owner.beginTurn("a", id);
      turn.appendMessage({ role: "user", content: id });
      turn.appendMessage({ role: "assistant", content: `answer ${id}` });
      owner.commit(turn);
    }
    const a = {
      id: "a",
      sessionId: "session-id",
      currentSession: "chat",
      sharedSession: owner,
      sharedStorage: owner.beginTurn("a"),
      turnAdmission: { running: false },
      runtime: { loop: { rollbackLatestTurn: vi.fn(() => true) } },
    };
    const b = { ...a, id: "b", sharedStorage: owner.beginTurn("b") };
    return {
      owner,
      a,
      b,
      tabs: new Map([
        ["a", a],
        ["b", b],
      ]),
    };
  }
  it("rewinds canonical history, refreshes every idle view and never uses private rollback", () => {
    const { owner, a, b, tabs } = setup();
    const replaceRuntimeFor = vi.fn();
    const emitCurrentSessionLoaded = vi.fn();
    const rewind = compile(["desktopRewindLatestConversation"], {
      desktopLiveTabs: tabs,
      loadSessionMessages,
      replaceRuntimeFor,
      emitCurrentSessionLoaded,
      emitCtxBreakdown: vi.fn(),
    });
    const version = owner.version;
    expect(rewind(a)).toBe(true);
    expect(owner.version).toBe(version + 1);
    expect(loadSessionMessages("chat").map((row) => row.content)).toEqual([
      "first",
      "answer first",
    ]);
    expect(a.runtime.loop.rollbackLatestTurn).not.toHaveBeenCalled();
    expect(replaceRuntimeFor.mock.calls).toEqual([[a], [b]]);
    expect(emitCurrentSessionLoaded).toHaveBeenCalledTimes(2);
  });
  it("does not rewind shared history while a sibling is running or has a pending failure", () => {
    const { owner, a, b, tabs } = setup();
    const rewind = compile(["desktopRewindLatestConversation"], { desktopLiveTabs: tabs });
    b.turnAdmission.running = true;
    expect(rewind(a)).toBe(false);
    b.turnAdmission.running = false;
    b.sharedStorage.appendMessage({ role: "user", content: "failed turn" });
    b.sharedStorage.markFailed();
    expect(rewind(a)).toBe(false);
    expect(owner.version).toBe(2);
  });
  it("routes slash compaction through the canonical versioned helper", async () => {
    const { owner, a, tabs } = setup();
    let projected = loadSessionMessages("chat");
    Object.assign(a.runtime.loop, {
      log: { toFullHistory: () => projected },
      manualCompactHistory: vi.fn(async () => {
        projected = [{ role: "assistant", content: "summary" }];
        return { folded: true };
      }),
    });
    const finish = vi.fn();
    const emit = vi.fn();
    const handleSlash = vi.fn();
    const compact = compile(["compactSharedHistory", "handleDesktopSlash"], {
      tabs,
      sharedCompactions: new Map(),
      parseSlash: () => ({ cmd: "compact", args: [] }),
      resolveSlashAlias: (name: string) => name,
      refreshSharedTurn: vi.fn(),
      emit,
      handleSlash,
      emitCurrentSessionLoaded: vi.fn(),
      emitCompactResult: vi.fn(),
      emitCtxBreakdown: vi.fn(),
      finishDesktopCommand: finish,
    });
    compact(a, "/compact");
    await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
    expect(emit).not.toHaveBeenCalled();
    expect(handleSlash).not.toHaveBeenCalled();
    expect(owner.version).toBe(3);
    expect(loadSessionMessages("chat")).toEqual([{ role: "assistant", content: "summary" }]);
    const next = owner.beginTurn("c");
    expect(next.loadMessages()).toEqual([{ role: "assistant", content: "summary" }]);
  });
  it("refuses slash compaction while the tab is busy and completes the command", async () => {
    const { a } = setup();
    a.turnAdmission.running = true;
    const emit = vi.fn();
    const finishDesktopCommand = vi.fn();
    const compact = compile(["handleDesktopSlash"], {
      parseSlash: () => ({ cmd: "compact", args: [] }),
      resolveSlashAlias: (name: string) => name,
      emit,
      finishDesktopCommand,
    });
    compact(a, "/compact");
    await vi.waitFor(() => expect(finishDesktopCommand).toHaveBeenCalledTimes(1));
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "$error", message: expect.stringContaining("active turn") }),
      "a",
    );
  });
});
