import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import {
  compactionCandidates,
  compactionRequestTokens,
  isCompactionContextError,
  providerPromptBudget,
} from "../src/loop/compaction.js";
import { requestFoldSummary } from "../src/loop/summary.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ProviderHttpError } from "../src/provider-http-error.js";
import { DEEPSEEK_CONTEXT_TOKENS } from "../src/telemetry/stats.js";
import { countTokensBounded } from "../src/tokenizer.js";
import type { ChatMessage, ChatRequestOptions } from "../src/types.js";

const MODEL = "compaction-fitting-test";
const pad = "evidence goes here ".repeat(2000);
const response = () =>
  Response.json({ choices: [{ message: { content: "Facts." }, finish_reason: "stop" }] });
const providerError = (message: string, status = 400) =>
  new ProviderHttpError({
    status,
    baseUrl: "https://synthetic.invalid",
    rawBody: JSON.stringify({ error: { message } }),
  });
const flashWindow = DEEPSEEK_CONTEXT_TOKENS["deepseek-flash"]!;
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete DEEPSEEK_CONTEXT_TOKENS[MODEL];
  DEEPSEEK_CONTEXT_TOKENS["deepseek-flash"] = flashWindow;
});

function fixture(): ChatRequestOptions {
  return {
    model: MODEL,
    messages: [
      { role: "system", content: "Live prefix, do NOT publish." },
      { role: "user", content: "Original user intent, never delete." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "old",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "a.ts", data: pad }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "old", content: pad },
      { role: "user", content: "Newest exchange" },
      {
        role: "assistant",
        content: "Newest content",
        reasoning_content: pad,
        tool_calls: [
          {
            id: "new",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ data: pad }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "new", content: pad },
      { role: "user", content: "Summarize" },
    ],
  };
}

