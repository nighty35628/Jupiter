import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { McpClient } from "../src/mcp/client.js";
import { type McpTransport, StdioTransport } from "../src/mcp/stdio.js";

describe("MCP transport EOF", () => {
  it("rejects initialization immediately when the transport ends cleanly", async () => {
    const transport: McpTransport = {
      send: async () => {},
      async *messages() {},
      close: async () => {},
    };
    const client = new McpClient({ transport, requestTimeoutMs: 60_000 });
    try {
      await expect(client.initialize()).rejects.toThrow("transport closed");
    } finally {
      await client.close();
    }
  }, 1000);

  it("rejects in-flight and future tool calls after the reader closes", async () => {
    let end!: () => void;
    const closed = new Promise<void>((resolve) => {
      end = resolve;
    });
    const send = vi.fn(async () => {});
    const transport: McpTransport = {
      send,
      async *messages() {
        yield {
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "test", version: "1" },
          },
        } as const;
        await closed;
      },
      close: async () => {
        end();
      },
    };
    const disconnect = vi.fn();
    const client = new McpClient({ transport, requestTimeoutMs: 60_000, onDisconnect: disconnect });
    try {
      await client.initialize();
      expect(client.connected).toBe(true);
      const pending = client.callTool("click", {});
      const assertion = expect(pending).rejects.toThrow("transport closed");
      end();
      await assertion;
      expect(client.connected).toBe(false);
      expect(disconnect).toHaveBeenCalledOnce();
      expect(disconnect).toHaveBeenCalledWith(expect.any(Error));
      const count = send.mock.calls.length;
      await expect(client.callTool("click", {})).rejects.toThrow("transport closed");
      expect(send).toHaveBeenCalledTimes(count);
    } finally {
      await client.close();
    }
  }, 1000);
});

describe("MCP bounded process shutdown", () => {
  it("terminates the child and concurrent closes wait for actual exit", async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: [
        "-e",
        'process.on(\'SIGTERM\', () => {}); process.stdout.write(\'{"jsonrpc":"2.0","method":"ready"}\\n\'); setInterval(() => {}, 1000);',
      ],
      shell: false,
      shutdownTimeoutMs: 30,
      killTimeoutMs: 1000,
    });
    const child = (transport as unknown as { child: ChildProcess }).child;
    try {
      await transport.messages().next();
      const kill = vi.spyOn(child, "kill");
      await Promise.all([transport.close(), transport.close()]);
      if (process.platform === "win32") {
        const signals = kill.mock.calls.map(([signal]) => signal);
        expect(signals[0]).toBeUndefined();
        expect(signals.slice(1)).toEqual(signals.length === 2 ? ["SIGKILL"] : []);
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      } else {
        expect(kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
        expect(child.signalCode).toBe("SIGKILL");
      }
    } finally {
      await transport.close();
    }
  });

  it("detects stdout EOF even while the child is still alive, then waits for exit on close", async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: [
        "-e",
        "if (process.platform === 'win32') require('node:fs').closeSync(1); else process.stdout.end(); setInterval(() => {}, 1000);",
      ],
      shell: false,
      shutdownTimeoutMs: 30,
    });
    const child = (transport as unknown as { child: ChildProcess }).child;
    try {
      expect(await transport.messages().next()).toEqual({ done: true, value: undefined });
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      await transport.close();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      await transport.close();
    }
  }, 15_000);

  it("rejects an unconfirmed exit rather than treating kill acknowledgement as exit", async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write(\'{"jsonrpc":"2.0","method":"ready"}\\n\'); setInterval(() => {}, 1000);',
      ],
      shell: false,
      shutdownTimeoutMs: 10,
      killTimeoutMs: 20,
    });
    const child = (transport as unknown as { child: ChildProcess }).child;
    await transport.messages().next();
    const originalKill = child.kill.bind(child);
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    try {
      await expect(transport.close()).rejects.toThrow("exit");
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      kill.mockRestore();
      originalKill("SIGKILL");
      await transport.close();
    }
  });
});
