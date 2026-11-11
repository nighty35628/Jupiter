import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import type { LoopEvent } from "../src/loop/types.js";
import type { LoopSessionStorage } from "../src/memory/loop-session-storage.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import type { SessionMeta } from "../src/memory/session.js";
import { ToolRegistry } from "../src/tools.js";
import type { ChatMessage } from "../src/types.js";

interface Wire {
  messages: ChatMessage[];
  max_tokens?: number;
  stream?: boolean;
}
const MODEL = "boundary-model";
const loops: CacheFirstLoop[] = [];
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "jupiter-request-boundary-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});
afterEach(() => {
  for (const loop of loops.splice(0)) loop.dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function ok(content = "Recovered."): Response {
  return Response.json({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 5 },
  });
}
function overflow(message = "context_length_exceeded"): Response {
  return Response.json({ error: { code: "context_length_exceeded", message } }, { status: 400 });
}
function eventResponse(frames: unknown[], done = false): Response {
  return new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
      (done ? "data: [DONE]\n\n" : ""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
function isSummary(wire: Wire): boolean {
  return wire.messages.at(-1)?.content?.startsWith("Summarize the conversation above") === true;
}
function provider(
  fetch: typeof globalThis.fetch,
  opts: Partial<ConstructorParameters<typeof DeepSeekClient>[0]> = {},
): DeepSeekClient {
  return new DeepSeekClient({
    baseUrl: `https://boundary.example/${home.split("/").at(-1)}`,
    apiKey: "synthetic-boundary-key",
    fetch,
    rateLimit: { rpm: 0 },
    retry: { maxAttempts: 4, initialBackoffMs: 0, maxBackoffMs: 0 },
    ...opts,
  });
}
function loopFor(
  client: DeepSeekClient,
  options: {
    history?: boolean;
    stream?: boolean;
    storage?: LoopSessionStorage;
    tools?: ToolRegistry;
  } = {},
): CacheFirstLoop {
  const loop = new CacheFirstLoop({
    client,
    prefix: new ImmutablePrefix({
      system: "Synthetic boundary test.",
      toolSpecs: options.tools?.specs() ?? [],
    }),
    model: MODEL,
    stream: options.stream ?? false,
    sessionStorage: options.storage,
    tools: options.tools,
  });
  loops.push(loop);
  if (options.history) {
    loop.log.append({ role: "user", content: "Old synthetic request" });
    loop.log.append({ role: "assistant", content: "Durable synthetic evidence. ".repeat(1800) });
  }
  return loop;
}
async function collect(
  loop: CacheFirstLoop,
  text = "Continue synthetic work.",
): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of loop.step(text, { clientId: "one-user-record" })) events.push(event);
  return events;
}
function memoryStorage(): { storage: LoopSessionStorage; meta: () => SessionMeta } {
  let rows: ChatMessage[] = [];
  let meta: SessionMeta = {};
  return {
    meta: () => meta,
    storage: {
      loadMessages: () => rows.map((row) => ({ ...row })),
      appendMessage: (row) => {
        rows.push({ ...row });
        return row;
      },
      rewriteMessages: (messages) => {
        rows = messages.map((row) => ({ ...row }));
      },
      loadMeta: () => ({ ...meta }),
      patchMeta: (patch) => {
        meta = { ...meta, ...patch };
      },
      journal: null,
    },
  };
}

describe("physical context request boundaries", { retry: 0 }, () => {
  it.each(["overflow", "500"] as const)(
    "bounds the recovery resend to one physical attempt when it ends in %s",
    async (failure) => {
      const wires: Wire[] = [];
      let mainCalls = 0;
      const fetch = vi.fn(async (_url, init) => {
        const wire = JSON.parse(String(init?.body)) as Wire;
        wires.push(wire);
        if (isSummary(wire)) return ok("Durable summary.");
        mainCalls++;
        return mainCalls === 1 || failure === "overflow"
          ? overflow()
          : Response.json({ error: { message: "unavailable" } }, { status: 500 });
      }) as typeof globalThis.fetch;
      const loop = loopFor(provider(fetch), { history: true });
      const events = await collect(loop);
      expect(mainCalls).toBe(2);
      expect(wires.filter(isSummary)).toHaveLength(1);
      expect(wires).toHaveLength(3);
      expect(events.filter((event) => event.role === "error")).toHaveLength(1);
      expect(
        loop.log.toFullHistory().filter((row) => row.clientId === "one-user-record"),
      ).toHaveLength(1);
    },
  );

  it("bounds failed summary attempts without recursive main recovery or network retries", async () => {
    const wires: Wire[] = [];
    const loop = loopFor(
      provider(
        vi.fn(async (_url, init) => {
          const wire = JSON.parse(String(init?.body)) as Wire;
          wires.push(wire);
          return isSummary(wire)
            ? Response.json({ error: { message: "unavailable" } }, { status: 500 })
            : overflow();
        }),
      ),
      { history: true },
    );
    const events = await collect(loop);
    expect(wires.filter((wire) => !isSummary(wire))).toHaveLength(1);
    expect(wires.filter(isSummary).length).toBeLessThanOrEqual(3);
    expect(wires.length).toBeLessThanOrEqual(4);
    expect(events.some((event) => event.role === "error")).toBe(true);
  });

  it("does not multiply initial transport retries into retries of the recovery resend", async () => {
    const wires: Wire[] = [];
    let mainCalls = 0;
    const loop = loopFor(
      provider(
        vi.fn(async (_url, init) => {
          const wire = JSON.parse(String(init?.body)) as Wire;
          wires.push(wire);
          if (isSummary(wire)) return ok("Durable summary.");
          mainCalls++;
          return mainCalls === 2
            ? overflow()
            : Response.json({ error: { message: "unavailable" } }, { status: 500 });
        }),
      ),
      { history: true },
    );
    await collect(loop);
    expect(mainCalls).toBe(3);
    expect(wires.filter(isSummary)).toHaveLength(1);
    expect(wires).toHaveLength(4);
  });

  it.each([
    [400, { message: "invalid parameter" }],
    [401, { code: "context_length_exceeded" }],
    [413, { message: "maximum input length is 40 MiB" }],
  ] as const)("does not enter recovery for unrelated status %s (%j)", async (status, error) => {
    const fetch = vi.fn(async () => Response.json({ error }, { status }));
    const client = provider(fetch, { retry: { maxAttempts: 1 } });
    const learn = vi.spyOn(client, "learnContextLimit");
    const events = await collect(loopFor(client, { history: true }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(learn).not.toHaveBeenCalled();
    expect(events.some((event) => event.activity === "compaction")).toBe(false);
  });

  it.each([
    { content: "Visible bytes" },
    { reasoning_content: "Visible reasoning" },
    { tool_calls: [{ index: 0, id: "unexecuted", function: { name: "never", arguments: "{}" } }] },
  ])(
    "never replays after content/reasoning/tool deltas in the same SSE packet: %j",
    async (delta) => {
      const execute = vi.fn(() => "must not execute");
      const tools = new ToolRegistry();
      tools.register({ name: "never", fn: execute });
      const fetch = vi.fn(async () =>
        eventResponse([
          { choices: [{ delta }] },
          {
            error: {
              code: "context_length_exceeded",
              message: "maximum input length is 4096 tokens",
            },
          },
        ]),
      );
      const client = provider(fetch);
      const learn = vi.spyOn(client, "learnContextLimit");
      const loop = loopFor(client, { stream: true, history: true, tools });
      const events = await collect(loop);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      expect(learn).not.toHaveBeenCalled();
      expect(events.some((event) => event.role === "error")).toBe(true);
      expect(loop.canRetryFailedModelRequest()).toBe(false);
      expect(events.some((event) => event.role === "assistant_final")).toBe(false);
    },
  );

  it("recovers a stream error before any content and accepts one subsequent response", async () => {
    const wires: Wire[] = [];
    let mainCalls = 0;
    const loop = loopFor(
      provider(
        vi.fn(async (_url, init) => {
          const wire = JSON.parse(String(init?.body)) as Wire;
          wires.push(wire);
          if (isSummary(wire)) return ok("Durable summary.");
          mainCalls++;
          return mainCalls === 1
            ? eventResponse([{ error: { code: "context_length_exceeded" } }])
            : eventResponse(
                [
                  {
                    choices: [{ delta: { content: "Recovered." }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 50, completion_tokens: 5 },
                  },
                ],
                true,
              );
        }),
      ),
      { stream: true, history: true },
    );
    const events = await collect(loop);
    expect(wires).toHaveLength(3);
    expect(
      events.filter((event) => event.role === "assistant_final").map((event) => event.content),
    ).toEqual(["Recovered."]);
    expect(events.some((event) => event.role === "error")).toBe(false);
  });

  it("cancels at the recovery boundary without throwing or sending another request", async () => {
    const fetch = vi.fn(async () => overflow());
    const loop = loopFor(provider(fetch), { history: true });
    const events: LoopEvent[] = [];
    let thrown: unknown;
    try {
      for await (const event of loop.step("Cancel during recovery.")) {
        events.push(event);
        if (event.activity === "compaction" && event.activityState === "running") loop.abort();
      }
    } catch (error) {
      thrown = error;
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(thrown).toBeUndefined();
    expect(events.some((event) => event.role === "done")).toBe(true);
    expect(loop.canRetryFailedModelRequest()).toBe(false);
  });

  it("retries an output-only correction without synthesizing a summary or losing the user", async () => {
    const wires: Wire[] = [];
    const client = provider(
      vi.fn(async (_url, init) => {
        wires.push(JSON.parse(String(init?.body)) as Wire);
        return wires.length === 1
          ? overflow("maximum context length is 4096 tokens, including output completion")
          : ok();
      }),
      { baseUrl: "https://api.deepseek.com" },
    );
    const loop = loopFor(client);
    loop.model = "deepseek-flash";
    const events = await collect(loop);
    expect(wires).toHaveLength(2);
    expect(wires.some(isSummary)).toBe(false);
    expect(wires[1]!.messages).toEqual(wires[0]!.messages);
    expect(wires[1]!.max_tokens).toBe(1024);
    expect(events.some((event) => event.role === "assistant_final")).toBe(true);
    expect(client.getRequestBudget({ model: loop.model }).source).toBe("server");
  });

  it("keeps a server-window output correction usable on the next turn and rebuilt runtime", async () => {
    const state = memoryStorage();
    const wires: Wire[] = [];
    const fetch = vi.fn(async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as Wire;
      wires.push(wire);
      return wires.length === 1
        ? overflow("maximum context length is 4096 tokens, including output completion")
        : ok();
    });
    const client = provider(fetch, { baseUrl: "https://api.deepseek.com" });
    const first = loopFor(client, { storage: state.storage });
    first.model = "deepseek-flash";
    expect(
      (await collect(first, "First short request.")).some(
        (event) => event.role === "assistant_final",
      ),
    ).toBe(true);
    expect(
      (await collect(first, "Next short request.")).some(
        (event) => event.role === "assistant_final",
      ),
    ).toBe(true);
    first.dispose();
    const rebuilt = loopFor(provider(fetch, { baseUrl: "https://api.deepseek.com" }), {
      storage: state.storage,
    });
    rebuilt.model = "deepseek-flash";
    expect(
      (await collect(rebuilt, "Rebuilt short request.")).some(
        (event) => event.role === "assistant_final",
      ),
    ).toBe(true);
  });

  it("restores only same endpoint/dialect/credential server evidence after rebuilding the runtime", async () => {
    const state = memoryStorage();
    const fetch = vi.fn(async () => overflow("maximum input length is 4096 tokens"));
    const firstClient = provider(fetch);
    const first = loopFor(firstClient, { storage: state.storage });
    await collect(first);
    expect(state.meta().contextLimits?.[MODEL]?.inputTokenLimit).toBe(4096);
    first.dispose();
    const rebuilt = loopFor(provider(fetch), { storage: state.storage });
    expect(rebuilt.getRequestBudget().inputLimit).toBe(4096);
    expect(JSON.stringify(state.meta().contextLimits)).not.toContain("synthetic-boundary-key");
    for (const changed of [
      { apiKey: "other-synthetic-key" },
      { baseUrl: "https://different-boundary.example/v1" },
      { dialect: "deepseek" as const },
    ]) {
      const isolated = loopFor(provider(fetch, changed), { storage: state.storage });
      expect(isolated.getRequestBudget().inputLimit).toBeGreaterThan(4096);
    }
  });

  it("persists the strongest evidence instead of widening a server prompt cap on rebuild", async () => {
    const state = memoryStorage();
    let limit = 4096;
    const fetch = vi.fn(async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as Wire;
      return isSummary(wire)
        ? ok("Brief summary.")
        : overflow(`maximum input length is ${limit} tokens`);
    });
    const first = loopFor(provider(fetch), { storage: state.storage });
    await collect(first, "First short request.");
    limit = 8192;
    await collect(first, "Second short request.");
    expect(first.getRequestBudget().inputLimit).toBe(4096);
    first.dispose();
    const rebuilt = loopFor(provider(fetch), { storage: state.storage });
    expect(rebuilt.getRequestBudget().inputLimit).toBe(4096);
  });

  it("retains independent prompt and total-window evidence across runtime rebuild", async () => {
    const state = memoryStorage();
    let mainCalls = 0;
    const fetch = vi.fn(async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as Wire;
      if (isSummary(wire)) return ok("Brief summary.");
      mainCalls++;
      if (mainCalls === 1) return overflow("maximum input length is 4096 tokens");
      if (mainCalls === 2)
        return overflow("maximum context length is 16384 tokens, including output completion");
      return ok();
    });
    const first = loopFor(provider(fetch), { storage: state.storage });
    await collect(first, "First request.");
    await collect(first, "Second request.");
    const before = first.getRequestBudget();
    expect(before.contextWindowTokens).toBe(16384);
    expect(before.inputLimit).toBeLessThanOrEqual(4096);
    first.dispose();
    const rebuilt = loopFor(provider(fetch), { storage: state.storage });
    expect(rebuilt.getRequestBudget().contextWindowTokens).toBe(16384);
    expect(rebuilt.getRequestBudget().inputLimit).toBeLessThanOrEqual(4096);
  });
});
