import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { ContextManager, HISTORY_FOLD_MARKER } from "../src/context-manager.js";
import { CacheFirstLoop } from "../src/loop.js";
import { compactionRequestTokens } from "../src/loop/compaction.js";
import * as continuation from "../src/loop/continuation.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import * as sessions from "../src/memory/session.js";
import { DEEPSEEK_CONTEXT_TOKENS } from "../src/telemetry/stats.js";
import type { ChatMessage, ChatRequestOptions } from "../src/types.js";

const MODEL = "compaction-total-output-test";
interface WireRequest extends ChatRequestOptions {
  max_tokens?: number;
}
const summaryRequest = (request: WireRequest) =>
  request.messages.at(-1)?.content?.startsWith("Summarize the conversation above");
function reply(content = "Facts.", stream = false, finish = "stop") {
  const usage = { prompt_tokens: 71, completion_tokens: 10, total_tokens: 81 };
  if (!stream)
    return Response.json({ choices: [{ message: { content }, finish_reason: finish }], usage });
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }], usage })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
const rejection = (input: number, output: number) =>
  Response.json(
    {
      error: {
        message: `maximum context length is 4096 tokens; requested ${input + output} tokens (${input} in the messages, ${output} in the completion)`,
      },
    },
    { status: 400 },
  );
function seed(loop: CacheFirstLoop) {
  loop.log.append({ role: "user", content: "hello" });
  loop.log.append({ role: "assistant", content: "ack" });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete DEEPSEEK_CONTEXT_TOKENS[MODEL];
});

