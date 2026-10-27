import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient, Usage } from "../src/client.js";
import { type ContextManager, HISTORY_FOLD_MARKER } from "../src/context-manager.js";
import { CacheFirstLoop, type CacheFirstLoopOptions } from "../src/loop.js";
import type { LoopSessionStorage } from "../src/memory/loop-session-storage.js";
import { AppendOnlyLog, ImmutablePrefix } from "../src/memory/runtime.js";
import { SessionWriterLease } from "../src/memory/session-writer-lock.js";
import * as sessions from "../src/memory/session.js";
import {
  type ToolExecutionJournal,
  openToolExecutionJournal,
} from "../src/memory/tool-execution-journal.js";
import { ToolRegistry } from "../src/tools.js";
import type { ChatMessage } from "../src/types.js";

function history(count = 240): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `history-${i}`,
  }));
}

function storage(messages: ChatMessage[] = []) {
  let projection = structuredClone(messages);
  let meta: sessions.SessionMeta = {};
  const store: LoopSessionStorage = {
    loadMessages: vi.fn(() => structuredClone(projection)),
    appendMessage: vi.fn((message) => {
      projection.push(structuredClone(message));
    }),
    rewriteMessages: vi.fn((replacement) => {
      projection = structuredClone(replacement);
    }),
    loadMeta: vi.fn(() => structuredClone(meta)),
    patchMeta: vi.fn((patch) => {
      meta = { ...meta, ...patch };
    }),
    journal: null,
  };
  return store;
}

function makeLoop(store?: LoopSessionStorage, options: Partial<CacheFirstLoopOptions> = {}) {
  return new CacheFirstLoop({
    client: new DeepSeekClient({
      apiKey: "synthetic",
      baseUrl: "https://synthetic.invalid/v1",
      retry: { maxAttempts: 1 },
      fetch: vi.fn(async () =>
        Response.json({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        }),
      ),
    }),
    prefix: new ImmutablePrefix({ system: "s" }),
    stream: false,
    model: "deepseek-chat",
    session: "shared",
    sessionStorage: store,
    ...options,
  });
}

