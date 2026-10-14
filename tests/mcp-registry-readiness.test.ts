import { describe, expect, it } from "vitest";
import { type BridgeEnv, type McpClientHost, registerSingleMcpTool } from "../src/mcp/registry.js";
import type { CallToolResult, McpTool } from "../src/mcp/types.js";
import { ToolRegistry } from "../src/tools.js";

interface FakeClient {
  callTool: (
    name: string,
    args?: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ) => Promise<CallToolResult>;
}

function makeFakeHost(callImpl: FakeClient["callTool"]): McpClientHost {
  const fake: FakeClient = { callTool: callImpl };
  // The bridge only touches host.client.callTool — cast to satisfy the type.
  return { client: fake as unknown as McpClientHost["client"] };
}

const TOOL: McpTool = {
  name: "echo",
  description: "echo input",
  inputSchema: { type: "object", properties: { msg: { type: "string" } } },
};

describe("MCP bridge readiness gate", () => {
  it("marks a transport failure as an unknown outcome instead of a replayable error", async () => {
    const host = makeFakeHost(async () => {
      throw new Error("MCP request tools/call timed out after 60000ms");
    });
    const registry = new ToolRegistry();
    const env: BridgeEnv = {
      registry,
      host,
      prefix: "computer_",
      maxResultChars: 32_000,
      tracker: null,
      serverName: "computer",
    };
    const name = registerSingleMcpTool(TOOL, env);
    const out = await registry.dispatch(name, JSON.stringify({ msg: "click" }));
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.executionOutcome).toBe("unknown_after_transport");
    expect(parsed.recovery).toBe("unknown");
    expect(parsed.retry).toBe("inspect_current_state_before_repeating");
  });

  it("marks a cancellation after dispatch as unknown", async () => {
    const controller = new AbortController();
    const host = makeFakeHost(async () => {
      controller.abort();
      throw new Error("MCP request tools/call aborted by user");
    });
    const registry = new ToolRegistry();
    const env: BridgeEnv = {
      registry,
      host,
      prefix: "computer_",
      maxResultChars: 32_000,
      tracker: null,
      serverName: "computer",
    };
    const name = registerSingleMcpTool(TOOL, env);
    const out = await registry.dispatch(name, JSON.stringify({ msg: "type" }), {
      signal: controller.signal,
    });
    expect(JSON.parse(out)).toMatchObject({
      executionOutcome: "unknown_after_cancel",
      recovery: "unknown",
    });
  });

  it("dispatch fired mid-handshake waits for the ready deferred and then resolves", async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => {
      resolveReady = r;
    });
    let callsAttempted = 0;
    const host = makeFakeHost(async () => {
      callsAttempted += 1;
      return {
        content: [{ type: "text", text: "pong" }],
      };
    });
    const registry = new ToolRegistry();
    const env: BridgeEnv = {
      registry,
      host,
      prefix: "demo_",
      maxResultChars: 32_000,
      tracker: null,
      ready,
      readyTimeoutMs: 5_000,
      serverName: "demo",
    };
    const name = registerSingleMcpTool(TOOL, env);
    expect(name).toBe("demo_echo");

    const dispatched = registry.dispatch(name, JSON.stringify({ msg: "hi" }));

    // Yield a few microtasks — the dispatch must still be awaiting `ready`
    // since `callTool` hasn't been invoked yet.
    await new Promise((r) => setTimeout(r, 30));
    expect(callsAttempted).toBe(0);

    resolveReady();
    const out = await dispatched;
    expect(out).toContain("pong");
    expect(callsAttempted).toBe(1);
  });

  it("dispatch rejects with the failure reason when ready rejects", async () => {
    const ready = Promise.reject(new Error('MCP server "demo" failed to start: ENOENT'));
    // Avoid unhandledRejection warning before the bridge consumes it.
    ready.catch(() => undefined);
    const host = makeFakeHost(async () => {
      throw new Error("callTool should not run for a failed server");
    });
    const registry = new ToolRegistry();
    const env: BridgeEnv = {
      registry,
      host,
      prefix: "demo_",
      maxResultChars: 32_000,
      tracker: null,
      ready,
      readyTimeoutMs: 5_000,
      serverName: "demo",
    };
    const name = registerSingleMcpTool(TOOL, env);
    const out = await registry.dispatch(name, JSON.stringify({ msg: "hi" }));
    // ToolRegistry.dispatch returns a string envelope; the failure reason
    // must surface to the model rather than the bare transport error.
    expect(out).toContain("ENOENT");
  });

  it("dispatch surfaces a timeout error when ready never resolves within the budget", async () => {
    const ready = new Promise<void>(() => {
      // never settles
    });
    const host = makeFakeHost(async () => {
      throw new Error("callTool should not run while still handshaking");
    });
    const registry = new ToolRegistry();
    const env: BridgeEnv = {
      registry,
      host,
      prefix: "demo_",
      maxResultChars: 32_000,
      tracker: null,
      ready,
      readyTimeoutMs: 60,
      serverName: "demo",
    };
    const name = registerSingleMcpTool(TOOL, env);
    const out = await registry.dispatch(name, JSON.stringify({ msg: "hi" }));
    expect(out.toLowerCase()).toContain("handshaking");
  });
});
