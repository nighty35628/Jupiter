import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PersistentLoopSessionStorage,
  compactionCheckpointPath,
} from "../src/memory/compaction-checkpoint.js";
import { SessionWriterLease } from "../src/memory/session-writer-lock.js";
import {
  deleteArchivedSession,
  loadSessionMessages,
  moveSessionToArchive,
  patchSessionMeta,
  renameSession,
  restoreArchivedSession,
  rewriteSession,
  sessionPath,
} from "../src/memory/session.js";
import { SharedSessionCoordinator, type SharedTurnStorage } from "../src/memory/shared-session.js";
import type { ChatMessage } from "../src/types.js";

const fixture = vi.hoisted(() => ({ home: undefined as string | undefined }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => {
      if (!fixture.home) throw new Error("Compaction fixture HOME is not initialized");
      return fixture.home;
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const raw: ChatMessage[] = [
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "second question" },
  { role: "assistant", content: "second answer" },
];
const summary: ChatMessage = { role: "assistant", content: "semantic recap" };

function fold(
  store: SharedTurnStorage | PersistentLoopSessionStorage,
  count = 2,
  recap = summary,
): boolean {
  const before = store.loadMessages();
  store.rewriteMessages([recap, ...before.slice(count)], "context");
  return store.recordFold({ before, head: before.slice(0, count), summary: recap });
}

describe("semantic compaction persistence", { retry: 0 }, () => {
  let home: string;
  let owner: SharedSessionCoordinator | undefined;
  let adapters: PersistentLoopSessionStorage[];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jupiter-compaction-"));
    fixture.home = home;
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    adapters = [];
    expect(sessionPath("chat")).toBe(join(home, ".jupiter", "sessions", "chat.jsonl"));
    rewriteSession("chat", raw);
    patchSessionMeta("chat", { sessionId: "identity" });
  });
  afterEach(() => {
    owner?.dispose();
    for (const adapter of adapters) adapter.dispose?.();
    owner = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    fixture.home = undefined;
  });
  function shared(id = "a") {
    owner ??= new SharedSessionCoordinator("chat", "identity");
    const store = owner.beginTurn(id, id);
    store.beginRules("stable-rules");
    return store;
  }
  function persistent(name = "chat") {
    const adapter = new PersistentLoopSessionStorage(name);
    adapters.push(adapter);
    return adapter;
  }

  it("reuses an accepted fold after commit, new view and restart without changing raw", () => {
    const a = shared();
    const frozen = shared("frozen");
    expect(fold(a)).toBe(true);
    a.appendMessage({ role: "user", content: "third question" });
    expect(owner!.commit(a)).toBe(true);
    expect(loadSessionMessages("chat").slice(0, 4)).toEqual(raw);
    expect(shared("b").loadMessages().slice(0, 3)).toEqual([summary, ...raw.slice(2)]);
    expect(frozen.loadMessages()).toEqual(raw);
    owner!.dispose();
    owner = undefined;
    expect(shared("restart").loadMessages()[0]).toEqual(summary);
    expect(shared("count").rawUserTurns).toBe(3);
  });

  it("publishes a manual fold with empty staging without adding a raw turn", () => {
    const before = readFileSync(sessionPath("chat"));
    const a = shared();
    fold(a);
    expect(a.hasRecords).toBe(false);
    expect(a.publishCompaction()).toBe(true);
    expect(readFileSync(sessionPath("chat"))).toEqual(before);
    expect(shared("b").loadMessages()).toEqual([summary, ...raw.slice(2)]);
  });

  it("composes repeated folds over a prior summary and newly committed records", () => {
    const a = shared();
    fold(a);
    const twice = { role: "assistant" as const, content: "recap twice" };
    expect(fold(a, 2, twice)).toBe(true);
    expect(a.publishCompaction()).toBe(true);
    expect(shared("b").loadMessages()).toEqual([twice, raw[3]]);
    const cp = JSON.parse(readFileSync(compactionCheckpointPath("chat"), "utf8"));
    expect(cp.coveredRecords).toBe(3);
    expect(cp).not.toHaveProperty("records");
    expect(JSON.stringify(cp)).not.toContain("second answer");
  });

  it.each([true, false])("rejects a private-prefix parallel gap (sibling first=%s)", (first) => {
    const a = shared();
    const b = shared("b");
    a.appendMessage({ role: "user", content: "private A" });
    expect(fold(a, 5)).toBe(true);
    b.appendMessage({ role: "user", content: "private B" });
    if (first) owner!.commit(b);
    owner!.commit(a);
    if (!first) owner!.commit(b);
    expect(shared("c").loadMessages()[0]).toEqual(first ? raw[0] : summary);
    expect(loadSessionMessages("chat")).toHaveLength(6);
  });

  it("does not replace a newer checkpoint with a late smaller fold", () => {
    const a = shared();
    const b = shared("b");
    fold(a, 1);
    const newer = { role: "assistant" as const, content: "newer" };
    fold(b, 3, newer);
    expect(b.publishCompaction()).toBe(true);
    expect(a.publishCompaction()).toBe(false);
    expect(shared("c").loadMessages()[0]).toEqual(newer);
  });

  it("discards cancellation candidates and refuses aborted manual publication", () => {
    const a = shared();
    a.appendMessage({ role: "user", content: "cancelled private question" });
    fold(a, 5);
    a.discardCurrentTurn();
    expect(a.publishCompaction()).toBe(false);
    expect(a.loadMessages()).toEqual(raw);
    fold(a);
    const signal = AbortSignal.abort();
    expect(a.publishCompaction(signal)).toBe(false);
    expect(a.publishCompaction()).toBe(false);
    expect(existsSync(compactionCheckpointPath("chat"))).toBe(false);
  });

  it("retains the previous checkpoint when an atomic publication fails after raw commit", async () => {
    const a = shared();
    fold(a, 1);
    a.publishCompaction();
    const old = readFileSync(compactionCheckpointPath("chat"));
    const b = shared("b");
    fold(b, 3);
    b.appendMessage({ role: "user", content: "durable" });
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (String(to) === compactionCheckpointPath("chat"))
        throw new Error("synthetic rename failure");
      actual.renameSync(from, to);
    });
    expect(owner!.commit(b)).toBe(true);
    expect(loadSessionMessages("chat").at(-1)?.content).toBe("durable");
    expect(readFileSync(compactionCheckpointPath("chat"))).toEqual(old);
  });

  it("rejects changed covered prefixes, identity, rules, corruption and backup-backed history", () => {
    const a = shared();
    fold(a);
    a.publishCompaction();
    const saved = readFileSync(compactionCheckpointPath("chat"));
    const changed = shared("changed");
    changed.beginRules("different rules");
    expect(changed.loadMessages()).toEqual(raw);
    writeFileSync(compactionCheckpointPath("chat"), "not json");
    expect(shared("corrupt").loadMessages()).toEqual(raw);
    writeFileSync(compactionCheckpointPath("chat"), saved);
    owner!.replaceHistory([{ ...raw[0], content: "edited" }, ...raw.slice(1)], owner!.version);
    expect(shared("edited").loadMessages()[0]?.content).toBe("edited");
    writeFileSync(sessionPath("chat"), "malformed live transcript\n");
    owner!.reload();
    expect(shared("backup").loadMessages()).toEqual(raw);
    writeFileSync(compactionCheckpointPath("chat"), saved);
    rewriteSession("chat", raw);
    patchSessionMeta("chat", { sessionId: "imported-identity" });
    expect(shared("identity").loadMessages()).toEqual(raw);
  });

  it("keeps generic context rewrites private and rejects fabricated fold heads", () => {
    const a = shared();
    a.rewriteMessages([summary, ...raw.slice(2)], "context");
    expect(a.publishCompaction()).toBe(false);
    expect(a.recordFold({ before: raw, head: raw.slice(1, 3), summary })).toBe(false);
  });

  it("supports named CLI storage without another writer lease and rebinds only the same identity", () => {
    const cli = persistent();
    cli.beginRules("stable-rules");
    expect(fold(cli)).toBe(true);
    expect(cli.publishCompaction()).toBe(true);
    expect(loadSessionMessages("chat")).toEqual(raw);
    cli.appendMessage({ role: "user", content: "CLI new question" });
    expect(cli.rawUserTurns).toBe(3);
    expect(renameSession("chat", "renamed")).toBe(true);
    cli.rebind("renamed");
    expect(cli.loadMessages()[0]).toEqual(summary);
    const expected = cli.loadMessages();
    cli.dispose?.();
    const restart = persistent("renamed");
    restart.beginRules("stable-rules");
    expect(restart.loadMessages()).toEqual(expected);
    rewriteSession("other", raw);
    patchSessionMeta("other", { sessionId: "different" });
    restart.rebind("other");
    expect(restart.loadMessages()).toEqual(raw);
    expect(restart.publishCompaction()).toBe(false);
  });

  it("retains the fold abort signal through a later raw commit", () => {
    const a = shared();
    const controller = new AbortController();
    const before = a.loadMessages();
    a.rewriteMessages([summary, ...before.slice(2)], "context");
    expect(
      a.recordFold({ before, head: before.slice(0, 2), summary, signal: controller.signal }),
    ).toBe(true);
    a.appendMessage({ role: "user", content: "raw still commits" });
    controller.abort();
    expect(owner!.commit(a)).toBe(true);
    expect(existsSync(compactionCheckpointPath("chat"))).toBe(false);
    expect(loadSessionMessages("chat").at(-1)?.content).toBe("raw still commits");
  });

  it("uses the existing session writer lease identity and releases it on dispose/rebind", () => {
    const cli = persistent();
    expect(() => new SharedSessionCoordinator("chat", "identity")).toThrow(/already writable/);
    expect(() => new PersistentLoopSessionStorage("chat")).toThrow(/already writable/);
    rewriteSession("other", raw);
    patchSessionMeta("other", { sessionId: "other-identity" });
    cli.rebind("other");
    owner = new SharedSessionCoordinator("chat", "identity");
    expect(() => new SharedSessionCoordinator("other", "other-identity")).toThrow(
      /already writable/,
    );
    cli.dispose();
    const next = new SharedSessionCoordinator("other", "other-identity");
    next.dispose();
  });

  it("does not write synthesized summaries into raw during a CLI history edit", () => {
    const cli = persistent();
    cli.beginRules("rules");
    fold(cli, 1);
    cli.publishCompaction();
    cli.rewriteMessages([summary, ...raw.slice(1, 3)], "history");
    expect(loadSessionMessages("chat")).toEqual(raw.slice(0, 3));
  });

  it("can accept a fold after reasoning-only healing without treating the heal as a checkpoint", () => {
    const a = shared();
    const before = a.loadMessages();
    a.rewriteMessages(
      before.map((row) => (row.role === "assistant" ? { ...row, reasoning_content: "" } : row)),
      "context",
    );
    expect(a.publishCompaction()).toBe(false);
    expect(fold(a)).toBe(true);
    expect(a.publishCompaction()).toBe(true);
    expect(loadSessionMessages("chat")).toEqual(raw);
  });

  it("moves and deletes checkpoints with existing session sidecars", () => {
    const a = shared();
    fold(a);
    a.publishCompaction();
    owner!.releaseEmptyTurn(a);
    owner!.dispose();
    owner = undefined;
    expect(renameSession("chat", "renamed")).toBe(true);
    expect(existsSync(compactionCheckpointPath("renamed"))).toBe(true);
    expect(moveSessionToArchive("renamed")).toBe(true);
    expect(existsSync(compactionCheckpointPath("renamed"))).toBe(false);
    expect(restoreArchivedSession("renamed")).toBe(true);
    expect(existsSync(compactionCheckpointPath("renamed"))).toBe(true);
    expect(moveSessionToArchive("renamed")).toBe(true);
    expect(deleteArchivedSession("renamed")).toBe(true);
    expect(existsSync(join(home, ".jupiter/sessions/archive/renamed.compaction.json"))).toBe(false);
  });

  it("merges parallel proven limits without loosening the same binding or retaining another binding", () => {
    const a = shared();
    const b = shared("b");
    a.patchMeta({
      contextLimits: {
        model: { binding: "hash-a", contextWindowTokens: 16000, inputTokenLimit: 12000 },
      },
    });
    b.patchMeta({
      contextLimits: {
        model: { binding: "hash-a", contextWindowTokens: 8000, inputTokenLimit: 6000 },
      },
    });
    a.appendMessage({ role: "user", content: "a" });
    b.appendMessage({ role: "user", content: "b" });
    owner!.commit(b);
    owner!.commit(a);
    expect(a.loadMeta().contextLimits?.model?.contextWindowTokens).toBe(16000);
    const c = shared("c");
    expect(c.loadMeta().contextLimits?.model).toEqual({
      binding: "hash-a",
      contextWindowTokens: 8000,
      inputTokenLimit: 6000,
    });
    c.patchMeta({
      contextLimits: {
        model: { binding: "hash-b", contextWindowTokens: 32000 },
        another: { binding: "hash-other", inputTokenLimit: 4000 },
      },
    });
    c.appendMessage({ role: "user", content: "c" });
    owner!.commit(c);
    expect(shared("d").loadMeta().contextLimits).toEqual({
      model: { binding: "hash-b", contextWindowTokens: 32000 },
      another: { binding: "hash-other", inputTokenLimit: 4000 },
    });
  });

  it("keeps the previous cache when a repeated private fold cannot map across a sibling commit", () => {
    const first = shared();
    fold(first);
    first.publishCompaction();
    const original = readFileSync(compactionCheckpointPath("chat"));
    const a = shared("a2");
    const b = shared("b2");
    a.appendMessage({ role: "user", content: "private A" });
    expect(fold(a, a.loadMessages().length)).toBe(true);
    b.appendMessage({ role: "user", content: "private B" });
    owner!.commit(b);
    owner!.commit(a);
    expect(readFileSync(compactionCheckpointPath("chat"))).toEqual(original);
    expect(
      shared("latest")
        .loadMessages()
        .map((row) => row.content),
    ).toEqual([
      summary.content,
      ...raw.slice(2).map((row) => row.content),
      "private B",
      "private A",
    ]);
  });

  it("folds a loaded checkpoint again and preserves image source metadata through restart", () => {
    const image = {
      kind: "image" as const,
      id: "a".repeat(64),
      name: "image.png",
      mime: "image/png" as const,
      bytes: 10,
      width: 1,
      height: 1,
    };
    rewriteSession("chat", [{ ...raw[0], attachments: [image] }, ...raw.slice(1)]);
    const a = shared();
    const imageSummary = { ...summary, sourceAttachments: [image] };
    expect(fold(a, 2, imageSummary)).toBe(true);
    a.publishCompaction();
    owner!.dispose();
    owner = undefined;
    const b = shared("restart");
    expect(b.loadMessages()[0]?.sourceAttachments).toEqual([image]);
    const nextSummary = { ...imageSummary, content: "composed image summary" };
    expect(fold(b, 2, nextSummary)).toBe(true);
    expect(b.publishCompaction()).toBe(true);
    expect(shared("next").loadMessages()).toEqual([nextSummary, raw[3]]);
  });

  it("freezes the checkpoint before rules configuration and rejects late stale bytes", () => {
    owner = new SharedSessionCoordinator("chat", "identity");
    const frozen = owner.beginTurn("unconfigured");
    const a = shared();
    fold(a);
    a.publishCompaction();
    frozen.beginRules("stable-rules");
    expect(frozen.loadMessages()).toEqual(raw);
    const b = shared("b");
    fold(b, 3);
    writeFileSync(
      sessionPath("chat"),
      `${raw.map((row) => `${JSON.stringify(row)} `).join("\n")}\n`,
    );
    expect(b.publishCompaction()).toBe(false);
  });

  it("retains private raw records when a post-fold shared history edit keeps the summary", () => {
    const a = shared();
    a.appendMessage({ role: "user", content: "private user" });
    expect(fold(a, 5)).toBe(true);
    a.appendMessage({ role: "assistant", content: "private answer" });
    a.rewriteMessages(a.loadMessages(), "history");
    owner!.commit(a);
    expect(loadSessionMessages("chat").map((row) => row.content)).toEqual([
      ...raw.map((row) => row.content),
      "private user",
      "private answer",
    ]);
  });

  it("reuses a supplied writer owner without releasing the caller's lease reference", () => {
    const lease = SessionWriterLease.acquire({
      key: "identity",
      ownerId: "test-owner",
      label: "chat",
    });
    try {
      const cli = new PersistentLoopSessionStorage("chat", { ownerId: "test-owner" });
      adapters.push(cli);
      cli.dispose();
      expect(() => new PersistentLoopSessionStorage("chat")).toThrow(/already writable/);
    } finally {
      lease.release();
    }
    const cli = persistent();
    cli.dispose();
  });

  it("drops restored private records on discard even when rules are configured after restoration", () => {
    const a = shared();
    a.appendMessage({ role: "user", content: "recover then discard" });
    owner!.dispose();
    owner = new SharedSessionCoordinator("chat", "identity");
    const restored = owner.restoreTurn("a")!;
    restored.beginRules("stable-rules");
    expect(restored.rawUserTurns).toBe(3);
    restored.discardCurrentTurn();
    expect(restored.loadMessages()).toEqual(raw);
    expect(restored.rawUserTurns).toBe(2);
  });
});
