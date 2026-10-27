import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { loadSessionMessages, rewriteSession } from "../src/memory/session.js";
import { SharedSessionCoordinator, type SharedTurnStorage } from "../src/memory/shared-session.js";
import { ToolRegistry } from "../src/tools.js";
import type { ChatMessage } from "../src/types.js";

function reply(content: string, tools = false) {
  return Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content,
          ...(tools
            ? {
                tool_calls: [
                  {
                    id: "same-provider-call",
                    type: "function",
                    function: { name: "once", arguments: "{}" },
                  },
                ],
              }
            : {}),
        },
        finish_reason: tools ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 5 },
  });
}

describe("shared session real loop integration", { retry: 0 }, () => {
  let home: string;
  let coordinator: SharedSessionCoordinator;
  const loops: CacheFirstLoop[] = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jupiter-shared-integration-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    rewriteSession(
      "shared",
      Array.from({ length: 240 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: `seed-${i}`,
      })),
    );
    coordinator = new SharedSessionCoordinator("shared", "shared-id");
  });
  afterEach(() => {
    for (const loop of loops.splice(0)) loop.dispose();
    coordinator?.dispose();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });
  function loop(store: SharedTurnStorage, fetcher: typeof fetch, tools = new ToolRegistry()) {
    const instance = new CacheFirstLoop({
      client: new DeepSeekClient({
        apiKey: "synthetic",
        baseUrl: "https://synthetic.invalid/v1",
        retry: { maxAttempts: 1 },
        fetch: fetcher,
      }),
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
      tools,
      stream: false,
      thinkingEnabled: false,
      model: "deepseek-chat",
      session: "shared",
      sessionStorage: store,
    });
    loops.push(instance);
    return instance;
  }
  it("freezes a long snapshot across a sibling commit and sends the latest shared history next turn", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: ChatMessage[][] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "once",
      description: "Wait once",
      parameters: { type: "object" },
      readOnly: true,
      fn: async () => {
        await waiting;
        return "one result";
      },
    });
    const a = coordinator.beginTurn("view-a", "A");
    const agentA = loop(
      a,
      vi.fn(async (_url, options) => {
        const messages = JSON.parse(String(options?.body)).messages as ChatMessage[];
        requests.push(messages);
        return reply(
          messages.some((row) => row.role === "tool") ? "answer A" : "",
          !messages.some((row) => row.role === "tool"),
        );
      }) as typeof fetch,
      tools,
    );
    const runningA = agentA.run("question A");
    await vi.waitFor(() =>
      expect(a.staged.records.some((row) => row.tool_calls?.length)).toBe(true),
    );
    const b = coordinator.beginTurn("view-b", "B");
    await loop(b, vi.fn(async () => reply("answer B")) as typeof fetch).run("question B");
    coordinator.commit(b);
    release();
    await runningA;
    coordinator.commit(a);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.some((row) => row.content?.includes("question B"))).toBe(false);
    expect(requests[1]?.some((row) => row.content === "seed-0")).toBe(true);
    expect(
      requests.flat().some((row) => row.turnId || row.conversationViewId || row.clientId),
    ).toBe(false);
    const c = coordinator.beginTurn("view-c", "C");
    let next: ChatMessage[] = [];
    await loop(
      c,
      vi.fn(async (_url, options) => {
        next = JSON.parse(String(options?.body)).messages;
        return reply("answer C");
      }) as typeof fetch,
    ).run("question C");
    expect(next.some((row) => row.content === "answer A")).toBe(true);
    expect(next.some((row) => row.content === "answer B")).toBe(true);
    expect(
      loadSessionMessages("shared")
        .filter((row) => row.role === "user")
        .slice(-2)
        .map((row) => row.content),
    ).toEqual(["question B", "question A"]);
  });
  it("continues an API failure after another view commits without rerunning an executed tool", async () => {
    let executions = 0;
    let fail = true;
    const tools = new ToolRegistry();
    tools.register({
      name: "once",
      description: "Execute once",
      parameters: { type: "object" },
      fn: async () => {
        executions++;
        return "executed";
      },
    });
    const a = coordinator.beginTurn("view-a", "A");
    const agentA = loop(
      a,
      vi.fn(async (_url, options) => {
        const messages = JSON.parse(String(options?.body)).messages as ChatMessage[];
        if (!messages.some((row) => row.role === "tool")) return reply("", true);
        if (fail) return Response.json({ error: { message: "synthetic outage" } }, { status: 503 });
        expect(messages.some((row) => row.content === "question B")).toBe(false);
        return reply("recovered A");
      }) as typeof fetch,
      tools,
    );
    await agentA.run("question A");
    expect(agentA.canRetryFailedModelRequest()).toBe(true);
    const b = coordinator.beginTurn("view-b", "B");
    await loop(b, vi.fn(async () => reply("answer B")) as typeof fetch).run("question B");
    coordinator.commit(b);
    fail = false;
    for await (const _event of agentA.retryFailedModelRequest()) {
      /* Consume the actual continuation. */
    }
    coordinator.commit(a);
    expect(executions).toBe(1);
    const rows = loadSessionMessages("shared");
    expect(rows.some((row) => row.content === "answer B")).toBe(true);
    expect(rows.filter((row) => row.role === "user" && row.content === "question A")).toHaveLength(
      1,
    );
    expect(rows.some((row) => row.content === "recovered A")).toBe(true);
  });
});
