import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheFirstLoop } from "../src/loop.js";
import type { PersistentLoopSessionStorage } from "../src/memory/compaction-checkpoint.js";
import type { ToolExecutionJournal } from "../src/memory/tool-execution-journal.js";
import type { ChatMessage } from "../src/types.js";

const fixture = vi.hoisted(() => ({ home: undefined as string | undefined }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => {
      if (!fixture.home) throw new Error("Lifecycle review fixture HOME is not initialized");
      return fixture.home;
    },
  };
});

const SESSION = "lifecycle-review";
const SYSTEM = "synthetic rules A";
const HOME_PREFIX = "jupiter-context-lifecycle-review-";
const fingerprint = (system: string) => JSON.stringify({ system, shots: [] });
const turns = (count: number): ChatMessage[] =>
  Array.from({ length: count }, (_, index): ChatMessage[] => [
    { role: "user", content: `synthetic question ${index + 1}` },
    { role: "assistant", content: `synthetic answer ${index + 1}` },
  ]).flat();

type LoopInternals = {
  _toolJournal: ToolExecutionJournal | null;
  sessionStorage: PersistentLoopSessionStorage;
};
const internals = (loop: CacheFirstLoop) => loop as unknown as LoopInternals;

function removeFixtureHome(home: string | undefined): void {
  if (!home) return;
  if (!basename(home).startsWith(HOME_PREFIX) || dirname(home) !== tmpdir())
    throw new Error("Refusing cleanup outside the lifecycle fixture directory");
  rmSync(home, { recursive: true, force: true });
}

