import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { HISTORY_FOLD_MARKER } from "../src/context-manager.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { DEEPSEEK_CONTEXT_TOKENS } from "../src/telemetry/stats.js";
import { ToolRegistry } from "../src/tools.js";
import type { ChatMessage } from "../src/types.js";

const MODEL = "main-recovery-fixture";
type Wire = { messages: ChatMessage[]; stream?: boolean; max_tokens?: number };
const summary = (wire: Wire) =>
  wire.messages.at(-1)?.content?.startsWith("Summarize the conversation above");
function reply(content: string, tool = false) {
  return Response.json({
    choices: [
      {
        message: {
          content,
          ...(tool
            ? {
                tool_calls: [
                  { id: "once", type: "function", function: { name: "once", arguments: "{}" } },
                ],
              }
            : {}),
        },
        finish_reason: tool ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 5 },
  });
}
const overflow = () =>
  Response.json({ error: { message: "context_length_exceeded" } }, { status: 400 });
function fixture(fetch: typeof globalThis.fetch, tools = new ToolRegistry()) {
  DEEPSEEK_CONTEXT_TOKENS[MODEL] = 128_000;
  const loop = new CacheFirstLoop({
    client: new DeepSeekClient({
      apiKey: "synthetic",
      baseUrl: "https://synthetic.invalid/v1",
      fetch,
      retry: { maxAttempts: 1 },
    }),
    prefix: new ImmutablePrefix({ system: "Do not publish.", toolSpecs: tools.specs() }),
    model: MODEL,
    stream: false,
    tools,
  });
  loop.log.append({ role: "user", content: "Original requirement" });
  loop.log.append({ role: "assistant", content: "Older durable evidence. ".repeat(2200) });
  return loop;
}
afterEach(() => {
  delete DEEPSEEK_CONTEXT_TOKENS[MODEL];
  vi.restoreAllMocks();
});

describe("main request context recovery", { retry: 0 }, () => {
  it.each([false, true])("cancels during recovery without replay (discard=%s)", async (discard) => {
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    let next = false;
    const fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Wire;
      if (next) return reply("Next turn.");
      if (!summary(body)) return overflow();
      release();
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    });
    const loop = fixture(fetch);
    const running = (async () => {
      for await (const _event of loop.step("Cancel recovery")) {
        /* drain */
      }
    })();
    await started;
    loop.abort({ discardCurrentTurn: discard });
    await expect(running).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      loop.log
        .toFullHistory()
        .some((row) => row.role === "user" && row.content === "Cancel recovery"),
    ).toBe(!discard);
    next = true;
    expect(await loop.run("New question")).toBe("Next turn.");
    loop.dispose();
  });
  it("compacts and resends the failed request without another user message", async () => {
    const bodies: Wire[] = [];
    let main = 0;
    const loop = fixture(
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Wire;
        bodies.push(body);
        if (summary(body)) return reply("Durable facts.");
        return ++main === 1 ? overflow() : reply("Recovered.");
      }),
    );
    const events = [];
    for await (const event of loop.step("Continue this task", { clientId: "same-user" }))
      events.push(event);
    expect(events.filter((event) => event.role === "error")).toEqual([]);
    expect(
      events.some((event) => event.role === "assistant_final" && event.content === "Recovered."),
    ).toBe(true);
    expect(bodies).toHaveLength(3);
    expect(
      bodies[2]!.messages.some((message) => message.content?.includes(HISTORY_FOLD_MARKER)),
    ).toBe(true);
    expect(
      loop.log.toFullHistory().filter((message) => message.clientId === "same-user"),
    ).toHaveLength(1);
    loop.dispose();
  });

  it("retains executed tool results across exhausted recovery and explicit retry", async () => {
    let executions = 0;
    let available = false;
    let calls = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "once",
      description: "One side effect",
      parameters: { type: "object" },
      fn: async () => {
        executions++;
        return "saved result";
      },
    });
    const loop = fixture(
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Wire;
        if (summary(body)) return reply("Durable facts.");
        calls++;
        if (calls === 1) return reply("", true);
        return available ? reply("Finished.") : overflow();
      }),
      tools,
    );
    for await (const _event of loop.step("Perform once", { clientId: "once-user" })) {
      /* drain */
    }
    expect(executions).toBe(1);
    expect(loop.canRetryFailedModelRequest()).toBe(true);
    available = true;
    const events = [];
    for await (const event of loop.retryFailedModelRequest()) events.push(event);
    expect(
      events.some((event) => event.role === "assistant_final" && event.content === "Finished."),
    ).toBe(true);
    expect(executions).toBe(1);
    expect(
      loop.log.toFullHistory().filter((message) => message.clientId === "once-user"),
    ).toHaveLength(1);
    expect(
      loop.log
        .toFullHistory()
        .some((message) => message.role === "tool" && message.content === "saved result"),
    ).toBe(true);
    loop.dispose();
  });

  it("does not replay partial streamed content or offer unsafe continuation", async () => {
    const frames = [
      { choices: [{ delta: { content: "Already visible" } }] },
      { error: { message: "context_length_exceeded", code: "context_length_exceeded" } },
    ];
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              const frame = frames.shift();
              if (frame)
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
              else controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const loop = fixture(fetch);
    loop.configure({ stream: true });
    const events = [];
    for await (const event of loop.step("Continue")) events.push(event);
    expect(events.some((event) => event.role === "assistant_delta")).toBe(true);
    expect(events.some((event) => event.role === "error")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(loop.canRetryFailedModelRequest()).toBe(false);
    loop.dispose();
  });
});
