import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { HISTORY_FOLD_MARKER } from "../src/context-manager.js";
import { CacheFirstLoop } from "../src/loop.js";
import * as compaction from "../src/loop/compaction.js";
import { requestFoldSummary } from "../src/loop/summary.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { rewriteSession, sessionPath } from "../src/memory/session.js";
import { DEEPSEEK_CONTEXT_TOKENS } from "../src/telemetry/stats.js";
import { countTokensBounded } from "../src/tokenizer.js";
import type { ChatMessage, ChatRequestOptions, ToolSpec } from "../src/types.js";

const MODEL = "compaction-recovery-test";
const padding = "durable context evidence ".repeat(700);
const tools: ToolSpec[] = [
  {
    type: "function",
    function: { name: "read", description: "Read", parameters: { type: "object" } },
  },
];
const result = (content = "Facts and open work.") =>
  Response.json({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
const failure = (status: number, message: string) =>
  Response.json({ error: { message } }, { status });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  delete DEEPSEEK_CONTEXT_TOKENS[MODEL];
});

function makeLoop(
  fetch: typeof globalThis.fetch,
  prefix = new ImmutablePrefix({ system: "s", toolSpecs: tools }),
) {
  const client = new DeepSeekClient({
    apiKey: "synthetic",
    baseUrl: "https://synthetic.invalid/v1",
    fetch,
  });
  const loop = new CacheFirstLoop({ client, prefix, model: MODEL, stream: false });
  loop.log.append({ role: "user", content: "Do NOT publish; preserve user intent." });
  loop.log.append({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "old",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: "src/a.ts", data: padding }) },
      },
    ],
  });
  loop.log.append({ role: "tool", tool_call_id: "old", content: padding });
  loop.log.append({ role: "user", content: "Newest exchange stays exact." });
  loop.log.append({ role: "assistant", content: "Newest answer." });
  return loop;
}

