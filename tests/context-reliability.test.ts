import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectImages } from "../src/attachments/projection.js";
import type { AttachmentStore } from "../src/attachments/store.js";
import { type ImageAttachment, MAX_REQUEST_IMAGES } from "../src/attachments/types.js";
import { DeepSeekClient } from "../src/client.js";
import { resolveHistorySummaryTimeoutMs } from "../src/config.js";
import { ContextManager } from "../src/context-manager.js";
import { CacheFirstLoop } from "../src/loop.js";
import { forceSummaryAfterGuard } from "../src/loop/force-summary.js";
import { streamModelResponse } from "../src/loop/streaming.js";
import { requestFoldSummary } from "../src/loop/summary.js";
import type { LoopEvent } from "../src/loop/types.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import * as sessions from "../src/memory/session.js";
import { sanitizeProviderErrorText } from "../src/provider-http-error.js";
import { DEEPSEEK_CONTEXT_TOKENS } from "../src/telemetry/stats.js";
import type { ChatMessage } from "../src/types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(DEEPSEEK_CONTEXT_TOKENS, "reliability-small-window");
});

function response(
  content: unknown = "Durable facts and remaining work.",
  finish = "stop",
  calls?: unknown[],
) {
  return Response.json({
    choices: [
      { message: { role: "assistant", content, tool_calls: calls }, finish_reason: finish },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  });
}

function makeLoop(fetch: typeof globalThis.fetch, options: { baseUrl?: string } = {}) {
  const client = new DeepSeekClient({
    apiKey: "opaque-synthetic-credential",
    fetch,
    retry: { maxAttempts: 1 },
    ...options,
  });
  const loop = new CacheFirstLoop({
    client,
    prefix: new ImmutablePrefix({ system: "s" }),
    stream: false,
  });
  for (let i = 0; i < 10; i++) {
    loop.log.append({ role: "user", content: `question ${i} ${"context padding ".repeat(600)}` });
    loop.log.append({ role: "assistant", content: `answer ${i} ${"reply padding ".repeat(600)}` });
  }
  return loop;
}

describe("forced summary session binding", { retry: 0 }, () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jupiter-forced-binding-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  async function startSummary() {
    DEEPSEEK_CONTEXT_TOKENS["reliability-small-window"] = 2048;
    let resolve!: (value: Response) => void;
    let entered!: () => void;
    const summary = new Promise<Response>((done) => {
      resolve = done;
    });
    const started = new Promise<void>((done) => {
      entered = done;
    });
    let requests = 0;
    const fetch = vi.fn(async () => {
      if (++requests === 1) {
        return Response.json({
          choices: [
            { message: { role: "assistant", content: "Observed facts." }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1800, completion_tokens: 10, total_tokens: 1810 },
        });
      }
      if (requests === 2) {
        entered();
        return summary;
      }
      return response("Recovered next turn.");
    });
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({
        apiKey: "synthetic",
        baseUrl: "http://provider.invalid/v1",
        fetch,
        retry: { maxAttempts: 1 },
        rateLimit: { rpm: 0 },
      }),
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "reliability-small-window",
      stream: false,
      session: "forced-before",
    });
    const events: LoopEvent[] = [];
    const pending = loop.run("begin", (event) => events.push(event));
    await started;
    return { loop, events, pending, resolve };
  }

  it("commits a normal forced summary to memory and the current file", async () => {
    const task = await startSummary();
    task.resolve(response("Final durable recap."));
    await task.pending;
    expect(task.events.some((event) => event.forcedSummary)).toBe(true);
    expect(sessions.loadSessionMessages("forced-before")).toEqual(task.loop.log.toFullHistory());
    expect(task.loop.log.toFullHistory().at(-1)?.content).toBe("Final durable recap.");
  });

  it.each([1, 2])(
    "follows %i same-session renames without recreating an old file",
    async (renames) => {
      const task = await startSummary();
      const revision = task.loop.log.revision;
      let current = "forced-before";
      const oldNames: string[] = [];
      for (let index = 0; index < renames; index++) {
        const next = `forced-after-${index}`;
        expect(sessions.renameSession(current, next)).toBe(true);
        oldNames.push(current);
        task.loop.rebindSession(next);
        current = next;
      }
      expect(task.loop.log.revision).toBe(revision);
      task.resolve(response("Final durable recap."));
      await task.pending;
      expect(task.events.some((event) => event.forcedSummary)).toBe(true);
      expect(sessions.loadSessionMessages(current)).toEqual(task.loop.log.toFullHistory());
      expect(sessions.loadSessionMessages(current).at(-1)?.content).toBe("Final durable recap.");
      for (const old of oldNames) expect(existsSync(sessions.sessionPath(old))).toBe(false);
    },
  );

  it("does not commit to another logical session after a switch", async () => {
    const task = await startSummary();
    const before = task.loop.log.toFullHistory();
    const disk = readFileSync(sessions.sessionPath("forced-before"), "utf8");
    task.loop.rebindSession("different-session", { logicalSessionChanged: true });
    task.resolve(response("Obsolete recap."));
    await task.pending;
    expect(task.events.some((event) => event.forcedSummary)).toBe(false);
    expect(task.loop.log.toFullHistory()).toEqual(before);
    expect(readFileSync(sessions.sessionPath("forced-before"), "utf8")).toBe(disk);
    expect(existsSync(sessions.sessionPath("different-session"))).toBe(false);
  });

  it("retains concurrent log edits instead of committing a stale summary", async () => {
    const task = await startSummary();
    task.loop.log.append({ role: "user", content: "Concurrent intent." });
    const before = task.loop.log.toFullHistory();
    task.resolve(response("Obsolete recap."));
    await task.pending;
    expect(task.events.some((event) => event.forcedSummary)).toBe(false);
    expect(task.loop.log.toFullHistory()).toEqual(before);
    expect(
      sessions
        .loadSessionMessages("forced-before")
        .some((message) => message.content === "Obsolete recap."),
    ).toBe(false);
  });

  it("cancels after rename without committing a late summary or poisoning the next turn", async () => {
    const task = await startSummary();
    expect(sessions.renameSession("forced-before", "forced-after")).toBe(true);
    task.loop.rebindSession("forced-after");
    const before = task.loop.log.toFullHistory();
    task.loop.abort();
    await task.pending;
    task.resolve(response("Obsolete recap."));
    await Promise.resolve();
    expect(task.events.some((event) => event.forcedSummary)).toBe(false);
    expect(task.loop.log.toFullHistory()).toEqual(before);
    expect(sessions.loadSessionMessages("forced-after")).toEqual(before);
    expect(existsSync(sessions.sessionPath("forced-before"))).toBe(false);
    expect(await task.loop.run("next task")).toBe("Recovered next turn.");
  });

  it("preserves renamed disk and memory when the summary rewrite fails", async () => {
    const task = await startSummary();
    expect(sessions.renameSession("forced-before", "forced-after")).toBe(true);
    task.loop.rebindSession("forced-after");
    const before = task.loop.log.toFullHistory();
    const rewrite = vi.spyOn(sessions, "rewriteSession").mockImplementation(() => {
      throw new Error("synthetic disk full");
    });
    task.resolve(response("Uncommitted recap."));
    await task.pending;
    expect(rewrite).toHaveBeenCalledWith("forced-after", expect.any(Array));
    expect(task.events.some((event) => event.role === "error")).toBe(true);
    expect(task.events.some((event) => event.forcedSummary)).toBe(false);
    expect(task.loop.log.toFullHistory()).toEqual(before);
    expect(sessions.loadSessionMessages("forced-after")).toEqual(before);
    expect(existsSync(sessions.sessionPath("forced-before"))).toBe(false);
  });
});