describe("loop shared working storage", { retry: 0 }, () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jupiter-shared-loop-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("loads a complete independent snapshot and never reads or writes the main transcript", async () => {
    sessions.rewriteSession("shared", [{ role: "user", content: "other branch" }]);
    const diskBefore = sessions.loadSessionMessages("shared");
    const store = storage(history());
    const loop = makeLoop(store);
    expect(loop.log.toFullHistory()).toEqual(history());
    expect(loop.log.getEntry(0)).toEqual(history()[0]);
    await loop.run("local question");
    expect(store.appendMessage).toHaveBeenCalledTimes(2);
    expect(store.loadMessages()).toHaveLength(242);
    expect(sessions.loadSessionMessages("shared")).toEqual(diskBefore);
    expect(loop.log.sessionPath).toBeNull();
  });

  it("never leases or recovers/rebinds a coordinator-owned journal", () => {
    const lease = vi.spyOn(SessionWriterLease, "acquire");
    const recover = vi.fn();
    const repair = vi.fn();
    const rebind = vi.fn();
    const store = storage();
    store.journal = {
      recoverIncompleteExecutions: recover,
      repairDanglingToolCalls: repair,
      rebindPath: rebind,
    } as unknown as ToolExecutionJournal;
    const loop = makeLoop(store, { sessionWriterKey: "shared", sessionWriterOwnerId: "view-a" });
    loop.rebindSession("renamed");
    expect(loop.sessionName).toBe("renamed");
    expect(lease).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
    expect(rebind).not.toHaveBeenCalled();
  });

  it("keeps cancellation above the 200-message window local and preserves the entire prefix", async () => {
    const prior = history();
    const store = storage(prior);
    const loop = makeLoop(store);
    vi.spyOn(loop.client, "chat").mockImplementation(async (opts) => {
      loop.abort({ discardCurrentTurn: true });
      opts.signal?.throwIfAborted();
      throw new Error("unreachable");
    });
    await loop.run("discard me");
    expect(loop.log.toFullHistory()).toEqual(prior);
    expect(store.loadMessages()).toEqual(prior);
    expect(store.rewriteMessages).toHaveBeenLastCalledWith(prior, "history");
    expect(sessions.loadSessionMessages("shared")).toEqual([]);
  });

  it("fixes default-mode cancellation beyond the memory window too", async () => {
    const prior = history();
    sessions.rewriteSession("shared", prior);
    const loop = makeLoop();
    vi.spyOn(loop.client, "chat").mockImplementation(async () => {
      loop.abort({ discardCurrentTurn: true });
      throw new DOMException("cancelled", "AbortError");
    });
    await loop.run("discard me");
    expect(sessions.loadSessionMessages("shared")).toEqual(prior);
  });

  it("replaces a self-correction tail without dropping the old prefix", () => {
    const prior = history();
    const store = storage(prior);
    const loop = makeLoop(store);
    const replacement: ChatMessage = { role: "assistant", content: "corrected" };
    (
      loop as unknown as { replaceTailAssistantMessage(m: ChatMessage): void }
    ).replaceTailAssistantMessage(replacement);
    expect(loop.log.totalLength).toBe(prior.length);
    expect(store.loadMessages()).toEqual([...prior.slice(0, -1), replacement]);
    expect(store.rewriteMessages).toHaveBeenLastCalledWith(
      [...prior.slice(0, -1), replacement],
      "history",
    );
  });

  it("routes retry, clear and workspace reset to local history only", async () => {
    sessions.rewriteSession("shared", history(4));
    const store = storage(history(4));
    const loop = makeLoop(store);
    await loop.run("retry this");
    expect(loop.retryLastUser()).toBe("retry this");
    expect(store.loadMessages()).toEqual(history(4));
    expect(loop.clearLog().archived).toBeNull();
    expect(store.loadMessages()).toEqual([]);
    loop.appendAndPersist({ role: "user", content: "local" });
    expect(loop.switchWorkspace({ sessionName: "next" }).archived).toBeNull();
    expect(store.loadMessages()).toEqual([]);
    expect(sessions.loadSessionMessages("shared")).toEqual(history(4));
    expect(sessions.loadSessionMessages("next")).toEqual([]);
  });

  it("does not acknowledge a failed staged append or mutate the model log", async () => {
    const store = storage();
    vi.mocked(store.appendMessage).mockImplementation(() => {
      throw new Error("staging failed");
    });
    const loop = makeLoop(store);
    const persisted = vi.fn();
    const failed = vi.fn();
    const drain = async () => {
      for await (const _event of loop.step("question", {
        onUserPersisted: persisted,
        onUserPersistFailed: failed,
      })) {
        /* consume */
      }
    };
    await expect(drain()).rejects.toThrow("staging failed");
    expect(loop.log.totalLength).toBe(0);
    expect(persisted).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(1);
  });

  it("supports full-history snapshots without mutable nested aliases or disk fallback", () => {
    const source = history();
    source[1]!.tool_calls = [
      { id: "x", type: "function", function: { name: "echo", arguments: "{}" } },
    ];
    const log = new AppendOnlyLog({ fullHistory: source });
    source[1]!.tool_calls![0]!.function.name = "source mutation";
    const result = log.toFullHistory();
    result[1]!.tool_calls![0]!.function.name = "returned mutation";
    log.append({ role: "user", content: "local" });
    expect(log.toFullHistory()).toHaveLength(241);
    expect(log.getEntry(1)!.tool_calls![0]!.function.name).toBe("echo");
  });

  it("retains storage-returned identities on appended and self-corrected messages", () => {
    const store = storage();
    const stamped: ChatMessage & { turnId: string; conversationViewId: string } = {
      role: "assistant",
      content: "stamped",
      turnId: "turn-a",
      conversationViewId: "view-a",
    };
    vi.mocked(store.appendMessage).mockReturnValue(stamped);
    const loop = makeLoop(store);
    loop.appendAndPersist({ role: "assistant", content: "original" });
    expect(loop.log.toFullHistory()).toEqual([stamped]);
    const corrected = { ...stamped, content: "corrected" };
    store.replaceTailMessage = vi.fn(() => corrected);
    (
      loop as unknown as { replaceTailAssistantMessage(m: ChatMessage): void }
    ).replaceTailAssistantMessage({ role: "assistant", content: "corrected" });
    expect(loop.log.toFullHistory()).toEqual([corrected]);
    expect(store.rewriteMessages).not.toHaveBeenCalled();
  });

  it("persists manual compaction as context only and leaves raw append records alone", async () => {
    const prior = Array.from(
      { length: 20 },
      (_, i): ChatMessage => ({
        role: i % 2 ? "assistant" : "user",
        content: i % 2 ? "evidence for a large context ".repeat(2000) : `Question ${i}`,
      }),
    );
    const store = storage(prior);
    const loop = makeLoop(store);
    const result = await loop.manualCompactHistory();
    expect(result.folded).toBe(true);
    expect(store.rewriteMessages).toHaveBeenLastCalledWith(expect.any(Array), "context");
    expect(store.loadMessages()[0]!.content).toContain(HISTORY_FOLD_MARKER);
    expect(loop.log.toFullHistory()).toEqual(store.loadMessages());
    expect(store.appendMessage).not.toHaveBeenCalled();
    expect(sessions.loadSessionMessages("shared")).toEqual([]);
  });

  it("keeps the old projection when compaction persistence fails", async () => {
    const prior = history(20);
    const store = storage(prior);
    const loop = makeLoop(store);
    vi.mocked(store.rewriteMessages).mockImplementation(() => {
      throw new Error("no space");
    });
    const result = await loop.compactHistory({ keepRecentTokens: 10 });
    expect(result).toMatchObject({ folded: false, reason: "persistence-failed" });
    expect(loop.log.toFullHistory()).toEqual(prior);
    expect(store.loadMessages()).toEqual(prior);
  });

  it("uses explicit discard for cancel and retry even after the model prefix has changed", async () => {
    const base = history();
    const store = storage(base);
    store.discardCurrentTurn = vi.fn(() => store.rewriteMessages(base, "context"));
    const loop = makeLoop(store);
    vi.spyOn(loop.client, "chat").mockImplementation(async () => {
      const projection: ChatMessage[] = [
        { role: "assistant", content: "compressed prefix" },
        { role: "user", content: "local" },
      ];
      store.rewriteMessages(projection, "context");
      loop.log.compactInPlace(projection);
      loop.abort({ discardCurrentTurn: true });
      throw new DOMException("cancelled", "AbortError");
    });
    await loop.run("local");
    expect(store.discardCurrentTurn).toHaveBeenCalledTimes(1);
    expect(loop.log.toFullHistory()).toEqual(base);
    loop.appendAndPersist({ role: "user", content: "retry this" });
    expect(loop.retryLastUser()).toBe("retry this");
    expect(store.discardCurrentTurn).toHaveBeenCalledTimes(2);
    expect(loop.log.toFullHistory()).toEqual(base);
  });

  it("routes load-time and send-time healing to the context projection", () => {
    const store = storage([
      { role: "user", content: "before" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "lost", type: "function", function: { name: "read", arguments: "{}" } }],
      },
    ]);
    const loop = makeLoop(store);
    expect(store.rewriteMessages).toHaveBeenLastCalledWith(
      [{ role: "user", content: "before" }],
      "context",
    );
    loop.appendAndPersist({ role: "tool", tool_call_id: "orphan", content: "bad" });
    (loop as unknown as { buildMessages(): ChatMessage[] }).buildMessages();
    expect(store.rewriteMessages).toHaveBeenLastCalledWith(
      [{ role: "user", content: "before" }],
      "context",
    );
    expect(sessions.loadSessionMessages("shared")).toEqual([]);
  });

  it("routes metadata and provider binding checks through the store after a rename", () => {
    const store = storage();
    const provider: sessions.SessionProviderBinding = {
      providerId: "synthetic",
      endpointIdentity: "https://synthetic.invalid/v1",
      label: "Synthetic",
      dialect: "openai-compatible",
      model: "deepseek-chat",
    };
    const loop = makeLoop(store, { providerBinding: provider });
    loop.rebindSession("renamed");
    loop.beginLightAsk("hello");
    expect(store.loadMeta().provider).toEqual(provider);
    expect(sessions.loadSessionMeta("renamed")).toEqual({});
    store.patchMeta({ provider: { ...provider, endpointIdentity: "other" } });
    expect(() => loop.beginLightAsk("no upload")).toThrow(/bound/);
  });

  it("preserves the whole prefix in default-mode tail self-correction", () => {
    const prior = history();
    sessions.rewriteSession("shared", prior);
    const loop = makeLoop();
    const replacement: ChatMessage = { role: "assistant", content: "corrected" };
    (
      loop as unknown as { replaceTailAssistantMessage(m: ChatMessage): void }
    ).replaceTailAssistantMessage(replacement);
    expect(sessions.loadSessionMessages("shared")).toEqual([...prior.slice(0, -1), replacement]);
  });

  it.each([false, true])(
    "stores forced summaries as raw output (replace tool tail: %s)",
    (replace) => {
      const store = storage(history());
      const loop = makeLoop(store);
      const summary = {
        role: "assistant",
        content: "final summary",
        turnId: "new-turn",
      } as ChatMessage;
      const context = (loop as unknown as { context: ContextManager }).context;
      vi.mocked(store.appendMessage).mockReturnValue(summary);
      store.replaceTailMessage = vi.fn(() => summary);
      if (replace)
        loop.log.append({
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "pending", type: "function", function: { name: "read", arguments: "{}" } },
          ],
        });
      expect(
        context.commitForcedSummary({ role: "assistant", content: "final summary" }, "shared"),
      ).toBe(true);
      expect(loop.log.toFullHistory().at(-1)).toEqual(summary);
      expect(loop.log.totalLength).toBe(241);
      if (replace) expect(store.replaceTailMessage).toHaveBeenCalledTimes(1);
      else expect(store.appendMessage).toHaveBeenCalledTimes(1);
      expect(store.rewriteMessages).not.toHaveBeenCalled();
    },
  );

  it("retains a long prefix when trimming pending tools for a forced summary", () => {
    const store = storage(history());
    const loop = makeLoop(store);
    loop.appendAndPersist({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "pending", type: "function", function: { name: "read", arguments: "{}" } },
      ],
    });
    const context = (loop as unknown as { context: ContextManager }).context;
    expect(context.trimTrailingToolCalls()).toBe(true);
    expect(loop.log.toFullHistory()).toEqual(history());
    expect(store.rewriteMessages).toHaveBeenLastCalledWith(history(), "history");
  });

  it("keeps independent working histories for concurrent loops with one logical session", async () => {
    const a = storage(history(4));
    const b = storage(history(4));
    const loopA = makeLoop(a);
    const loopB = makeLoop(b);
    const requestsA: ChatMessage[][] = [];
    const requestsB: ChatMessage[][] = [];
    for (const [loop, requests] of [
      [loopA, requestsA],
      [loopB, requestsB],
    ] as const) {
      const chat = loop.client.chat.bind(loop.client);
      vi.spyOn(loop.client, "chat").mockImplementation((opts) => {
        requests.push(structuredClone(opts.messages));
        return chat(opts);
      });
    }
    await Promise.all([loopA.run("only A"), loopB.run("only B")]);
    expect(requestsA[0]!.some((m) => m.content === "only B")).toBe(false);
    expect(requestsB[0]!.some((m) => m.content === "only A")).toBe(false);
    expect(a.loadMessages().at(-2)?.content).toBe("only A");
    expect(b.loadMessages().at(-2)?.content).toBe("only B");
    expect(sessions.loadSessionMessages("shared")).toEqual([]);
  });

  it("continues a failed API request without repeating a completed tool or the user input", async () => {
    const store = storage();
    store.journal = openToolExecutionJournal("shared-owner");
    const recover = vi.spyOn(store.journal, "recoverIncompleteExecutions");
    const execute = vi.fn(async () => "written once");
    const tools = new ToolRegistry().register({
      name: "write_once",
      description: "test write",
      parameters: { type: "object" },
      fn: execute,
    });
    const loop = makeLoop(store, {
      tools,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
    });
    const chat = loop.client.chat.bind(loop.client);
    const model = vi
      .spyOn(loop.client, "chat")
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "same-provider-id",
            type: "function",
            function: { name: "write_once", arguments: "{}" },
          },
        ],
        usage: new Usage(),
        finishReason: "tool_calls",
        reasoningContent: null,
        usageComplete: true,
        raw: {},
      })
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockImplementation(chat);
    await loop.run("perform this");
    expect(loop.canRetryFailedModelRequest()).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    for await (const _event of loop.retryFailedModelRequest()) {
      /* consume */
    }
    expect(model).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.loadMessages().filter((m) => m.role === "user")).toHaveLength(1);
    expect(store.loadMessages().filter((m) => m.role === "tool")).toHaveLength(1);
    expect(loop.log.toFullHistory()).toEqual(store.loadMessages());
    expect(recover).not.toHaveBeenCalled();
    expect(sessions.loadSessionMessages("shared")).toEqual([]);
  });

  it("stages image metadata through the storage without a direct session append", () => {
    const store = storage();
    const loop = makeLoop(store);
    const message: ChatMessage = {
      role: "user",
      content: "image",
      attachments: [
        {
          kind: "image",
          id: "a".repeat(64),
          name: "synthetic.png",
          mime: "image/png",
          bytes: 10,
          width: 1,
          height: 1,
        },
      ],
    };
    expect(loop.appendAndPersist(message)).toBe(true);
    expect(store.appendMessage).toHaveBeenCalledWith(message);
    expect(loop.log.toFullHistory()).toEqual([message]);
    expect(sessions.loadSessionMessages("shared")).toEqual([]);
  });

  it.each(["rollbackLatestTurn", "rollbackToTurn", "rewindToUserDraft"] as const)(
    "%s only rewrites the working history",
    (method) => {
      sessions.rewriteSession("shared", history(6));
      const store = storage(history(6));
      const loop = makeLoop(store);
      if (method === "rollbackLatestTurn") expect(loop.rollbackLatestTurn()).toBe(true);
      else if (method === "rollbackToTurn")
        expect(loop.rollbackToTurn({ turn: 2, role: "assistant" })).toBe(true);
      else expect(loop.rewindToUserDraft(2)?.text).toBe("history-4");
      expect(store.loadMessages()).toEqual(history(4));
      expect(loop.log.toFullHistory()).toEqual(history(4));
      expect(store.rewriteMessages).toHaveBeenLastCalledWith(history(4), "history");
      expect(sessions.loadSessionMessages("shared")).toEqual(history(6));
    },
  );
});