describe("bounded compaction recovery", { retry: 0 }, () => {
  it.each([false, true])(
    "applies the learned provider input budget only to the same model (different: %s)",
    async (differentModel) => {
      const home = mkdtempSync(join(tmpdir(), "jupiter-compaction-provider-budget-"));
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      try {
        DEEPSEEK_CONTEXT_TOKENS[MODEL] = 16000;
        const tokens: number[] = [];
        const models: string[] = [];
        const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
          const request = JSON.parse(init!.body as string) as ChatRequestOptions;
          models.push(request.model);
          const inputTokens = await compaction.compactionRequestTokens(client, request);
          tokens.push(inputTokens);
          return inputTokens > 1024
            ? failure(400, "maximum input length is 1024 tokens")
            : result();
        });
        const client = new DeepSeekClient({
          apiKey: "synthetic",
          fetch,
          ...(differentModel ? {} : { baseUrl: "https://synthetic.invalid/v1" }),
        });
        const loop = new CacheFirstLoop({
          client,
          model: MODEL,
          prefix: new ImmutablePrefix({ system: "s" }),
          stream: false,
        });
        const tailText = "retained evidence ".repeat(2000);
        const history: ChatMessage[] = [
          { role: "user", content: "Do NOT publish." },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "old", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "old", content: "old evidence ".repeat(6000) },
          { role: "user", content: "Newest head exchange." },
          { role: "assistant", content: "boundary padding ".repeat(100) },
          { role: "user", content: tailText },
          { role: "assistant", content: "Tail answer." },
        ];
        for (const message of history) loop.log.append(message);
        loop.rebindSession("provider-budget");
        rewriteSession("provider-budget", loop.log.toFullHistory());
        const before = JSON.stringify(loop.log.toFullHistory());
        const disk = readFileSync(sessionPath("provider-budget"), "utf8");
        const folded = await loop.compactHistory({
          keepRecentTokens: countTokensBounded(tailText) + 20,
        });
        expect(tokens).toHaveLength(2);
        expect(tokens[0]).toBeGreaterThan(1024);
        expect(tokens[1]).toBeLessThanOrEqual(1024);
        expect(models).toEqual([
          differentModel ? "deepseek-flash" : MODEL,
          differentModel ? "deepseek-flash" : MODEL,
        ]);
        if (differentModel) {
          expect(folded.folded).toBe(true);
          expect(loop.log.toFullHistory().some((message) => message.content === tailText)).toBe(
            true,
          );
        } else {
          expect(folded).toMatchObject({ folded: false, reason: "replacement-over-limit" });
          expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
          expect(readFileSync(sessionPath("provider-budget"), "utf8")).toBe(disk);
        }
        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("retries explicit provider context errors on copies, reducing results before arguments", async () => {
    const bodies: { messages: ChatMessage[]; tools: ToolSpec[] }[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return bodies.length === 1
        ? failure(400, "context_length_exceeded: maximum context length exceeded")
        : result();
    });
    const loop = makeLoop(fetch);
    const before = JSON.stringify(loop.log.toFullHistory());
    expect(await loop.compactHistory({ keepRecentTokens: 0 })).toMatchObject({ folded: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodies[0]!.tools).toEqual(tools);
    const firstTool = bodies[0]!.messages.find((m) => m.role === "tool")!;
    const nextTool = bodies[1]!.messages.find((m) => m.role === "tool")!;
    expect(nextTool.content!.length).toBeLessThan(firstTool.content!.length);
    expect(bodies[1]!.messages.find((m) => m.tool_calls)?.tool_calls).toEqual(
      bodies[0]!.messages.find((m) => m.tool_calls)?.tool_calls,
    );
    expect(
      bodies[1]!.messages.some((m) => m.content === "Do NOT publish; preserve user intent."),
    ).toBe(true);
    expect(bodies[1]!.messages.some((m) => m.content === "Newest exchange stays exact.")).toBe(
      true,
    );
    expect(before).toContain(padding);
  });

  it.each([
    [400, "bad request"],
    [413, "payload too large"],
    [401, "context length exceeded"],
    [429, "context length exceeded"],
    [400, "image input not supported"],
  ])("does not degrade on HTTP %i %s (including nested retries)", async (status, message) => {
    const fetch = vi.fn(async () => failure(status, message));
    const loop = makeLoop(fetch);
    const before = JSON.stringify(loop.log.toFullHistory());
    expect(await loop.compactHistory({ keepRecentTokens: 0 })).toMatchObject({ folded: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
  });

  it("does not retry network failures", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const loop = makeLoop(fetch);
    const before = JSON.stringify(loop.log.toFullHistory());
    expect(await loop.compactHistory({ keepRecentTokens: 0 })).toMatchObject({ folded: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
  });

  it("fits the actual summary model and uses an explicit transcript when schemas cannot fit", async () => {
    DEEPSEEK_CONTEXT_TOKENS[MODEL] = 6000;
    const giantTools = [
      { ...tools[0]!, function: { ...tools[0]!.function, description: padding.repeat(4) } },
    ];
    const captured: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(init!.body as string));
      return result();
    });
    const loop = makeLoop(fetch, new ImmutablePrefix({ system: "s", toolSpecs: giantTools }));
    const before = JSON.stringify(loop.log.toFullHistory());
    const fold = await loop.compactHistory({ keepRecentTokens: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(captured[0]!.model).toBe(MODEL);
    expect(captured[0]!.tools).toBeUndefined();
    expect(JSON.stringify(captured[0]!.messages)).toContain("transcript");
    // The same huge live schemas still prevent a safe replacement.
    expect(fold).toMatchObject({ folded: false, reason: "replacement-over-limit" });
    expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
    expect(loop.prefix.toolSpecs).toEqual(giantTools);
  });

  it("rejects a valid but oversized replacement including full pinned skill bodies", async () => {
    DEEPSEEK_CONTEXT_TOKENS[MODEL] = 4500;
    const fetch = vi.fn(async () => result());
    const loop = makeLoop(fetch);
    loop.log.append({
      role: "tool",
      tool_call_id: "orphan",
      content: `<skill-pin name="large">\n${padding.repeat(3)}\n</skill-pin>`,
    });
    const before = JSON.stringify(loop.log.toFullHistory());
    expect(await loop.compactHistory({ keepRecentTokens: 0 })).toMatchObject({
      folded: false,
      reason: "replacement-over-limit",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
  });

  it("turn-start preflight leaves disk and log unchanged after the user was persisted", async () => {
    const home = mkdtempSync(join(tmpdir(), "jupiter-compaction-preflight-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    try {
      DEEPSEEK_CONTEXT_TOKENS[MODEL] = 2000;
      const fetch = vi.fn(async () => failure(400, "bad request"));
      const loop = makeLoop(fetch);
      loop.rebindSession("preflight");
      loop.log.append({
        role: "tool",
        tool_call_id: "unpaired",
        content: "must not be healed on failure",
      });
      const turn = loop.step("current user");
      expect((await turn.next()).value).toMatchObject({
        activity: "compaction",
        activityState: "running",
      });
      const before = JSON.stringify(loop.log.toFullHistory());
      const disk = readFileSync(sessionPath("preflight"), "utf8");
      for await (const _event of turn) {
        /* consume the failed preflight */
      }
      expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
      expect(readFileSync(sessionPath("preflight"), "utf8")).toBe(disk);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("shares one deadline across provider recovery attempts", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return failure(400, "maximum context length exceeded");
    });
    const loop = makeLoop(fetch);
    const history = loop.log.toFullHistory();
    const request = requestFoldSummary(
      loop.client,
      {
        model: MODEL,
        messages: [...history, { role: "user", content: "Summarize" }],
      },
      1000,
      { historyStart: 0, historyEnd: history.length },
    );
    const assertion = expect(request).rejects.toMatchObject({ reason: "summary-timeout" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2), { interval: 1, timeout: 200 });
    await vi.advanceTimersByTimeAsync(400);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["cancel", "epoch", "log"])(
    "rejects %s changes while validating the replacement",
    async (change) => {
      const fetch = vi.fn(async () => result());
      const loop = makeLoop(fetch);
      const before = JSON.stringify(loop.log.toFullHistory());
      const controller = new AbortController();
      const originalCount = compaction.compactionRequestTokens;
      let started!: () => void;
      const validating = new Promise<void>((resolve) => {
        started = resolve;
      });
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(compaction, "compactionRequestTokens").mockImplementation(
        async (client, request) => {
          if (
            request.messages.some((message) => message.content?.startsWith(HISTORY_FOLD_MARKER))
          ) {
            started();
            await hold;
          }
          return originalCount(client, request);
        },
      );
      const fold = loop.compactHistory({ keepRecentTokens: 0, signal: controller.signal });
      await validating;
      if (change === "cancel") controller.abort();
      if (change === "epoch") loop.rebindSession(null, { logicalSessionChanged: true });
      if (change === "log") loop.log.append({ role: "user", content: "concurrent append" });
      const expectedLog = JSON.stringify(loop.log.toFullHistory());
      release();
      expect(await fold).toMatchObject({
        folded: false,
        reason:
          change === "cancel"
            ? "summary-cancelled"
            : change === "epoch"
              ? "session-changed"
              : "log-changed",
      });
      expect(JSON.stringify(loop.log.toFullHistory())).toBe(expectedLog);
      if (change !== "log") expect(expectedLog).toBe(before);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("includes final replacement validation in the original deadline", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => result());
    const loop = makeLoop(fetch);
    const before = JSON.stringify(loop.log.toFullHistory());
    const originalCount = compaction.compactionRequestTokens;
    let started!: () => void;
    const validating = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(compaction, "compactionRequestTokens").mockImplementation(async (client, request) => {
      if (request.messages.some((message) => message.content?.startsWith(HISTORY_FOLD_MARKER))) {
        started();
        return new Promise<number>(() => {});
      }
      return originalCount(client, request);
    });
    const fold = loop.compactHistory({ keepRecentTokens: 0 });
    await validating;
    await vi.advanceTimersByTimeAsync(15000);
    expect(await fold).toMatchObject({ folded: false, reason: "summary-timeout" });
    expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves durable history when an accepted summary cannot fit the next request", async () => {
    const home = mkdtempSync(join(tmpdir(), "jupiter-compaction-replacement-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    try {
      DEEPSEEK_CONTEXT_TOKENS[MODEL] = 4500;
      const fetch = vi.fn(async () => result(padding.repeat(4)));
      const loop = makeLoop(fetch);
      loop.rebindSession("replacement");
      const before = JSON.stringify(loop.log.toFullHistory());
      rewriteSession("replacement", loop.log.toFullHistory());
      const disk = readFileSync(sessionPath("replacement"), "utf8");
      expect(await loop.compactHistory({ keepRecentTokens: 0 })).toMatchObject({
        folded: false,
        reason: "replacement-over-limit",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
      expect(readFileSync(sessionPath("replacement"), "utf8")).toBe(disk);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