describe("reviewed context lifecycle regressions", { retry: 0 }, () => {
  let Loop: typeof import("../src/loop.js").CacheFirstLoop;
  let Client: typeof import("../src/client.js").DeepSeekClient;
  let Prefix: typeof import("../src/memory/runtime.js").ImmutablePrefix;
  let Storage: typeof import("../src/memory/compaction-checkpoint.js").PersistentLoopSessionStorage;
  let checkpointPath: (name: string) => string;
  let session: typeof import("../src/memory/session.js");
  let loops: CacheFirstLoop[];
  let stores: PersistentLoopSessionStorage[];
  let forbiddenFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fixture.home = mkdtempSync(join(tmpdir(), HOME_PREFIX));
    vi.stubEnv("HOME", fixture.home);
    vi.stubEnv("USERPROFILE", fixture.home);
    loops = [];
    stores = [];
    forbiddenFetch = vi.fn(async () => {
      throw new Error("Lifecycle regression tests must not access the network");
    });
    vi.stubGlobal("fetch", forbiddenFetch);
    // Import production modules only after the hoisted HOME guard is armed.
    ({ CacheFirstLoop: Loop } = await import("../src/loop.js"));
    ({ DeepSeekClient: Client } = await import("../src/client.js"));
    ({ ImmutablePrefix: Prefix } = await import("../src/memory/runtime.js"));
    ({ PersistentLoopSessionStorage: Storage, compactionCheckpointPath: checkpointPath } =
      await import("../src/memory/compaction-checkpoint.js"));
    session = await import("../src/memory/session.js");
    expect(session.sessionPath(SESSION)).toBe(
      join(fixture.home, ".jupiter", "sessions", `${SESSION}.jsonl`),
    );
  });

  afterEach(() => {
    try {
      for (const loop of loops ?? []) loop.dispose();
      for (const store of stores ?? []) store.dispose();
      expect(forbiddenFetch).not.toHaveBeenCalled();
    } finally {
      try {
        removeFixtureHome(fixture.home);
      } finally {
        fixture.home = undefined;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    }
  });

  function seed(raw: ChatMessage[] = turns(2)): void {
    session.rewriteSession(SESSION, raw);
    session.patchSessionMeta(SESSION, { sessionId: "synthetic-lifecycle-session" });
  }

  function makeLoop(opts: { session?: string; rebuildSystem?: () => string } = {}): CacheFirstLoop {
    const loop = new Loop({
      session: opts.session ?? SESSION,
      client: new Client({
        apiKey: "synthetic-lifecycle-key",
        fetch: forbiddenFetch as unknown as typeof fetch,
        retry: { maxAttempts: 1 },
      }),
      prefix: new Prefix({ system: SYSTEM }),
      model: "synthetic-lifecycle-model",
      thinkingEnabled: false,
      stream: false,
      rebuildSystem: opts.rebuildSystem,
    });
    loops.push(loop);
    return loop;
  }

  function makeStorage(): PersistentLoopSessionStorage {
    const store = new Storage(SESSION);
    stores.push(store);
    store.beginRules(fingerprint(SYSTEM));
    return store;
  }

  function acceptFold(store: PersistentLoopSessionStorage, count: number): void {
    const before = store.loadMessages();
    const summary: ChatMessage = { role: "assistant", content: "synthetic accepted recap" };
    store.rewriteMessages([summary, ...before.slice(count)], "context");
    expect(store.recordFold({ before, head: before.slice(0, count), summary })).toBe(true);
  }

  it("preserves retained raw tool results when rolling back a healed projection", () => {
    const raw: ChatMessage[] = [
      { role: "user", content: "synthetic old question" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "synthetic-call",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "synthetic-call", content: "ORIGINAL_RAW_TOOL_RESULT" },
      { role: "user", content: "synthetic latest question to drop" },
      { role: "assistant", content: "synthetic latest answer to drop" },
    ];
    seed(raw);
    const store = makeStorage();
    const healed = structuredClone(raw);
    healed[2]!.content = "THINNED_CONTEXT_ONLY";
    store.rewriteMessages(healed, "context");
    expect(session.loadSessionMessages(SESSION)).toEqual(raw);
    store.rewriteMessages(healed.slice(0, 3), "history");
    expect(session.loadSessionMessages(SESSION)).toEqual(raw.slice(0, 3));
  });

  it("rebinds the execution journal when switching to a different logical session", () => {
    seed();
    const loop = makeLoop();
    const next = "synthetic-next-session";
    loop.rebindSession(next, { logicalSessionChanged: true });
    const expectedPath = session
      .sessionPath(next)
      .replace(/\.jsonl$/, ".tool-executions.v2.journal");
    expect(internals(loop).sessionStorage.journal.path).toBe(expectedPath);
    expect(internals(loop)._toolJournal?.path).toBe(expectedPath);
  });

  it("rebuilds live identity, journal and checkpoint publication after clearLog", () => {
    seed();
    const loop = makeLoop();
    const oldIdentity = session.loadSessionMeta(SESSION).sessionId;
    expect(loop.clearLog().archived).toBeTruthy();
    loop.appendAndPersist({ role: "user", content: "synthetic new question" });
    loop.appendAndPersist({ role: "assistant", content: "synthetic new answer" });
    const identity = session.loadSessionMeta(SESSION).sessionId;
    expect.soft(identity).toBeTruthy();
    expect.soft(identity).not.toBe(oldIdentity);
    expect
      .soft(internals(loop)._toolJournal?.path)
      .toBe(session.sessionPath(SESSION).replace(/\.jsonl$/, ".tool-executions.v2.journal"));
    const store = internals(loop).sessionStorage;
    acceptFold(store, 2);
    expect(store.publishCompaction()).toBe(true);
  });

  it("publishes refreshed system rules under the new checkpoint fingerprint", () => {
    seed();
    const loop = makeLoop();
    loop.refreshToolset("synthetic rules B");
    const store = internals(loop).sessionStorage;
    acceptFold(store, 2);
    expect(store.publishCompaction()).toBe(true);
    const checkpoint = JSON.parse(readFileSync(checkpointPath(SESSION), "utf8"));
    expect(checkpoint.rules).toBe(
      createHash("sha256").update(fingerprint("synthetic rules B")).digest("hex"),
    );
  });

  it("keeps raw turn numbering after checkpoint restore and latest-turn rollback", () => {
    seed(turns(4));
    const store = makeStorage();
    acceptFold(store, 4);
    expect(store.publishCompaction()).toBe(true);
    store.dispose();
    const loop = makeLoop();
    expect(loop.currentTurn).toBe(4);
    expect(loop.rollbackLatestTurn()).toBe(true);
    expect(session.loadSessionMessages(SESSION).filter((row) => row.role === "user")).toHaveLength(
      3,
    );
    expect.soft(loop.currentTurn).toBe(3);
    expect(loop.beginLightAsk("synthetic replacement question").turn).toBe(4);
  });

  it("preserves the source binding and append destination after a target writer-lock conflict", () => {
    seed();
    const loop = makeLoop();
    const target = "synthetic-busy-target";
    const targetRaw = turns(1);
    session.rewriteSession(target, targetRaw);
    session.patchSessionMeta(target, { sessionId: "synthetic-busy-target-identity" });
    makeLoop({ session: target });
    const sourceStorage = internals(loop).sessionStorage;
    const sourceJournal = internals(loop)._toolJournal;

    expect(() => loop.rebindSession(target, { logicalSessionChanged: true })).toThrow(
      /already writable/,
    );
    expect.soft(loop.sessionName).toBe(SESSION);
    expect.soft(internals(loop).sessionStorage).toBe(sourceStorage);
    expect.soft(internals(loop)._toolJournal).toBe(sourceJournal);
    loop.appendAndPersist({ role: "user", content: "synthetic append after refused rebind" });
    expect(session.loadSessionMessages(SESSION).at(-1)?.content).toBe(
      "synthetic append after refused rebind",
    );
    expect(session.loadSessionMessages(target)).toEqual(targetRaw);
  });

  it("publishes workspace-rebuilt rules under the new checkpoint fingerprint", () => {
    seed();
    const loop = makeLoop({ rebuildSystem: () => "synthetic workspace rules B" });
    const next = "synthetic-next-workspace";
    loop.switchWorkspace({ sessionName: next });
    expect(loop.prefix.system).toBe("synthetic workspace rules B");
    loop.appendAndPersist({ role: "user", content: "synthetic workspace question" });
    loop.appendAndPersist({ role: "assistant", content: "synthetic workspace answer" });
    const store = internals(loop).sessionStorage;
    acceptFold(store, 2);
    expect(store.publishCompaction()).toBe(true);
    const checkpoint = JSON.parse(readFileSync(checkpointPath(next), "utf8"));
    expect(checkpoint.rules).toBe(
      createHash("sha256").update(fingerprint("synthetic workspace rules B")).digest("hex"),
    );
  });
});
