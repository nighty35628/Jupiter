import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerUseController } from "../src/computer-use/controller.js";
import { ComputerUseRuntime } from "../src/computer-use/driver-process.js";
import { ComputerUseLease, ComputerUseLeaseBusyError } from "../src/computer-use/lease.js";
import type { McpClient } from "../src/mcp/client.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "jupiter-cua-lifecycle-"));
  roots.push(root);
  const path = join(root, "lock");
  const lease = new ComputerUseLease({ path });
  const controller = new ComputerUseController(lease);
  return { root, path, lease, controller };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Computer Use ownership races", () => {
  it("has exactly one winner among simultaneous independent acquisitions", async () => {
    const { path } = await setup();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => new ComputerUseLease({ path }).acquire(`owner-${i}`)),
    );
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected")
        expect(result.reason).toBeInstanceOf(ComputerUseLeaseBusyError);
      else await result.value.release();
    }
  });
  it("refuses legacy, empty, and malformed lock directories", async () => {
    const { path, lease } = await setup();
    await mkdir(path);
    await expect(lease.acquire("new")).rejects.toBeInstanceOf(ComputerUseLeaseBusyError);
    await writeFile(join(path, "owner.json"), "{broken");
    await expect(lease.acquire("new")).rejects.toBeInstanceOf(ComputerUseLeaseBusyError);
    expect(await readFile(join(path, "owner.json"), "utf8")).toBe("{broken");
  });
  it("serializes renew and release without deleting a replacement owner", async () => {
    const { path, lease } = await setup();
    const handle = await lease.acquire("first");
    const renewals = Array.from({ length: 20 }, () => handle.renew());
    const release = handle.release();
    await Promise.all([...renewals, release, handle.release()]);
    const replacement = await new ComputerUseLease({ path }).acquire("second");
    await expect(handle.renew()).rejects.toThrow("no longer active");
    await handle.release();
    await expect(lease.acquire("third")).rejects.toBeInstanceOf(ComputerUseLeaseBusyError);
    await replacement.release();
  });
  it("does not overwrite or remove a record belonging to another token", async () => {
    const { path, lease } = await setup();
    const handle = await lease.acquire("first");
    const replacement = JSON.stringify({ token: "other", owner: "other", heartbeatAt: 1 });
    await writeFile(join(path, "owner.json"), replacement);
    await expect(handle.renew()).rejects.toThrow("no longer active");
    await handle.release();
    expect(await readFile(join(path, "owner.json"), "utf8")).toBe(replacement);
  });
  it("rejects concurrent controller starts and cancels a pending acquisition on stop", async () => {
    const { lease, controller } = await setup();
    const acquired = deferred<Awaited<ReturnType<ComputerUseLease["acquire"]>>>();
    const realAcquire = lease.acquire.bind(lease);
    vi.spyOn(lease, "acquire").mockImplementation(() => acquired.promise);
    const start = controller.start("first");
    const rejected = expect(start).rejects.toThrow();
    await expect(controller.start("second")).rejects.toThrow("already");
    const stop = controller.stop();
    acquired.resolve(await realAcquire("first"));
    await Promise.all([rejected, stop]);
    expect(controller.active).toBe(false);
    const next = await realAcquire("next");
    await next.release();
  });
});