describe("summary acceptance and cancellation", { retry: 0 }, () => {
  it.each([
    ["length", "Truncated recap", undefined],
    ["unknown", "Incomplete response", undefined],
    [
      "tool_calls",
      "I will read the file now",
      [{ id: "fake", type: "function", function: { name: "read_file", arguments: "{}" } }],
    ],
    [
      "stop",
      "I will read the file now",
      [{ id: "fake", type: "function", function: { name: "read_file", arguments: "{}" } }],
    ],
    ["stop", '<tool_call>{"name":"read_file"}</tool_call> Continuing.', undefined],
    ["stop", "<|DSML|function_calls><|DSML|invoke name=read_file>", undefined],
    ["stop", "<｜DSML｜function_calls><｜DSML｜invoke name=read_file>", undefined],
    ...["|", "｜"].flatMap((bar) =>
      ["", "/"].map((closing) => ["stop", `<${closing}${bar}DSML${bar}tool_calls>`, undefined]),
    ),
  ])("rejects invalid summary %s without changing history", async (finish, content, calls) => {
    const loop = makeLoop(vi.fn(async () => response(content, finish, calls)));
    const before = JSON.stringify(loop.log.toFullHistory());
    const result = await loop.compactHistory({ keepRecentTokens: 20 });
    expect(result).toMatchObject({ folded: false, reason: "summary-invalid" });
    expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
    expect(loop.stats.totalCost).toBeGreaterThan(0);
  });

  it("does not commit a summary after cancellation even if the provider ignores abort", async () => {
    let finish!: (value: Response) => void;
    const called = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const loop = makeLoop(called);
    const ctrl = new AbortController();
    const before = JSON.stringify(loop.log.toFullHistory());
    const pending = loop.compactHistory({ keepRecentTokens: 20, signal: ctrl.signal });
    await vi.waitFor(() => expect(called).toHaveBeenCalledTimes(1));
    ctrl.abort();
    expect(await pending).toMatchObject({ folded: false, reason: "summary-cancelled" });
    finish(response());
    await Promise.resolve();
    expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
  });

  it("stops manual compaction without aborting the following user turn", async () => {
    const called = vi.fn((_url: unknown, init?: RequestInit) => {
      if (called.mock.calls.length > 1) return Promise.resolve(response("Next turn succeeded."));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      });
    });
    const loop = makeLoop(called);
    const pending = loop.manualCompactHistory();
    await vi.waitFor(() => expect(called).toHaveBeenCalledTimes(1));
    loop.abort();
    expect(await pending).toMatchObject({ folded: false, reason: "summary-cancelled" });
    expect(await loop.run("new task")).toBe("Next turn succeeded.");
  });

  it("rejects duplicate manual compaction and automatically cancels it before the next turn", async () => {
    let requests = 0;
    const called = vi.fn((_url: unknown, init?: RequestInit) => {
      if (++requests > 1) return Promise.resolve(response("Recovered task."));
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        ),
      );
    });
    const loop = makeLoop(called);
    const compact = loop.manualCompactHistory();
    await vi.waitFor(() => expect(called).toHaveBeenCalledTimes(1));
    await expect(loop.manualCompactHistory()).rejects.toThrow("another compaction");
    expect(await loop.run("next task")).toBe("Recovered task.");
    expect(await compact).toMatchObject({ folded: false, reason: "summary-cancelled" });
    expect(called).toHaveBeenCalledTimes(2);
  });

  it("does not start an already-cancelled summary request", async () => {
    const called = vi.fn(async () => response());
    const client = new DeepSeekClient({
      apiKey: "synthetic",
      fetch: called,
      retry: { maxAttempts: 1 },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestFoldSummary(client, { model: "fake", messages: [], signal: controller.signal }, 1000),
    ).rejects.toMatchObject({ reason: "summary-cancelled" });
    expect(called).not.toHaveBeenCalled();
  });

  it("keeps the 15s default and separates deadline expiration from cancellation", async () => {
    expect(resolveHistorySummaryTimeoutMs(undefined)).toBe(15_000);
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 999, 300001, "5000"])
      expect(resolveHistorySummaryTimeoutMs(value)).toBe(15_000);
    expect(resolveHistorySummaryTimeoutMs(5000)).toBe(5000);
    vi.useFakeTimers();
    const client = new DeepSeekClient({
      apiKey: "synthetic",
      fetch: () => new Promise(() => {}),
      retry: { maxAttempts: 1 },
    });
    const request = requestFoldSummary(client, { model: "fake", messages: [] }, 1000);
    const assertion = expect(request).rejects.toMatchObject({ reason: "summary-timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("preserves memory if the durable summary rewrite fails", async () => {
    const loop = makeLoop(async () => response());
    const rewrite = vi.spyOn(sessions, "rewriteSession").mockImplementation(() => {
      throw new Error("disk full");
    });
    const manager = new ContextManager({
      client: loop.client,
      log: loop.log,
      stats: loop.stats,
      getSessionBinding: () => ({ sessionName: "synthetic-session", epoch: 1 }),
      getAbortSignal: () => new AbortController().signal,
      getCurrentTurn: () => 1,
      getSystemPrompt: () => "s",
    });
    const before = JSON.stringify(loop.log.toFullHistory());
    expect(await manager.fold(loop.model, { keepRecentTokens: 20 })).toMatchObject({
      folded: false,
      reason: "persistence-failed",
    });
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
  });

  it("does not commit an invalid forced summary or remove pending tool history", async () => {
    const loop = makeLoop(async () => response("truncated", "length"));
    loop.log.append({
      role: "assistant",
      content: "pending",
      tool_calls: [
        { id: "pending-call", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    });
    const before = JSON.stringify(loop.log.toFullHistory());
    const commit = vi.fn();
    const events = [];
    for await (const event of forceSummaryAfterGuard(
      {
        client: loop.client,
        signal: new AbortController().signal,
        buildMessages: () => loop.log.toFullHistory(),
        appendAndPersist: commit,
        recordStats: (model, usage) => loop.stats.record(1, model, usage),
        turn: 1,
        model: loop.model,
      },
      { reason: "context-guard" },
    ))
      events.push(event);
    expect(events.some((event) => event.role === "error")).toBe(true);
    expect(events.some((event) => event.role === "assistant_final")).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(loop.stats.totalCost).toBeGreaterThan(0);
    expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
  });

  it("applies the summary deadline to forced summaries too", async () => {
    vi.useFakeTimers();
    const loop = makeLoop(() => new Promise(() => {}));
    const events = [];
    const task = (async () => {
      for await (const event of forceSummaryAfterGuard(
        {
          client: loop.client,
          signal: new AbortController().signal,
          summaryTimeoutMs: 1000,
          buildMessages: () => loop.log.toFullHistory(),
          appendAndPersist: vi.fn(),
          recordStats: (model, usage) => loop.stats.record(1, model, usage),
          turn: 1,
          model: loop.model,
        },
        { reason: "context-guard" },
      ))
        events.push(event);
    })();
    await vi.advanceTimersByTimeAsync(1001);
    expect(events.some((event) => event.role === "error")).toBe(true);
    await task;
  });

  it("blocks oversized summary and ordinary payloads before contacting the provider", async () => {
    DEEPSEEK_CONTEXT_TOKENS["reliability-small-window"] = 2048;
    const called = vi.fn(async () => response());
    const loop = makeLoop(called, { baseUrl: "http://provider.invalid/v1" });
    loop.model = "reliability-small-window";
    const before = JSON.stringify(loop.log.toFullHistory());
    expect(await loop.compactHistory({ keepRecentTokens: 20 })).toMatchObject({ folded: false });
    expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
    await expect(
      loop.client.chat({ model: loop.model, messages: loop.log.toFullHistory() }),
    ).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", status: 400 });
    expect(called).not.toHaveBeenCalled();
  });

  it.each([
    [16000, "汉".repeat(1024) + "hello ".repeat(5000) + "汉".repeat(1024), true],
    [4096, "hello ".repeat(171) + "汉 ".repeat(5000) + "hello ".repeat(171), false],
  ])(
    "checks the entire mixed-language input for a %i token window",
    async (window, content, fits) => {
      DEEPSEEK_CONTEXT_TOKENS["reliability-small-window"] = window as number;
      const called = vi.fn(async () => response());
      const client = new DeepSeekClient({
        apiKey: "opaque-synthetic-credential",
        fetch: called,
        retry: { maxAttempts: 1 },
      });
      const request = client.chat({
        model: "reliability-small-window",
        messages: [{ role: "user", content: content as string }],
      });
      if (fits) {
        await expect(request).resolves.toMatchObject({ finishReason: "stop" });
        expect(called).toHaveBeenCalledTimes(1);
      } else {
        await expect(request).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED" });
        expect(called).not.toHaveBeenCalled();
      }
    },
  );

  it("cancelled precompaction does not poison a subsequent turn", async () => {
    DEEPSEEK_CONTEXT_TOKENS["reliability-small-window"] = 2048;
    const called = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          ),
        ),
    );
    const loop = makeLoop(called);
    loop.model = "reliability-small-window";
    const stream = loop.step("start");
    const first = await stream.next();
    expect(first.value).toMatchObject({ activity: "compaction", activityState: "running" });
    loop.abort();
    for await (const _event of stream) {
    }
    loop.model = "deepseek-flash";
    called.mockImplementation(async () => response("Clean next turn."));
    expect(await loop.run("continue")).toBe("Clean next turn.");
  });
});

