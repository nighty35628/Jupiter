import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ComputerUseController,
  ComputerUseDriverProcess,
  ComputerUseDriverUnavailableError,
  ComputerUseLease,
  ComputerUseRuntime,
} from "../src/computer-use/index.js";
import type { McpClient } from "../src/mcp/client.js";

describe("Computer Use driver process", () => {
  it("holds the lease through cancelled initialization until a TERM-resistant fake child exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "jupiter-cua-cancel-exit-"));
    const marker = join(root, "ready");
    const lease = new ComputerUseLease({ path: join(root, "lock") });
    const controller = new ComputerUseController(lease);
    const disconnect = vi.fn();
    const server = [
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
      "const rl = require('node:readline').createInterface({input: process.stdin});",
      `rl.on('line', line => { if (JSON.parse(line).method === 'initialize') require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); });`,
    ].join("\n");
    const runtime = new ComputerUseRuntime(
      {
        command: process.execPath,
        args: ["-e", server],
        shutdownTimeoutMs: 100,
        killTimeoutMs: 1000,
        onDisconnect: disconnect,
      },
      controller,
    );
    const abort = new AbortController();
    const start = runtime.start("first", abort.signal);
    const rejected = expect(start).rejects.toThrow();
    try {
      await vi.waitFor(async () => {
        expect(await readFile(marker, "utf8")).toMatch(/^\d+$/);
      });
      const pid = Number(await readFile(marker, "utf8"));
      abort.abort();
      expect(controller.active).toBe(false);
      await expect(lease.acquire("second")).rejects.toThrow("already controlled");
      await Promise.all([rejected, runtime.stop()]);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(disconnect).not.toHaveBeenCalled();
      const next = await lease.acquire("second");
      await next.release();
    } finally {
      await runtime.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("reports a disconnected driver promptly even if its process is still alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "jupiter-cua-disconnect-"));
    let disconnected!: (error: Error) => void;
    const fault = new Promise<Error>((resolve) => {
      disconnected = resolve;
    });
    const runtime = new ComputerUseRuntime(
      {
        command: process.execPath,
        args: [
          "-e",
          "const rl = require('node:readline').createInterface({input:process.stdin}); rl.on('line', line => { const r=JSON.parse(line); if(r.method==='initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}})+'\\n'); if(r.method==='notifications/initialized') { if(process.platform==='win32') require('node:fs').closeSync(1); else process.stdout.end(); } }); setInterval(()=>{},1000);",
        ],
        onDisconnect: disconnected,
      },
      new ComputerUseController(new ComputerUseLease({ path: join(root, "lock") })),
    );
    try {
      await runtime.start("test");
      await fault;
      expect(runtime.driver.running).toBe(false);
      expect(runtime.controller.active).toBe(false);
      await runtime.stop();
    } finally {
      await runtime.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
  it("renews ownership while idle and stops renewing after shutdown", async () => {
    vi.useFakeTimers();
    const runtime = new ComputerUseRuntime();
    vi.spyOn(runtime.controller, "start").mockResolvedValue();
    const renew = vi.spyOn(runtime.controller, "renew").mockResolvedValue();
    vi.spyOn(runtime.controller, "stop").mockResolvedValue();
    vi.spyOn(runtime.driver, "start").mockResolvedValue({} as McpClient);
    vi.spyOn(runtime.driver, "close").mockResolvedValue();
    try {
      await runtime.start("test");
      await vi.advanceTimersByTimeAsync(25_000);
      expect(renew).toHaveBeenCalledTimes(2);
      await runtime.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(renew).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.stop();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
  it("completes an isolated MCP handshake with a child process", async () => {
    const server = [
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', (line) => {",
      "  const request = JSON.parse(line);",
      "  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'fake-cua', version: 'test' }, capabilities: { tools: {} } } }) + '\\n');",
      "});",
    ].join("\n");
    const driver = new ComputerUseDriverProcess({
      command: process.execPath,
      args: ["-e", server],
    });
    const client = await driver.start();
    expect(client.serverInfo).toMatchObject({ name: "fake-cua", version: "test" });
    expect(client.protocolVersion).toBe("2024-11-05");
    await driver.close();
    expect(driver.running).toBe(false);
  });

  it("reports a missing driver without leaving a desktop lease behind", async () => {
    const driver = new ComputerUseDriverProcess({
      command: "jupiter-command-that-does-not-exist",
    });
    await expect(driver.start()).rejects.toBeInstanceOf(ComputerUseDriverUnavailableError);
    expect(driver.running).toBe(false);
  });

  it("releases the controller when driver startup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "jupiter-cua-startup-"));
    const lease = new ComputerUseLease({ path: join(root, "lock") });
    const runtime = new ComputerUseRuntime(
      {
        command: "jupiter-command-that-does-not-exist",
      },
      new ComputerUseController(lease),
    );
    try {
      await expect(runtime.start("test-session")).rejects.toBeInstanceOf(
        ComputerUseDriverUnavailableError,
      );
      expect(runtime.controller.active).toBe(false);
      const next = await lease.acquire("replacement");
      await next.release();
    } finally {
      await runtime.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