describe("compaction fitting contracts", { retry: 0 }, () => {
  it("reduces old results then args, preserving intent, newest exchange, pairing and source references", () => {
    const request = fixture();
    const source = {
      kind: "image" as const,
      id: "a".repeat(64),
      name: "original.png",
      bytes: 10,
      width: 1,
      height: 1,
      mime: "image/png" as const,
    };
    request.messages[3]!.sourceAttachments = [source];
    const before = JSON.stringify(request);
    const candidates = [...compactionCandidates(request, { historyStart: 1, historyEnd: 7 })];
    expect(candidates).toHaveLength(8);
    expect(candidates[1]!.messages[3]!.content!.length).toBeLessThan(
      request.messages[3]!.content!.length,
    );
    expect(candidates[2]!.messages[3]!.content!.length).toBeLessThan(
      candidates[1]!.messages[3]!.content!.length,
    );
    expect(candidates[1]!.messages[2]!.tool_calls).toEqual(request.messages[2]!.tool_calls);
    expect(candidates[3]!.messages[2]!.tool_calls![0]!.function.arguments).toContain("a.ts");
    expect(candidates[3]!.messages[2]!.tool_calls![0]!.function.arguments.length).toBeLessThan(
      request.messages[2]!.tool_calls![0]!.function.arguments.length,
    );
    for (const candidate of candidates.slice(0, -1)) {
      expect(candidate.messages[0]).toEqual(request.messages[0]);
      expect(candidate.messages[1]).toEqual(request.messages[1]);
      expect(candidate.messages.slice(4)).toEqual(request.messages.slice(4));
      expect(candidate.messages[2]!.tool_calls![0]!.id).toBe(candidate.messages[3]!.tool_call_id);
      expect(candidate.messages[3]!.sourceAttachments).toEqual([source]);
    }
    expect(candidates.at(-1)!.messages[3]!.sourceAttachments).toEqual([source]);
    expect(JSON.stringify(request)).toBe(before);
  });

  it.each([
    [new Error("context length exceeded"), false],
    [Object.assign(new Error("explicit local"), { code: "CONTEXT_WINDOW_EXCEEDED" }), true],
    [providerError("context_length_exceeded"), true],
    [providerError("maximum context length is 4096 tokens"), true],
    [providerError("maximum input length is 4096 tokens", 413), true],
    [providerError("payload too large", 413), false],
    [providerError("context_length_exceeded", 429), false],
    [providerError("context_length_exceeded", 401), false],
    [providerError("does not support image input"), false],
    [providerError("invalid max_tokens parameter"), false],
  ])("classifies only explicit evidence (%s)", (error, expected) => {
    expect(isCompactionContextError(error)).toBe(expected);
  });

  it("reserves output once for explicit total windows, never for prompt-side windows", () => {
    const request = fixture();
    const total = providerError(
      "maximum context length is 4096 tokens; requested 5000 tokens (4000 in the messages, 1000 in the completion)",
    );
    expect(providerPromptBudget(total, request)).toBe(3072);
    expect(
      providerPromptBudget(providerError("maximum context length is 4096 tokens"), request),
    ).toBe(4096);
    expect(request.maxTokens).toBe(1024);
    expect(providerPromptBudget(total, request)).toBe(3072);
    expect(
      providerPromptBudget(providerError("maximum input length is 4096 tokens"), request),
    ).toBe(4096);
  });

  it("does not subtract maxTokens from the configured prompt-side limit", async () => {
    const request: ChatRequestOptions = {
      model: MODEL,
      maxTokens: 8192,
      messages: [{ role: "user", content: "keep exactly" }],
    };
    const fetch = vi.fn(async () => response());
    const client = new DeepSeekClient({ apiKey: "synthetic", fetch });
    DEEPSEEK_CONTEXT_TOKENS[MODEL] = await compactionRequestTokens(client, request);
    await expect(
      requestFoldSummary(client, request, 1000, { historyStart: 0, historyEnd: 1 }),
    ).resolves.toMatchObject({ content: "Facts." });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "retries unchanged input after lowering output once (provider accepts: %s)",
    async (accepts) => {
      const bodies: { messages: ChatMessage[]; max_tokens?: number }[] = [];
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(init!.body as string));
        if (accepts && bodies.length === 2) return response();
        return Response.json(
          {
            error: {
              message:
                "maximum context length is 4096 tokens; requested 8200 tokens (8 in the messages, 8192 in the completion)",
            },
          },
          { status: 400 },
        );
      });
      const client = new DeepSeekClient({
        apiKey: "synthetic",
        baseUrl: "https://synthetic.invalid/v1",
        fetch,
      });
      const request: ChatRequestOptions = {
        model: MODEL,
        maxTokens: 8192,
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "hello" },
          { role: "assistant", content: "ack" },
          { role: "user", content: "summarize" },
        ],
      };
      const before = JSON.stringify(request);
      const summary = requestFoldSummary(client, request, 1000, { historyStart: 1, historyEnd: 3 });
      if (accepts)
        await expect(summary).resolves.toMatchObject({
          content: "Facts.",
          contextBudget: { model: MODEL, promptTokens: 3072 },
        });
      else await expect(summary).rejects.toMatchObject({ reason: "summary-over-limit" });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(bodies[0]!.max_tokens).toBe(8192);
      expect(bodies[1]!.max_tokens).toBe(1024);
      expect(bodies[1]!.messages).toEqual(bodies[0]!.messages);
      expect(JSON.stringify(request)).toBe(before);
    },
  );

  it("keeps the same deadline when retrying only a smaller output cap", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return Response.json(
        {
          error: {
            message:
              "maximum context length is 4096 tokens; requested 8200 tokens (8 in the messages, 8192 in the completion)",
          },
        },
        { status: 400 },
      );
    });
    const client = new DeepSeekClient({
      apiKey: "synthetic",
      baseUrl: "https://synthetic.invalid/v1",
      fetch,
    });
    const summary = requestFoldSummary(
      client,
      {
        model: MODEL,
        maxTokens: 8192,
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "hello" },
          { role: "assistant", content: "ack" },
          { role: "user", content: "summarize" },
        ],
      },
      1000,
      { historyStart: 1, historyEnd: 3 },
    );
    const outcome = summary.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toMatchObject({ error: { reason: "summary-timeout" } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds all provider attempts, including when every reduction is rejected", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: { message: "context_length_exceeded" } }, { status: 400 }),
    );
    const client = new DeepSeekClient({ apiKey: "synthetic", fetch });
    const request = fixture();
    await expect(
      requestFoldSummary(client, request, 2000, { historyStart: 1, historyEnd: 7 }),
    ).rejects.toMatchObject({ reason: "summary-over-limit" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fits Flash rather than the larger active session model", async () => {
    DEEPSEEK_CONTEXT_TOKENS["deepseek-flash"] = 6000;
    const bodies: ChatRequestOptions[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return response();
    });
    const client = new DeepSeekClient({ apiKey: "synthetic", fetch });
    const loop = new CacheFirstLoop({
      client,
      model: "deepseek-v4-pro",
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    const request = fixture();
    // Newest exchange is small; only older tool payloads need recovery.
    for (const message of request.messages.slice(1, 5)) loop.log.append(message);
    loop.log.append({ role: "assistant", content: "newest answer" });
    expect(await loop.compactHistory({ keepRecentTokens: 0 })).toMatchObject({ folded: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bodies[0]!.model).toBe("deepseek-flash");
    expect(JSON.stringify(bodies[0])).not.toContain(pad);
  });

  it("can complete a text-transcript fallback when only the summary model has a schema limit", async () => {
    DEEPSEEK_CONTEXT_TOKENS["deepseek-flash"] = 6000;
    const bodies: ChatRequestOptions[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return response();
    });
    const specs = [
      {
        type: "function" as const,
        function: { name: "read", description: pad.repeat(2), parameters: { type: "object" } },
      },
    ];
    const prefix = new ImmutablePrefix({ system: "s", toolSpecs: specs });
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "synthetic", fetch }),
      model: "deepseek-v4-pro",
      prefix,
      stream: false,
    });
    for (const message of fixture().messages.slice(1, 5)) loop.log.append(message);
    loop.log.append({ role: "assistant", content: "newest reply" });
    expect(await loop.compactHistory({ keepRecentTokens: 0 })).toMatchObject({ folded: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bodies[0]!.model).toBe("deepseek-flash");
    expect(bodies[0]!.tools).toBeUndefined();
    expect(JSON.stringify(bodies[0]!.messages)).toContain("text-only transcript");
    expect(prefix.toolSpecs).toEqual(specs);
    expect(prefix.system).toBe("s");
  });

  it.each(["fewshots", "constraints", "request-context", "tail", "retained-user"])(
    "validates the complete replacement including %s",
    async (part) => {
      DEEPSEEK_CONTEXT_TOKENS[MODEL] = 8000;
      const fetch = vi.fn(async () => response());
      const prefix = new ImmutablePrefix({
        system: part === "constraints" ? `# HIGH PRIORITY constraints\n${pad.repeat(3)}` : "s",
        fewShots: part === "fewshots" ? [{ role: "user", content: pad.repeat(3) }] : [],
      });
      const client = new DeepSeekClient({ apiKey: "synthetic", fetch });
      const loop = new CacheFirstLoop({ client, model: MODEL, prefix, stream: false });
      loop.log.append({ role: "user", content: "intent" });
      loop.log.append({ role: "assistant", content: part === "tail" ? pad.repeat(5) : pad });
      loop.log.append({ role: "user", content: part === "tail" ? pad.repeat(3) : "newest" });
      loop.log.append({ role: "assistant", content: "newest reply" });
      if (part === "retained-user") {
        // Exact user excerpts are capped per turn but accumulate independently of the summary.
        for (let i = 0; i < 30; i++) {
          loop.log.append({ role: "user", content: "汉字".repeat(300) });
          loop.log.append({ role: "assistant", content: "ack" });
        }
        DEEPSEEK_CONTEXT_TOKENS[MODEL] = 4000;
      }
      if (part === "request-context") {
        const turn = loop.step("current user", { requestContext: pad.repeat(3) });
        expect((await turn.next()).value).toMatchObject({ activity: "compaction" });
        const before = JSON.stringify(loop.log.toFullHistory());
        for await (const _event of turn) {
          /* finish */
        }
        expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
        expect(fetch).toHaveBeenCalledTimes(1);
      } else {
        // Isolate final validation: the provider's accepted output does not prove
        // that the reconstructed next request will fit.
        const before = JSON.stringify(loop.log.toFullHistory());
        expect(
          await loop.compactHistory({
            keepRecentTokens: part === "tail" ? countTokensBounded(pad.repeat(3)) + 20 : 0,
          }),
        ).toMatchObject({ folded: false, reason: "replacement-over-limit" });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
      }
    },
  );
});
