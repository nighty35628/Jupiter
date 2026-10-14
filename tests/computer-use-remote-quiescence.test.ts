import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerUseController } from "../src/computer-use/controller.js";
import { ComputerUseRuntime } from "../src/computer-use/driver-process.js";
import { ComputerUseLease, ComputerUseLeaseBusyError } from "../src/computer-use/lease.js";
import { ComputerUseToolAdapter } from "../src/computer-use/tool-adapter.js";
import { McpClient } from "../src/mcp/client.js";
import type { McpTransport } from "../src/mcp/stdio.js";
import type { CallToolResult, JsonRpcMessage, JsonRpcRequest } from "../src/mcp/types.js";

const roots: string[] = [];
const runtimes: ComputerUseRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop().catch(() => undefined)));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(callTool: McpClient["callTool"], simulateSending = true) {
  const root = await mkdtemp(join(tmpdir(), "jupiter-cua-remote-"));
  roots.push(root);
  const path = join(root, "lock");
  const lease = new ComputerUseLease({ path, staleAfterMs: 0 });
  const controller = new ComputerUseController(lease);
  const runtime = new ComputerUseRuntime({}, controller);
  runtimes.push(runtime);
  const clientStub = {
    callTool: async (...args: Parameters<McpClient["callTool"]>) => {
      if (simulateSending) args[2]?.onSending?.();
      return callTool(...args);
    },
  } as unknown as McpClient;
  vi.spyOn(runtime.driver, "start").mockResolvedValue(clientStub);
  const close = vi.spyOn(runtime.driver, "close").mockResolvedValue();
  const client = await runtime.start("owner");
  const adapter = new ComputerUseToolAdapter(client, controller);
  const observation = controller.recordObservation({
    capturedAt: Date.now(),
    imageWidth: 100,
    imageHeight: 100,
    screen: { left: 0, top: 0, width: 100, height: 100 },
  });
  return { root, path, lease, controller, runtime, adapter, observation, close };
}

const ack = (effect: string, isError = false): CallToolResult => ({
  content: [],
  structuredContent: { effect },
  isError,
});

async function fakeMcp(
  onTool: (request: JsonRpcRequest, push: (message: JsonRpcMessage) => void) => void,
) {
  const queue: Array<JsonRpcMessage | null> = [];
  let wake: ((message: JsonRpcMessage | null) => void) | undefined;
  const push = (message: JsonRpcMessage | null) => {
    if (wake) {
      const resolve = wake;
      wake = undefined;
      resolve(message);
    } else queue.push(message);
  };
  const transport: McpTransport = {
    async send(message) {
      if (!("method" in message) || !("id" in message)) return;
      if (message.method === "initialize")
        push({
          jsonrpc: "2.0",
          id: message.id!,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "1" },
          },
        });
      else if (message.method === "tools/call") onTool(message as JsonRpcRequest, push);
    },
    async *messages() {
      while (true) {
        const message = queue.length
          ? queue.shift()
          : await new Promise<JsonRpcMessage | null>((resolve) => {
              wake = resolve;
            });
        if (message == null) return;
        yield message;
      }
    },
    close: async () => {
      push(null);
    },
  };
  const client = new McpClient({ transport });
  await client.initialize();
  return client;
}