describe("Computer Use runtime lifecycle", () => {
  it("does not release a preexisting controller session when startup refuses it", async () => {
    const { lease, controller } = await setup();
    await controller.start("existing");
    const fence = controller.fence();
    const runtime = new ComputerUseRuntime({}, controller);
    const spawn = vi.spyOn(runtime.driver, "start").mockResolvedValue({} as McpClient);
    vi.spyOn(runtime.driver, "close").mockResolvedValue();
    try {
      await expect(runtime.start("new")).rejects.toThrow("already active");
      expect(controller.active).toBe(true);
      expect(() => controller.assertFence(fence)).not.toThrow();
      expect(spawn).not.toHaveBeenCalled();
      await expect(lease.acquire("other")).rejects.toBeInstanceOf(ComputerUseLeaseBusyError);
    } finally {
      await controller.stop();
    }
  });
  it("does not let an old heartbeat fault or reschedule into a later generation", async () => {
    const { controller } = await setup();
    const runtime = new ComputerUseRuntime({}, controller);
    vi.spyOn(runtime.driver, "start").mockResolvedValue({} as McpClient);
    vi.spyOn(runtime.driver, "close").mockResolvedValue();
    const late = deferred<void>();
    const renew = vi
      .spyOn(controller, "renew")
      .mockImplementationOnce(() => late.promise)
      .mockResolvedValue();
    await runtime.start("first");
    vi.useFakeTimers();
    // Reschedule under the fake clock after a clean restart.
    await runtime.stop();
    await runtime.start("first");
    await vi.advanceTimersByTimeAsync(10_000);
    await runtime.stop();
    await runtime.start("second");
    late.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renew).toHaveBeenCalledTimes(2);
    expect(runtime.state).toBe("running");
    await runtime.stop();
    vi.useRealTimers();
  });

  it("stops on turn cancellation after startup and can restart only after cleanup", async () => {
    const { controller } = await setup();
    const runtime = new ComputerUseRuntime({}, controller);
    vi.spyOn(runtime.driver, "start").mockResolvedValue({} as McpClient);
    vi.spyOn(runtime.driver, "close").mockResolvedValue();
    const abort = new AbortController();
    await runtime.start("first", abort.signal);
    abort.abort();
    expect(controller.active).toBe(false);
    await runtime.stop();
    await runtime.start("second");
    expect(controller.active).toBe(true);
    await runtime.stop();
  });

  it("does not spawn if cancelled while waiting for the lease", async () => {
    const { lease, controller } = await setup();
    const runtime = new ComputerUseRuntime({}, controller);
    const realAcquire = lease.acquire.bind(lease);
    const acquired = deferred<Awaited<ReturnType<ComputerUseLease["acquire"]>>>();
    vi.spyOn(lease, "acquire").mockImplementation(() => acquired.promise);
    const spawn = vi.spyOn(runtime.driver, "start").mockResolvedValue({} as McpClient);
    vi.spyOn(runtime.driver, "close").mockResolvedValue();
    const abort = new AbortController();
    const start = runtime.start("first", abort.signal);
    const rejected = expect(start).rejects.toThrow();
    abort.abort();
    const stop = runtime.stop();
    acquired.resolve(await realAcquire("first"));
    await Promise.all([rejected, stop]);
    expect(spawn).not.toHaveBeenCalled();
    expect(controller.active).toBe(false);
    const next = await realAcquire("next");
    await next.release();
  });
  it("invalidates synchronously and keeps ownership until driver close really completes", async () => {
    const { lease, controller } = await setup();
    const runtime = new ComputerUseRuntime({}, controller);
    vi.spyOn(runtime.driver, "start").mockResolvedValue({} as McpClient);
    const exited = deferred<void>();
    vi.spyOn(runtime.driver, "close").mockImplementation(() => exited.promise);
    await runtime.start("first");
    const fence = controller.fence();
    const stop = runtime.stop();
    expect(controller.active).toBe(false);
    expect(() => controller.assertFence(fence)).toThrow();
    await expect(lease.acquire("second")).rejects.toBeInstanceOf(ComputerUseLeaseBusyError);
    await expect(runtime.start("second")).rejects.toThrow();
    exited.resolve();
    await stop;
    const next = await lease.acquire("second");
    await next.release();
  });
  it("cancels a pending handshake without reviving the runtime", async () => {
    const { lease, controller } = await setup();
    const runtime = new ComputerUseRuntime({}, controller);
    const started = deferred<McpClient>();
    const entered = deferred<void>();
    vi.spyOn(runtime.driver, "start").mockImplementation(async () => {
      entered.resolve();
      return started.promise;
    });
    vi.spyOn(runtime.driver, "close").mockResolvedValue();
    const start = runtime.start("first");
    const rejected = expect(start).rejects.toThrow();
    await entered.promise;
    const stop = runtime.stop();
    started.resolve({} as McpClient);
    await Promise.all([rejected, stop]);
    expect(controller.active).toBe(false);
    const next = await lease.acquire("next");
    await next.release();
  });
  it("retains ownership if process exit cannot be confirmed and allows cleanup retry", async () => {
    const { lease, controller } = await setup();
    const runtime = new ComputerUseRuntime({}, controller);
    vi.spyOn(runtime.driver, "start").mockResolvedValue({} as McpClient);
    const close = vi
      .spyOn(runtime.driver, "close")
      .mockRejectedValueOnce(new Error("exit unconfirmed"));
    await runtime.start("first");
    await expect(runtime.stop()).rejects.toThrow("exit unconfirmed");
    expect(controller.active).toBe(false);
    await expect(lease.acquire("second")).rejects.toBeInstanceOf(ComputerUseLeaseBusyError);
    close.mockResolvedValue();
    await runtime.stop();
    const next = await lease.acquire("second");
    await next.release();
  });
  it("does not acquire or spawn for an already aborted signal", async () => {
    const { lease, controller } = await setup();
    const runtime = new ComputerUseRuntime({}, controller);
    const start = vi.spyOn(runtime.driver, "start").mockResolvedValue({} as McpClient);
    vi.spyOn(runtime.driver, "close").mockResolvedValue();
    const abort = new AbortController();
    abort.abort();
    await expect(runtime.start("first", abort.signal)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
    const next = await lease.acquire("next");
    await next.release();
  });
});
