import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop, type LoopEvent } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ToolRegistry } from "../src/tools.js";

function modelResponse(args: {
  content?: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}): Response {
  return Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content: args.content ?? "",
          tool_calls: args.toolCalls,
        },
        finish_reason: args.toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 10,
    },
  });
}

async function collect(events: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const collected: LoopEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("manual model API retry", () => {
  it("continues after completed tools without appending another user message or rerunning tools", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        modelResponse({
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "write_once", arguments: '{"value":"done"}' },
            },
          ],
        }),
      )
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockResolvedValueOnce(modelResponse({ content: "finished" })) as unknown as typeof fetch;
    const writeOnce = vi.fn(async ({ value }: { value: string }) => value);
    const tools = new ToolRegistry().register({
      name: "write_once",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      fn: writeOnce,
    });
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({
        apiKey: "sk-test",
        fetch,
        retry: { maxAttempts: 1 },
      }),
      prefix: new ImmutablePrefix({ system: "test", toolSpecs: tools.specs() }),
      tools,
      stream: false,
    });

    const failed = await collect(loop.step("perform the operation"));

    expect(failed.find((event) => event.role === "error")?.errorDetail?.retryable).toBe(true);
    expect(loop.canRetryFailedModelRequest()).toBe(true);
    expect(loop.lastUserText()).toBe("perform the operation");
    expect(writeOnce).toHaveBeenCalledTimes(1);

    const resumed = await collect(loop.retryFailedModelRequest());

    expect(resumed.find((event) => event.role === "assistant_final")?.content).toBe("finished");
    expect(loop.currentTurn).toBe(1);
    expect(loop.log.toFullHistory().filter((message) => message.role === "user")).toHaveLength(1);
    expect(writeOnce).toHaveBeenCalledTimes(1);
    expect(loop.canRetryFailedModelRequest()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not offer continuation for a non-retryable API response", async () => {
    const fetch = vi.fn(
      async () => new Response("bad key", { status: 401 }),
    ) as unknown as typeof fetch;
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch, retry: { maxAttempts: 1 } }),
      prefix: new ImmutablePrefix({ system: "test" }),
      stream: false,
    });

    await collect(loop.step("hello"));

    expect(loop.canRetryFailedModelRequest()).toBe(false);
    expect(() => loop.retryFailedModelRequest()).toThrow(/no retryable failed model request/i);
  });

  it("invalidates a failed-request retry when a new user turn starts", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockResolvedValueOnce(
        modelResponse({ content: "new turn completed" }),
      ) as unknown as typeof fetch;
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch, retry: { maxAttempts: 1 } }),
      prefix: new ImmutablePrefix({ system: "test" }),
      stream: false,
    });

    await collect(loop.step("failed turn"));
    expect(loop.canRetryFailedModelRequest()).toBe(true);

    const nextTurn = await collect(loop.step("new turn"));

    expect(nextTurn.find((event) => event.role === "assistant_final")?.content).toBe(
      "new turn completed",
    );
    expect(loop.canRetryFailedModelRequest()).toBe(false);
    expect(() => loop.retryFailedModelRequest()).toThrow(/no retryable failed model request/i);
  });
});
