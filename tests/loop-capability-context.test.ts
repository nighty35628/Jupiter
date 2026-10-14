import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { DesktopComputerUse } from "../src/desktop/computer-use.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ToolRegistry } from "../src/tools.js";

function response(content: string, tool?: string, args: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content,
            ...(tool
              ? {
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: tool, arguments: JSON.stringify(args) },
                    },
                  ],
                }
              : {}),
          },
          finish_reason: tool ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

describe("request capability boundaries", () => {
  it("keeps a retry payload stable but enforces a newly-disabled CU policy before dispatch", async () => {
    const policy = {
      enabled: true,
      surface: "desktop",
      supportsImages: true,
      permissionMode: "standard" as const,
    };
    const createRuntime = vi.fn();
    const computer = new DesktopComputerUse({
      owner: "retry-test",
      workspaceDir: "/tmp",
      policy: () => policy,
      detectDriver: () => "/fake/cua-driver",
      createRuntime,
    });
    const tools = new ToolRegistry();
    computer.register(tools);
    const turn = computer.beginTurn(new AbortController().signal);
    const bodies: any[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      retry: { initialBackoffMs: 1, maxAttempts: 2 },
      fetch: vi.fn(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) {
          policy.enabled = false;
          return new Response("rate limited", { status: 429 });
        }
        return bodies.length === 2
          ? response("", "computer_use_click", { observationId: "old", x: 1, y: 1 })
          : response("done");
      }) as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      tools,
      prefix: new ImmutablePrefix({ system: "stable", toolSpecs: tools.specs() }),
      stream: false,
    });
    for await (const _ of loop.step("click", {
      requestContext: () => `enabled=${policy.enabled}`,
    })) {
      /* drain */
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[2].messages.at(-1).content).toBe("enabled=false");
    expect(createRuntime).not.toHaveBeenCalled();
    expect(
      loop.log
        .toFullHistory()
        .some((m) => m.role === "tool" && String(m.content).includes("disabled")),
    ).toBe(true);
    await computer.endTurn(turn);
    loop.dispose();
  });
  it("refreshes transient runtime facts after a tool without changing the cached prefix", async () => {
    let status = "idle";
    const bodies: any[] = [];
    const tools = new ToolRegistry().register({
      name: "observe",
      readOnly: true,
      fn: () => {
        status = "ready";
        return "ok";
      },
    });
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return bodies.length === 1 ? response("", "observe") : response("done");
      }) as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      tools,
      prefix: new ImmutablePrefix({ system: "stable", toolSpecs: tools.specs() }),
      stream: false,
    });
    for await (const _ of loop.step("inspect", { requestContext: () => `status=${status}` })) {
      /* drain */
    }
    expect(bodies[0].messages.at(-1).content).toBe("status=idle");
    expect(bodies[1].messages.at(-1).content).toBe("status=ready");
    expect(bodies[0].messages[0]).toEqual(bodies[1].messages[0]);
    expect(loop.log.toFullHistory().some((m) => String(m.content).includes("status="))).toBe(false);
    loop.dispose();
  });
  it("refreshes advertised tools between turns without losing conversation history", async () => {
    const bodies: any[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return response("done");
      }) as typeof fetch,
    });
    const tools = new ToolRegistry();
    const loop = new CacheFirstLoop({
      client,
      tools,
      prefix: new ImmutablePrefix({ system: "identity" }),
      stream: false,
    });
    await loop.run("first");
    tools.register({ name: "new_capability", fn: () => "ok" });
    loop.refreshToolset();
    await loop.run("second");
    expect(bodies[1].tools.map((t: any) => t.function.name)).toEqual(["new_capability"]);
    expect(bodies[1].messages.some((m: any) => m.content === "first")).toBe(true);
    expect(loop.stats.turns).toHaveLength(2);
    loop.dispose();
  });

  it("keeps execution definitions stable when the registry changes during a response", async () => {
    const original = vi.fn(() => "original");
    const replacement = vi.fn(() => "replacement");
    const tools = new ToolRegistry().register({ name: "capability", fn: original });
    let calls = 0;
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () => {
        if (calls++ === 0) {
          tools.register({ name: "capability", fn: replacement });
          return response("", "capability");
        }
        return response("done");
      }) as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      tools,
      prefix: new ImmutablePrefix({ system: "identity", toolSpecs: tools.specs() }),
      stream: false,
    });
    await loop.run("use capability");
    expect(original).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    loop.dispose();
  });

  it("sends temporary help after history, keeps it through tool calls, and never persists it", async () => {
    const bodies: any[] = [];
    const tools = new ToolRegistry().register({
      name: "inspect",
      readOnly: true,
      fn: () => "observed",
    });
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return bodies.length === 1 ? response("", "inspect") : response("done");
      }) as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      tools,
      prefix: new ImmutablePrefix({ system: "identity", toolSpecs: tools.specs() }),
      stream: false,
    });
    for await (const _ of loop.step("question", { requestContext: "current official help" })) {
      /* drain */
    }
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.messages.at(-1)).toEqual({ role: "system", content: "current official help" });
      expect(body.messages.filter((m: any) => m.content === "current official help")).toHaveLength(
        1,
      );
    }
    expect(loop.log.toFullHistory().some((m) => m.content === "current official help")).toBe(false);
    await loop.run("ordinary follow-up");
    expect(bodies[2].messages.some((m: any) => m.content === "current official help")).toBe(false);
    loop.dispose();
  });
});
