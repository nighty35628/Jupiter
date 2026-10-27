import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSessionHistoryPage } from "../src/memory/session-history.js";
import {
  appendSessionMessage,
  deleteSession,
  loadSessionMessages,
  loadSessionMeta,
  patchSessionMeta,
  readTailMessages,
  rewriteSession,
  sessionPath,
} from "../src/memory/session.js";
import {
  readPendingSharedCommit,
  sharedCommitPath,
} from "../src/memory/shared-session-boundary.js";
import { SharedSessionCoordinator } from "../src/memory/shared-session.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

describe("shared session whole-turn commits", { retry: 0 }, () => {
  let home: string;
  let coordinator: SharedSessionCoordinator | undefined;
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(writeFileSync).mockImplementation(actual.writeFileSync);
    vi.mocked(renameSync).mockImplementation(actual.renameSync);
    home = mkdtempSync(join(tmpdir(), "jupiter-shared-session-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(home);
  });
  afterEach(() => {
    coordinator?.dispose();
    coordinator = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  it("keeps in-progress turns private and freezes sibling snapshots", () => {
    coordinator = new SharedSessionCoordinator("chat", "session-id");
    expect(sessionPath("chat").startsWith(home)).toBe(true);
    const a = coordinator.beginTurn("view-a", "client-a");
    const b = coordinator.beginTurn("view-b", "client-b");
    a.appendMessage({ role: "user", content: "A", clientId: "client-a" });
    b.appendMessage({ role: "user", content: "B", clientId: "client-b" });
    expect(loadSessionMessages("chat")).toEqual([]);
    b.appendMessage({ role: "assistant", content: "answer B" });
    coordinator.commit(b);
    expect(a.loadMessages().map((m) => m.content)).toEqual(["A"]);
    expect(loadSessionMessages("chat").map((m) => m.content)).toEqual(["B", "answer B"]);
    a.appendMessage({ role: "assistant", content: "answer A" });
    coordinator.commit(a);
    expect(loadSessionMessages("chat").map((m) => m.content)).toEqual([
      "B",
      "answer B",
      "A",
      "answer A",
    ]);
    const c = coordinator.beginTurn("view-c", "client-c");
    expect(c.loadMessages()).toHaveLength(4);
    coordinator.commit(a);
    expect(loadSessionMessages("chat")).toHaveLength(4);
  });

  it("does not retain an unacknowledged message when private persistence fails", () => {
    coordinator = new SharedSessionCoordinator("chat", "session-id");
    const turn = coordinator.beginTurn("view-a", "client-a");
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("Synthetic full disk"), { code: "ENOSPC" });
    });
    expect(() => turn.appendMessage({ role: "user", content: "unsaved" })).toThrow("full disk");
    expect(turn.hasRecords).toBe(false);
    expect(turn.loadMessages()).toEqual([]);
    turn.appendMessage({ role: "user", content: "retried" });
    coordinator.commit(turn);
    expect(loadSessionMessages("chat").map((message) => message.content)).toEqual(["retried"]);
  });

  it("removes the session's private recovery artifacts on explicit deletion only", () => {
    coordinator = new SharedSessionCoordinator("chat", "session-id");
    patchSessionMeta("chat", { sessionId: "session-id" });
    const turn = coordinator.beginTurn("view-a", "client-a");
    turn.appendMessage({ role: "user", content: "private" });
    const directory = coordinator.stagingDir;
    expect(existsSync(directory)).toBe(true);
    coordinator.dispose();
    coordinator = undefined;
    expect(deleteSession("chat")).toBe(true);
    expect(existsSync(directory)).toBe(false);
  });
  it("does not commit a compressed copy of old history", () => {
    coordinator = new SharedSessionCoordinator("chat", "session-id");
    const a = coordinator.beginTurn("view-a", "client-a");
    a.appendMessage({ role: "user", content: "question" });
    a.rewriteMessages([{ role: "assistant", content: "private summary" }], "context");
    a.appendMessage({ role: "assistant", content: "answer" });
    coordinator.commit(a);
    expect(loadSessionMessages("chat").map((m) => m.content)).toEqual(["question", "answer"]);
  });
  it("hides an interrupted append from both legacy and paged readers, then recovers once", async () => {
    coordinator = new SharedSessionCoordinator("chat", "session-id");
    const a = coordinator.beginTurn("view-a", "client-a");
    a.appendMessage({ role: "user", content: "question" });
    a.appendMessage({ role: "assistant", content: "answer" });
    coordinator.prepareCommit(a);
    appendFileSync(
      sessionPath("chat"),
      JSON.stringify({ role: "user", content: "question" }).slice(0, 12),
    );
    expect(loadSessionMessages("chat")).toEqual([]);
    expect((await readSessionHistoryPage("chat")).records).toEqual([]);
    coordinator.dispose();
    coordinator = new SharedSessionCoordinator("chat", "session-id");
    expect(loadSessionMessages("chat").map((m) => m.content)).toEqual(["question", "answer"]);
    coordinator.dispose();
    coordinator = new SharedSessionCoordinator("chat", "session-id");
    expect(loadSessionMessages("chat")).toHaveLength(2);
  });
  it("keeps image references reachable from the durable private turn", () => {
    coordinator = new SharedSessionCoordinator("chat", "session-id");
    const a = coordinator.beginTurn("view-a", "client-a");
    a.appendMessage({ role: "user", content: "jupiter-image:0123456789abcdef" });
    expect(existsSync(a.path)).toBe(true);
    expect(readFileSync(a.path, "utf8")).toContain("jupiter-image:0123456789abcdef");
  });
  it("refuses recovery when the committed prefix was shortened", () => {
    coordinator = new SharedSessionCoordinator("chat", "session-id");
    const a = coordinator.beginTurn("a", "first");
    a.appendMessage({ role: "user", content: "first" });
    coordinator.commit(a);
    const b = coordinator.beginTurn("b", "second");
    b.appendMessage({ role: "user", content: "second" });
    coordinator.prepareCommit(b);
    writeFileSync(sessionPath("chat"), "");
    expect(() => coordinator!.recover()).toThrow(/shorter|prefix|boundary/);
    expect(readFileSync(sessionPath("chat"), "utf8")).toBe("");
  });
  it("can restore a first private turn before a main transcript exists", () => {
    coordinator = new SharedSessionCoordinator("chat", "session-id");
    const a = coordinator.beginTurn("a", "first");
    a.appendMessage({ role: "user", content: "first" });
    coordinator.dispose();
    coordinator = new SharedSessionCoordinator("chat", "session-id");
    expect(coordinator.restoreTurn("a")?.loadMessages().at(-1)?.content).toBe("first");
  });
  it("rejects a restored snapshot whose old committed prefix was rewritten", () => {
    coordinator = new SharedSessionCoordinator("chat", "session-id");
    const a = coordinator.beginTurn("a", "first");
    a.appendMessage({ role: "user", content: "first" });
    coordinator.commit(a);
    const b = coordinator.beginTurn("b", "second");
    b.appendMessage({ role: "user", content: "second" });
    writeFileSync(
      sessionPath("chat"),
      readFileSync(sessionPath("chat"), "utf8").replace("first", "other"),
    );
    expect(() => coordinator!.restoreTurn("b")).toThrow(/prefix|snapshot|changed/);
  });
  it("synchronizes in-memory identities after explicit recovery", () => {
    coordinator = new SharedSessionCoordinator("chat", "session-id");
    patchSessionMeta("chat", { workspace: "/synthetic", summary: "keep me" });
    const a = coordinator.beginTurn("a", "first");
    a.appendMessage({ role: "user", content: "first" });
    coordinator.prepareCommit(a);
    coordinator.recover();
    expect(coordinator.commit(a)).toBe(false);
    expect(loadSessionMessages("chat")).toHaveLength(1);
    expect(loadSessionMeta("chat").workspace).toBe("/synthetic");
  });

  it.each([
    { failure: "write", restart: false },
    { failure: "rename", restart: false },
    { failure: "write", restart: true },
    { failure: "rename", restart: true },
  ] as const)(
    "keeps a failed metadata $failure private and recovers once (restart=$restart)",
    async ({ failure, restart }) => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      coordinator = new SharedSessionCoordinator("chat", "session-id");
      const first = coordinator.beginTurn("a", "first");
      first.appendMessage({ role: "user", content: "committed question" });
      first.appendMessage({ role: "assistant", content: "committed answer" });
      coordinator.commit(first);
      const originalMeta = patchSessionMeta("chat", {
        workspace: "/synthetic/workspace",
        summary: "preserve this summary",
        pinnedAt: 123,
        totalCostUsd: 5,
        cacheHitTokens: 100,
        provider: {
          providerId: "synthetic-provider",
          endpointIdentity: "https://provider.invalid/v1",
          label: "Synthetic",
          dialect: "deepseek",
          model: "synthetic-model",
        },
      });
      const committed = loadSessionMessages("chat");
      const metaPath = sessionPath("chat").replace(/\.jsonl$/, ".meta.json");
      const originalMetaBytes = readFileSync(metaPath);
      const second = coordinator.beginTurn("b", "second");
      second.appendMessage({ role: "user", content: "private question" });
      second.appendMessage({ role: "assistant", content: "private answer" });
      second.patchMeta({ totalCostUsd: 7, cacheHitTokens: 130 });
      const completedAt = Date.now() + 1;
      vi.spyOn(Date, "now").mockReturnValue(completedAt);
      let fail = true;
      let injected = 0;
      const error = Object.assign(new Error("Synthetic metadata persistence failure"), {
        code: "ENOSPC",
      });
      if (failure === "write") {
        vi.mocked(writeFileSync).mockImplementation((path, data, options) => {
          if (fail && String(path).startsWith(`${metaPath}.`) && String(path).endsWith(".tmp")) {
            injected++;
            // Simulate a partial temporary write, not merely a failure before I/O.
            actual.writeFileSync(path, '{"workspace":', options);
            throw error;
          }
          return actual.writeFileSync(path, data, options);
        });
      } else {
        vi.mocked(renameSync).mockImplementation((from, to) => {
          if (fail && String(to) === metaPath) {
            injected++;
            throw error;
          }
          return actual.renameSync(from, to);
        });
      }
      expect(() => coordinator!.commit(second)).toThrow(error);
      expect(injected).toBe(1);
      expect(readFileSync(metaPath)).toEqual(originalMetaBytes);
      expect(loadSessionMeta("chat")).toEqual(originalMeta);
      expect(loadSessionMessages("chat")).toEqual(committed);
      expect(readTailMessages(sessionPath("chat"), 100)).toEqual(committed);
      expect((await readSessionHistoryPage("chat")).records).toEqual(committed);
      expect(existsSync(second.path)).toBe(true);
      const pending = readPendingSharedCommit(sessionPath("chat"));
      expect(pending?.meta).toMatchObject({
        ...originalMeta,
        totalCostUsd: 7,
        cacheHitTokens: 130,
        turnCount: 2,
        sharedHistoryVersion: 2,
        lastAssistantCompletedAt: completedAt,
      });
      fail = false;
      if (restart) {
        coordinator.dispose();
        coordinator = new SharedSessionCoordinator("chat", "session-id");
      } else {
        coordinator.recover();
        expect(coordinator.commit(second)).toBe(false);
      }
      const recovered = loadSessionMessages("chat");
      expect(recovered.map((message) => message.content)).toEqual([
        "committed question",
        "committed answer",
        "private question",
        "private answer",
      ]);
      expect(loadSessionMeta("chat")).toEqual(pending?.meta);
      expect(coordinator.version).toBe(2);
      expect(coordinator.hasCommitted("second")).toBe(true);
      expect(existsSync(sharedCommitPath(sessionPath("chat")))).toBe(false);
      expect(coordinator.restoreTurn("b")).toBeUndefined();
      coordinator.recover();
      coordinator.dispose();
      coordinator = new SharedSessionCoordinator("chat", "session-id");
      expect(loadSessionMessages("chat")).toEqual(recovered);
      expect(loadSessionMeta("chat")).toEqual(pending?.meta);
      expect(coordinator.beginTurn("c", "third").loadMessages()).toEqual(recovered);
    },
  );

  it("restores the full prepared metadata after the metadata file becomes corrupt", () => {
    coordinator = new SharedSessionCoordinator("chat", "session-id");
    const originalMeta = patchSessionMeta("chat", {
      workspace: "/synthetic",
      summary: "keep all fields",
      pinnedAt: 123,
      balanceCurrency: "CNY",
      totalCostUsd: 5,
      cacheMissTokens: 20,
      provider: {
        providerId: "synthetic-provider",
        endpointIdentity: "https://provider.invalid/v1",
        label: "Synthetic",
        dialect: "deepseek",
        model: "synthetic-model",
      },
    });
    const turn = coordinator.beginTurn("a", "first");
    turn.appendMessage({ role: "user", content: "question" });
    turn.appendMessage({ role: "assistant", content: "answer" });
    turn.patchMeta({ totalCostUsd: 7, cacheMissTokens: 30 });
    coordinator.prepareCommit(turn);
    const pending = readPendingSharedCommit(sessionPath("chat"))!;
    expect(pending.meta).toMatchObject({ ...originalMeta, totalCostUsd: 7, cacheMissTokens: 30 });
    writeFileSync(sessionPath("chat").replace(/\.jsonl$/, ".meta.json"), '{"workspace":');
    appendFileSync(
      sessionPath("chat"),
      pending.payload.slice(0, pending.payload.indexOf("\n") + 1),
    );
    expect(loadSessionMessages("chat")).toEqual([]);
    coordinator.dispose();
    coordinator = new SharedSessionCoordinator("chat", "session-id");
    expect(loadSessionMeta("chat")).toEqual(pending.meta);
    expect(loadSessionMessages("chat").map((message) => message.content)).toEqual([
      "question",
      "answer",
    ]);
    expect(coordinator.restoreTurn("a")).toBeUndefined();
    coordinator.recover();
    expect(loadSessionMeta("chat")).toEqual(pending.meta);
  });

  it.each(["syntax", "boundary", "digest"] as const)(
    "does not expose a private append or accept legacy writes when pending has corrupt %s",
    async (corruption) => {
      coordinator = new SharedSessionCoordinator("chat", "session-id");
      const first = coordinator.beginTurn("a", "first");
      first.appendMessage({ role: "user", content: "committed" });
      coordinator.commit(first);
      const committed = loadSessionMessages("chat");
      writeFileSync(`${sessionPath("chat")}.bak`, readFileSync(sessionPath("chat")));
      const second = coordinator.beginTurn("b", "second");
      second.appendMessage({ role: "user", content: "synthetic-private-canary" });
      second.appendMessage({ role: "assistant", content: "private answer" });
      coordinator.prepareCommit(second);
      const path = sessionPath("chat");
      const pending = readPendingSharedCommit(path)!;
      appendFileSync(path, pending.payload.slice(0, pending.payload.indexOf("\n") + 1));
      const damaged =
        corruption === "syntax"
          ? '{"version":'
          : JSON.stringify({
              ...pending,
              ...(corruption === "boundary" ? { baseBytes: -1 } : { baseSha256: "invalid-digest" }),
            });
      writeFileSync(sharedCommitPath(path), damaged);
      const physicalBytes = readFileSync(path);
      expect(loadSessionMessages("chat")).toEqual(committed);
      expect(readTailMessages(path, 100).some((message) => message.turnId === "second")).toBe(
        false,
      );
      await expect(readSessionHistoryPage("chat")).rejects.toThrow();
      expect(() => coordinator!.recover()).toThrow();
      expect(() =>
        appendSessionMessage("chat", { role: "user", content: "legacy append" }),
      ).toThrow();
      expect(() => rewriteSession("chat", [])).toThrow();
      expect(readFileSync(path)).toEqual(physicalBytes);
      expect(readFileSync(sharedCommitPath(path), "utf8")).toBe(damaged);
      expect(existsSync(second.path)).toBe(true);
    },
  );

  it.each(["metadata-array", "truncated-payload"] as const)(
    "refuses to publish a pending commit with corrupt %s",
    (corruption) => {
      coordinator = new SharedSessionCoordinator("chat", "session-id");
      const turn = coordinator.beginTurn("a", "first");
      turn.appendMessage({ role: "user", content: "synthetic-private-canary" });
      turn.appendMessage({ role: "assistant", content: "private answer" });
      coordinator.prepareCommit(turn);
      const path = sessionPath("chat");
      const pending = readPendingSharedCommit(path)!;
      const damaged = JSON.stringify({
        ...pending,
        ...(corruption === "metadata-array"
          ? { meta: [] }
          : { payload: pending.payload.slice(0, pending.payload.lastIndexOf("\n") - 3) }),
      });
      writeFileSync(sharedCommitPath(path), damaged);
      let recoveryError: unknown;
      try {
        coordinator.recover();
      } catch (error) {
        recoveryError = error;
      }
      expect({
        rejected: recoveryError instanceof Error,
        pendingRetained: existsSync(sharedCommitPath(path)),
        visibleMessages: loadSessionMessages("chat"),
        stageRetained: existsSync(turn.path),
      }).toEqual({
        rejected: true,
        pendingRetained: true,
        visibleMessages: [],
        stageRetained: true,
      });
    },
  );
});