describe("committed fold output reserve reaches the next real request", { retry: 0 }, () => {
  it.each([false, true])(
    "executes loop.step after a total-window fold (stream: %s)",
    async (stream) => {
      DEEPSEEK_CONTEXT_TOKENS[MODEL] = 16000;
      const bodies: WireRequest[] = [];
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const request = JSON.parse(init!.body as string) as WireRequest;
        bodies.push(request);
        const input = await compactionRequestTokens(client, request);
        const output = request.max_tokens ?? 8192;
        if (request.model === MODEL && input + output > 4096) return rejection(input, output);
        return reply(summaryRequest(request) ? "Facts." : "Continued safely.", !!request.stream);
      });
      const client = new DeepSeekClient({
        apiKey: "synthetic",
        baseUrl: "https://synthetic.invalid/v1",
        fetch,
        retry: { maxAttempts: 1 },
      });
      const loop = new CacheFirstLoop({
        client,
        model: MODEL,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream,
      });
      seed(loop);
      expect(await loop.compactHistory({ keepRecentTokens: 0 })).toMatchObject({ folded: true });
      expect(loop.log.toFullHistory()[0]!.content).toContain(HISTORY_FOLD_MARKER);
      const events = [];
      for await (const event of loop.step("continue")) events.push(event);
      expect(events.filter((event) => event.role === "error")).toEqual([]);
      expect(events.find((event) => event.role === "assistant_final")?.content).toBe(
        "Continued safely.",
      );
      expect(bodies).toHaveLength(3);
      expect(bodies.map((body) => body.max_tokens)).toEqual([undefined, 1024, 1024]);
      expect(bodies[2]!.stream).toBe(stream);
      // Runtime-local caps are scoped to the model, not every provider request.
      loop.configure({ model: "unrelated-model" });
      await loop.run("another model");
      expect(bodies.at(-1)!.max_tokens).toBeUndefined();
      loop.configure({ model: MODEL });
      await loop.run("original model");
      expect(bodies.at(-1)!.max_tokens).toBe(1024);
    },
  );

  it.each([false, true])(
    "takes the minimum of learned and existing continuation caps (stream: %s)",
    async (stream) => {
      const bodies: WireRequest[] = [];
      let mainCalls = 0;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const request = JSON.parse(init!.body as string) as WireRequest;
        bodies.push(request);
        if (summaryRequest(request)) {
          if (request.max_tokens === undefined) return rejection(160, 8192);
          return reply();
        }
        mainCalls++;
        return reply(
          mainCalls % 2 ? "Partial." : "Complete.",
          !!request.stream,
          mainCalls % 2 ? "length" : "stop",
        );
      });
      const client = new DeepSeekClient({
        apiKey: "synthetic",
        baseUrl: "https://synthetic.invalid/v1",
        fetch,
      });
      const loop = new CacheFirstLoop({
        client,
        model: MODEL,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream,
      });
      seed(loop);
      expect(await loop.compactHistory({ keepRecentTokens: 0 })).toMatchObject({ folded: true });
      for (const planned of [2048, 512]) {
        const plan = vi
          .spyOn(continuation, "planPrefixContinuation")
          .mockImplementation((options) =>
            options.finishReason === "length"
              ? { maxTokens: planned, messages: options.messages }
              : null,
          );
        const events = [];
        for await (const event of loop.step("continue")) events.push(event);
        expect(events.filter((event) => event.role === "error")).toEqual([]);
        expect(bodies.at(-2)!.max_tokens).toBe(1024);
        expect(bodies.at(-1)!.max_tokens).toBe(Math.min(planned, 1024));
        expect(bodies.at(-1)!.stream).toBe(stream);
        plan.mockRestore();
      }
    },
  );

  it.each(["invalid", "cancel", "stale", "persist", "replacement"])(
    "does not install an output cap after %s failure",
    async (failure) => {
      const home = mkdtempSync(join(tmpdir(), "jupiter-fold-output-cap-"));
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      try {
        const bodies: WireRequest[] = [];
        const controller = new AbortController();
        let failedRewrite: ReturnType<typeof vi.spyOn> | undefined;
        const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
          const request = JSON.parse(init!.body as string) as WireRequest;
          bodies.push(request);
          if (!summaryRequest(request)) return reply("Next ordinary request.");
          if (request.max_tokens === undefined) return rejection(160, 8192);
          if (failure === "cancel") controller.abort();
          if (failure === "stale") loop.rebindSession("session", { logicalSessionChanged: true });
          if (failure === "persist")
            failedRewrite = vi.spyOn(sessions, "rewriteSession").mockImplementation(() => {
              throw new Error("synthetic disk failure");
            });
          return reply(
            failure === "invalid"
              ? "<tool_call>invalid</tool_call>"
              : failure === "replacement"
                ? "oversized facts ".repeat(4000)
                : "Facts.",
          );
        });
        const client = new DeepSeekClient({
          apiKey: "synthetic",
          baseUrl: "https://synthetic.invalid/v1",
          fetch,
        });
        const loop = new CacheFirstLoop({
          client,
          model: MODEL,
          prefix: new ImmutablePrefix({ system: "s" }),
          stream: false,
        });
        seed(loop);
        loop.rebindSession("session");
        sessions.rewriteSession("session", loop.log.toFullHistory());
        const before = JSON.stringify(loop.log.toFullHistory());
        const disk = readFileSync(sessions.sessionPath("session"), "utf8");
        expect(
          await loop.compactHistory({ keepRecentTokens: 0, signal: controller.signal }),
        ).toMatchObject({ folded: false });
        failedRewrite?.mockRestore();
        expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
        expect(readFileSync(sessions.sessionPath("session"), "utf8")).toBe(disk);
        await loop.run("continue after failed fold");
        expect(bodies.at(-1)!.max_tokens).toBeUndefined();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("refuses a total-window replacement when no host can preserve its output reserve", async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(init!.body as string) as WireRequest;
      return request.max_tokens === undefined ? rejection(160, 8192) : reply();
    });
    const client = new DeepSeekClient({
      apiKey: "synthetic",
      baseUrl: "https://synthetic.invalid/v1",
      fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      model: MODEL,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seed(loop);
    const manager = new ContextManager({
      client,
      log: loop.log,
      stats: loop.stats,
      getSessionBinding: () => ({ sessionName: null, epoch: 0 }),
      getAbortSignal: () => new AbortController().signal,
      getCurrentTurn: () => 0,
      getSystemPrompt: () => "s",
    });
    const before = JSON.stringify(loop.log.toFullHistory());
    expect(await manager.fold(MODEL, { keepRecentTokens: 0 })).toMatchObject({ folded: false });
    expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