it("redacts full Cookie headers and quoted diagnostic credential fields", { retry: 0 }, () => {
  const text =
    'HTTP 429 busy\nCookie: session=syntheticCookie; csrftoken=syntheticCSRF\n{"password":"syntheticPass", "api_key":"syntheticApiKey"}';
  const safe = sanitizeProviderErrorText(text);
  expect(safe).toContain("HTTP 429 busy");
  for (const secret of ["syntheticCookie", "syntheticCSRF", "syntheticPass", "syntheticApiKey"])
    expect(safe).not.toContain(secret);
});

const image: ImageAttachment = {
  kind: "image",
  id: "a".repeat(64),
  name: "old.png",
  mime: "image/png",
  bytes: 10,
  width: 1,
  height: 1,
};

describe("text-only requests after visual history", { retry: 0 }, () => {
  it("omits old pixels without reading images or mutating history", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "old visual task", attachments: [image] },
      { role: "assistant", content: "previously described" },
      { role: "user", content: "new text-only task" },
    ];
    const before = JSON.stringify(messages);
    const projected = await projectImages(messages, { supportsImages: false });
    expect(projected.snapshot).toMatchObject({ sent: [], omitted: [image.id], bytes: 0 });
    expect(JSON.stringify(projected.messages)).toContain("does not support images");
    expect(JSON.stringify(projected.messages)).not.toContain("data:image");
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("retains the current-image gate after a host adds a summary instruction", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "current visual task", attachments: [image] },
      { role: "user", content: "host instruction to summarize" },
    ];
    await expect(
      projectImages(messages, { supportsImages: false, activeImageIds: [image.id] }),
    ).rejects.toMatchObject({ code: "IMAGE_UNSUPPORTED" });
  });

  it("does not mistake repeated historical copies of the current image for new images", async () => {
    const messages: ChatMessage[] = Array.from({ length: MAX_REQUEST_IMAGES + 1 }, (_, index) => ({
      role: "user",
      content: `visual task ${index}`,
      attachments: [image],
    }));
    const store = {
      requestImage: vi.fn(async () => ({
        data: new Uint8Array([1]),
        width: 1,
        height: 1,
        mime: "image/png",
      })),
    } as unknown as AttachmentStore;
    const projected = await projectImages(messages, {
      supportsImages: true,
      activeImageIds: [image.id],
      store,
    });
    expect(projected.snapshot.sent).toHaveLength(MAX_REQUEST_IMAGES);
    expect(projected.snapshot.omitted).toEqual([image.id]);
  });

  it("sanitizes provider SSE errors with opaque credentials", async () => {
    const key = "opaque-synthetic-credential";
    const client = new DeepSeekClient({
      apiKey: key,
      baseUrl: "https://provider.invalid/v1",
      fetch: async () =>
        new Response(`data: ${JSON.stringify({ error: { message: `echoed ${key}` } })}\n\n`),
    });
    let error: Error | undefined;
    try {
      for await (const _chunk of client.stream({
        model: "fake",
        messages: [{ role: "user", content: "test" }],
      })) {
      }
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).not.toContain(key);
  });
});

it(
  "closes announced tools on a truncated stream before exposing the error",
  { retry: 0 },
  async () => {
    const client = {
      async *stream() {
        yield {
          raw: {},
          toolCallDeltas: [{ index: 0, name: "read_file", argumentsDelta: '{"path":' }],
        };
        throw new Error("stream truncated");
      },
    } as unknown as DeepSeekClient;
    const events = [];
    const consume = async () => {
      for await (const event of streamModelResponse({
        client,
        model: "fake",
        messages: [],
        toolSpecs: [],
        signal: new AbortController().signal,
        thinkingEnabled: false,
        reasoningEffort: "high",
        turn: 1,
        requestId: "truncated-request",
      }))
        events.push(event);
    };
    await expect(consume()).rejects.toThrow("stream truncated");
    expect(events.at(-1)).toMatchObject({
      role: "tool_call_drop",
      localCallId: "truncated-request:tool:0",
      terminalState: "dropped",
    });
  },
);