describe("Computer Use shared-daemon quiescence", () => {
  it("clears dispatched input for a confirmed server JSON-RPC error ACK", async () => {
    const client = await fakeMcp((request, push) =>
      push({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "input denied" } }),
    );
    try {
      const { adapter, observation, runtime, controller, lease } = await fixture(
        client.callTool.bind(client),
        false,
      );
      await expect(adapter.type({ observationId: observation.id, text: "test" })).rejects.toThrow(
        "input denied",
      );
      expect(controller.remoteQuiescent).toBe(true);
      expect(controller.active).toBe(true);
      await runtime.stop();
      const next = await lease.acquire("next");
      await next.release();
    } finally {
      await client.close();
    }
  });

  it("keeps an MCP validation rejection before send out of the unknown-input ledger", async () => {
    const client = new McpClient({
      transport: { send: vi.fn(async () => {}), async *messages() {}, close: async () => {} },
    });
    const { adapter, observation, runtime, controller, lease } = await fixture(
      client.callTool.bind(client),
      false,
    );
    await expect(adapter.type({ observationId: observation.id, text: "test" })).rejects.toThrow(
      "not initialized",
    );
    expect(controller.remoteQuiescent).toBe(true);
    expect(controller.active).toBe(true);
    await runtime.stop();
    const next = await lease.acquire("next");
    await next.release();
  });

  it("still observes a late server ACK after local MCP cancellation", async () => {
    let acknowledge!: () => void;
    let entered!: () => void;
    const sent = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const client = await fakeMcp((request, push) => {
      acknowledge = () => push({ jsonrpc: "2.0", id: request.id, result: ack("unverifiable") });
      entered();
    });
    const onSending = vi.fn();
    const onResponse = vi.fn();
    const abort = new AbortController();
    try {
      const action = client.callTool("click", {}, { signal: abort.signal, onSending, onResponse });
      const rejected = expect(action).rejects.toThrow("aborted");
      await sent;
      abort.abort();
      await rejected;
      acknowledge();
      acknowledge();
      await vi.waitFor(() => {
        expect(onResponse).toHaveBeenCalledOnce();
      });
      expect(onSending).toHaveBeenCalledOnce();
    } finally {
      await client.close();
    }
  });
  it.each(["confirmed", "unverifiable"])(
    "releases ownership after a %s result ACK",
    async (effect) => {
      const { adapter, observation, runtime, controller, lease } = await fixture(async () =>
        ack(effect),
      );
      await adapter.type({ observationId: observation.id, text: "test" });
      expect(controller.remoteQuiescent).toBe(true);
      expect(controller.remoteInputStatus).toEqual({ pending: 0, unknown: 0 });
      await runtime.stop();
      const next = await lease.acquire("next");
      await next.release();
    },
  );

  it("treats a driver error result as a settled response, not lost input", async () => {
    const { adapter, observation, runtime, lease } = await fixture(async () => ack("denied", true));
    await adapter.type({ observationId: observation.id, text: "test" });
    await runtime.stop();
    const next = await lease.acquire("next");
    await next.release();
  });

  it("retains the lock after a lost action response despite confirmed proxy exit", async () => {
    const callTool = vi.fn(async () => {
      throw new Error("transport EOF");
    });
    const { adapter, observation, runtime, controller, lease, path, close } =
      await fixture(callTool);
    const args = { observationId: observation.id, text: "test" };
    expect(JSON.parse(await adapter.type(args))).toMatchObject({
      executionOutcome: "unknown_after_transport",
      manualRecoveryRequired: true,
    });
    await expect(runtime.stop()).rejects.toThrow("manual recovery");
    expect(close).toHaveBeenCalled();
    expect(runtime.state).toBe("fault");
    expect(runtime.fault).toMatchObject({ manualRecoveryRequired: true });
    expect(controller.remoteInputStatus).toEqual({ pending: 0, unknown: 1 });
    await expect(runtime.stop()).rejects.toThrow("manual recovery");
    await expect(runtime.start("retry")).rejects.toThrow();
    await expect(adapter.type(args)).rejects.toThrow();
    await expect(lease.acquire("next")).rejects.toBeInstanceOf(ComputerUseLeaseBusyError);
    const replacement = new ComputerUseRuntime(
      {},
      new ComputerUseController(new ComputerUseLease({ path })),
    );
    runtimes.push(replacement);
    const spawn = vi.spyOn(replacement.driver, "start").mockResolvedValue({} as McpClient);
    vi.spyOn(replacement.driver, "close").mockResolvedValue();
    await expect(replacement.start("next")).rejects.toBeInstanceOf(ComputerUseLeaseBusyError);
    expect(spawn).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledOnce();
  });

  it("does not wait indefinitely or release ownership while remote input is pending", async () => {
    let entered!: () => void;
    const sent = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let respond!: (result: CallToolResult) => void;
    const response = new Promise<CallToolResult>((resolve) => {
      respond = resolve;
    });
    const { adapter, observation, runtime, controller, lease } = await fixture(async () => {
      entered();
      return response;
    });
    const action = adapter.type({ observationId: observation.id, text: "test" });
    await sent;
    await expect(runtime.stop()).rejects.toThrow("manual recovery");
    expect(controller.remoteInputStatus).toEqual({ pending: 1, unknown: 0 });
    await expect(lease.acquire("next")).rejects.toBeInstanceOf(ComputerUseLeaseBusyError);
    // A real, late ACK can settle this exact request, but cannot revive the session.
    respond(ack("unverifiable"));
    expect(JSON.parse(await action)).toMatchObject({ executionOutcome: "unknown_after_cancel" });
    expect(controller.active).toBe(false);
    expect(controller.remoteQuiescent).toBe(true);
    await runtime.stop();
    const next = await lease.acquire("next");
    await next.release();
  }, 1000);

  it("retains ownership when local cancellation loses the remote response", async () => {
    let entered!: () => void;
    const sent = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { adapter, observation, runtime, controller, lease } = await fixture(
      async (_name, _args, options) => {
        entered();
        return new Promise<CallToolResult>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("locally cancelled")), {
            once: true,
          });
        });
      },
    );
    const abort = new AbortController();
    const action = adapter.type({ observationId: observation.id, text: "test" }, abort.signal);
    await sent;
    abort.abort();
    expect(JSON.parse(await action)).toMatchObject({
      executionOutcome: "unknown_after_cancel",
      manualRecoveryRequired: true,
    });
    await expect(runtime.stop()).rejects.toThrow("manual recovery");
    expect(controller.remoteQuiescent).toBe(false);
    await expect(lease.acquire("next")).rejects.toBeInstanceOf(ComputerUseLeaseBusyError);
  });

  it("does not track requests rejected by policy before dispatch", async () => {
    const callTool = vi.fn(async () => ack("confirmed"));
    const { controller, runtime, observation, lease } = await fixture(callTool);
    const adapter = new ComputerUseToolAdapter(
      { callTool } as unknown as McpClient,
      controller,
      "standard",
      () => {
        throw new Error("policy disabled");
      },
    );
    await expect(adapter.type({ observationId: observation.id, text: "test" })).rejects.toThrow(
      "policy disabled",
    );
    expect(callTool).not.toHaveBeenCalled();
    await runtime.stop();
    const next = await lease.acquire("next");
    await next.release();
  });

  it("retains ownership on actual fake-proxy EOF after input dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "jupiter-cua-proxy-eof-"));
    roots.push(root);
    const lease = new ComputerUseLease({ path: join(root, "lock") });
    const controller = new ComputerUseController(lease);
    const runtime = new ComputerUseRuntime(
      {
        command: process.execPath,
        args: [
          "-e",
          "const rl=require('node:readline').createInterface({input:process.stdin}); rl.on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{capabilities:{tools:{}},serverInfo:{name:'fake-proxy',version:'1'}}})+'\\n');if(r.method==='tools/call')process.stdout.end();});setInterval(()=>{},1000);",
        ],
        shutdownTimeoutMs: 30,
      },
      controller,
    );
    runtimes.push(runtime);
    const adapter = new ComputerUseToolAdapter(await runtime.start("owner"), controller);
    const observation = controller.recordObservation({
      capturedAt: Date.now(),
      imageWidth: 100,
      imageHeight: 100,
      screen: { left: 0, top: 0, width: 100, height: 100 },
    });
    const result = JSON.parse(await adapter.type({ observationId: observation.id, text: "test" }));
    expect(result.executionOutcome).toBe("unknown_after_transport");
    await expect(runtime.stop()).rejects.toThrow("manual recovery");
    expect(runtime.driver.running).toBe(false);
    expect(runtime.state).toBe("fault");
    await expect(lease.acquire("next")).rejects.toBeInstanceOf(ComputerUseLeaseBusyError);
  }, 2000);
});
