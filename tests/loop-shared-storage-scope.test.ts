import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import * as hooks from "../src/hooks.js";
import { CacheFirstLoop, type CacheFirstLoopOptions } from "../src/loop.js";
import type { RunOneToolCallResult } from "../src/loop/dispatch.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ToolRegistry } from "../src/tools.js";
import type { ToolCall } from "../src/types.js";

const call: ToolCall = {
  id: "call",
  type: "function",
  function: { name: "echo", arguments: "{}" },
};

function setup(scope: CacheFirstLoopOptions["toolExecutionScope"], order: string[] = []) {
  const execute = vi.fn(async () => {
    order.push("tool");
    return "ok";
  });
  const tools = new ToolRegistry().register({
    name: "echo",
    description: "echo",
    readOnly: true,
    parameters: { type: "object", properties: {} },
    fn: execute,
  });
  const loop = new CacheFirstLoop({
    client: new DeepSeekClient({ apiKey: "synthetic", fetch: vi.fn() }),
    prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
    tools,
    toolExecutionScope: scope,
  });
  const run = (signal = new AbortController().signal) =>
    (
      loop as unknown as {
        runOneToolCall(call: ToolCall, signal: AbortSignal): Promise<RunOneToolCallResult>;
      }
    ).runOneToolCall(call, signal);
  return { loop, execute, run };
}

afterEach(() => vi.restoreAllMocks());

describe("loop shared resource execution scope", { retry: 0 }, () => {
  it("holds the scope across pre-hook, execution and post-hook, then releases once", async () => {
    const order: string[] = [];
    const release = vi.fn(() => {
      order.push("release");
    });
    const scope = vi.fn(async () => {
      order.push("acquire");
      return release;
    });
    vi.spyOn(hooks, "runHooks").mockImplementation(async ({ payload }) => {
      order.push(payload.event);
      return { event: payload.event, outcomes: [], blocked: false };
    });
    const { run } = setup(scope, order);
    const signal = new AbortController().signal;
    expect((await run(signal)).result).toBe("ok");
    expect(scope).toHaveBeenCalledWith(call, signal);
    expect(order).toEqual(["acquire", "PreToolUse", "tool", "PostToolUse", "release"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("ok");
  });

  it("releases on an early pre-hook denial", async () => {
    const release = vi.fn();
    const hook = vi
      .spyOn(hooks, "runHooks")
      .mockResolvedValue({ event: "PreToolUse", outcomes: [], blocked: true });
    const { run, execute } = setup(async () => release);
    expect((await run()).result).toContain("hook block");
    expect(execute).not.toHaveBeenCalled();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(["PreToolUse", "PostToolUse"])("releases when %s throws", async (event) => {
    const release = vi.fn();
    vi.spyOn(hooks, "runHooks").mockImplementation(async ({ payload }) => {
      if (payload.event === event) throw new Error("hook failed");
      return { event: payload.event, outcomes: [], blocked: false };
    });
    const { run, loop } = setup(async () => release);
    await expect(run()).rejects.toThrow("hook failed");
    expect(release).toHaveBeenCalledTimes(1);
    expect(loop.inflight.size).toBe(0);
  });

  it("releases even if cancelled while awaiting resource admission, without running hooks", async () => {
    let admit!: (release: () => void) => void;
    const release = vi.fn();
    const hook = vi.spyOn(hooks, "runHooks");
    const { run, execute } = setup(
      () =>
        new Promise((resolve) => {
          admit = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = run(controller.signal);
    controller.abort();
    admit(release);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(hook).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not run hooks or tools if admission rejects", async () => {
    const hook = vi.spyOn(hooks, "runHooks");
    const { run, execute } = setup(async () => {
      throw new Error("resource conflict");
    });
    await expect(run()).rejects.toThrow("resource conflict");
    expect(hook).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes unknown external outcomes to the owner without retrying execution", async () => {
    const release = vi.fn();
    const { run, execute } = setup(async () => release);
    const result = JSON.stringify({ executionOutcome: "unknown_after_disconnect" });
    execute.mockResolvedValue(result);
    expect((await run()).result).toBe(result);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(result);
  });
});
