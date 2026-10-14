import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortDesktopTurnControllers,
  desktopUserAbortLoopOptions,
} from "../src/cli/commands/desktop.js";
import { DeepSeekClient } from "../src/client.js";
import { runDesktopLightAsk } from "../src/desktop/ask-light.js";
import { DesktopTurnAdmission } from "../src/desktop/turn-admission.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";

afterEach(() => vi.restoreAllMocks());

function response() {
  return Response.json({
    choices: [
      { message: { role: "assistant", content: "provider answered" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
}

function pendingResponse(signal?: AbortSignal | null) {
  return new Promise<Response>((_resolve, reject) => {
    const aborted = () => reject(new DOMException("cancelled", "AbortError"));
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
}

function makeTab(fetch: typeof globalThis.fetch) {
  const loop = new CacheFirstLoop({
    client: new DeepSeekClient({
      apiKey: "synthetic-cancel-ownership-test-only",
      fetch,
      retry: { maxAttempts: 1 },
    }),
    prefix: new ImmutablePrefix({ system: "test cancellation ownership" }),
    stream: false,
    historySummaryTimeoutMs: 1000,
  });
  return {
    aborter: null as AbortController | null,
    turnAdmission: new DesktopTurnAdmission(),
    runtime: { loop },
  };
}

describe("desktop turn cancellation ownership", { retry: 0 }, () => {
  it("Ask cancel does not poison the next Agent or suppress its provider request", async () => {
    const called = vi.fn(
      (_url: unknown, init?: RequestInit): Promise<Response> =>
        called.mock.calls.length === 1
          ? pendingResponse(init?.signal)
          : Promise.resolve(response()),
    );
    const tab = makeTab(called);
    const loop = tab.runtime.loop;
    const loopAbort = vi.spyOn(loop, "abort");
    const generation = tab.turnAdmission.begin("ask")!;
    tab.aborter = new AbortController();
    const askSignal = tab.aborter.signal;
    const started = loop.beginLightAsk("cancel this Ask");
    const ask = runDesktopLightAsk({
      client: loop.client,
      model: loop.model,
      text: "cancel this Ask",
      turn: started.turn,
      signal: askSignal,
      emit: () => {},
    }).catch((error: Error) => error);
    await vi.waitFor(() => expect(called).toHaveBeenCalledTimes(1));

    abortDesktopTurnControllers(tab, desktopUserAbortLoopOptions());
    expect(askSignal.aborted).toBe(true);
    expect(await ask).toMatchObject({ name: "AbortError" });
    tab.aborter = null;
    tab.turnAdmission.finish(generation);

    const next = tab.turnAdmission.begin("agent")!;
    tab.aborter = new AbortController();
    const result = await loop.run("Agent after cancelled Ask");
    tab.aborter = null;
    tab.turnAdmission.finish(next);

    expect(called).toHaveBeenCalledTimes(2);
    expect(result).toBe("provider answered");
    expect(loopAbort).not.toHaveBeenCalled();
    expect(called.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
  });

  it("cancels Ask during preparation without poisoning an Agent that follows", async () => {
    const called = vi.fn(async () => response());
    const tab = makeTab(called);
    const generation = tab.turnAdmission.begin("ask")!;
    tab.aborter = new AbortController();
    const signal = tab.aborter.signal;
    abortDesktopTurnControllers(tab);
    expect(() => signal.throwIfAborted()).toThrow();
    tab.aborter = null;
    tab.turnAdmission.finish(generation);
    expect(called).not.toHaveBeenCalled();
    expect(await tab.runtime.loop.run("next Agent")).toBe("provider answered");
    expect(called).toHaveBeenCalledTimes(1);
  });

  it("Agent preparation cancellation returns before step and does not poison the next Agent", async () => {
    const called = vi.fn(async () => response());
    const tab = makeTab(called);
    const loop = tab.runtime.loop;
    const step = vi.spyOn(loop, "step");
    const generation = tab.turnAdmission.begin("agent")!;
    tab.aborter = new AbortController();
    const signal = tab.aborter.signal;
    // Match runTurn: await preparation, throwIfAborted, finally release. No cancelled step.
    const preparation = (async () => {
      try {
        await Promise.resolve();
        signal.throwIfAborted();
        tab.turnAdmission.enterAgentLoop(generation);
        return await loop.run("prepared Agent");
      } finally {
        tab.aborter = null;
        tab.turnAdmission.finish(generation);
      }
    })().catch((error: Error) => error);
    abortDesktopTurnControllers(tab);
    expect(await preparation).toMatchObject({ name: "AbortError" });
    expect(step).not.toHaveBeenCalled();
    expect(called).not.toHaveBeenCalled();
    const next = tab.turnAdmission.begin("agent")!;
    tab.aborter = new AbortController();
    tab.turnAdmission.enterAgentLoop(next);
    const result = await loop.run("Agent after cancelled preparation");
    tab.aborter = null;
    tab.turnAdmission.finish(next);
    expect(called).toHaveBeenCalledTimes(1);
    expect(result).toBe("provider answered");
  });

  it("preserves carryAbort when cancellation reaches the loop handoff before step starts", async () => {
    const called = vi.fn(async () => response());
    const tab = makeTab(called);
    const generation = tab.turnAdmission.begin("agent")!;
    tab.aborter = new AbortController();
    tab.turnAdmission.enterAgentLoop(generation);
    const signal = tab.aborter.signal;
    abortDesktopTurnControllers(tab);
    expect(signal.aborted).toBe(true);
    // Once handed to the loop, pre-step cancellation must still be carried into iter 0.
    expect(await tab.runtime.loop.run("cancelled preparation")).toContain("aborted by user");
    expect(called).not.toHaveBeenCalled();
    tab.aborter = null;
    tab.turnAdmission.finish(generation);
    expect(await tab.runtime.loop.run("new Agent")).toBe("provider answered");
    expect(called).toHaveBeenCalledTimes(1);
  });

  it("cancels a running Agent request and allows the following Agent", async () => {
    const called = vi.fn(
      (_url: unknown, init?: RequestInit): Promise<Response> =>
        called.mock.calls.length === 1
          ? pendingResponse(init?.signal)
          : Promise.resolve(response()),
    );
    const tab = makeTab(called);
    const generation = tab.turnAdmission.begin("agent")!;
    tab.aborter = new AbortController();
    tab.turnAdmission.enterAgentLoop(generation);
    const events: Array<{ role: string; content: string }> = [];
    const running = tab.runtime.loop.run("running Agent", (event) => events.push(event));
    await vi.waitFor(() => expect(called).toHaveBeenCalledTimes(1));
    abortDesktopTurnControllers(tab);
    expect(called.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(await running).toBe("");
    expect(events.filter((event) => event.role === "done")).toEqual([
      expect.objectContaining({ content: "" }),
    ]);
    expect(events.some((event) => event.role === "error")).toBe(false);
    tab.aborter = null;
    tab.turnAdmission.finish(generation);
    expect(await tab.runtime.loop.run("new Agent")).toBe("provider answered");
    expect(called).toHaveBeenCalledTimes(2);
  });

  it("still cancels manual compaction without an admitted turn or poisoning the next Agent", async () => {
    const called = vi.fn(
      (_url: unknown, init?: RequestInit): Promise<Response> =>
        called.mock.calls.length === 1
          ? pendingResponse(init?.signal)
          : Promise.resolve(response()),
    );
    const tab = makeTab(called);
    for (let i = 0; i < 10; i++) {
      tab.runtime.loop.log.append({
        role: "user",
        content: `question ${i} ${"padding ".repeat(1200)}`,
      });
      tab.runtime.loop.log.append({
        role: "assistant",
        content: `answer ${i} ${"padding ".repeat(1200)}`,
      });
    }
    const compact = tab.runtime.loop.manualCompactHistory();
    await vi.waitFor(() => expect(called).toHaveBeenCalledTimes(1));
    expect(tab.turnAdmission.running).toBe(false);
    abortDesktopTurnControllers(tab);
    expect(await compact).toMatchObject({ folded: false, reason: "summary-cancelled" });
    expect(await tab.runtime.loop.run("Agent after compaction cancellation")).toBe(
      "provider answered",
    );
    expect(called).toHaveBeenCalledTimes(2);
  });

  it("ties cancellation ownership to the generation, including failed admission and invalidation", () => {
    const admission = new DesktopTurnAdmission();
    const ask = admission.begin("ask")!;
    expect(admission.begin("agent")).toBeNull();
    expect(admission.kind).toBe("ask");
    expect(admission.enterAgentLoop(ask)).toBe(false);
    expect(admission.loopEntered).toBe(false);
    expect(admission.finish(ask + 1)).toBe(false);
    expect(admission.kind).toBe("ask");
    admission.invalidate();
    expect(admission.kind).toBeNull();
    expect(admission.loopEntered).toBe(false);
    const agent = admission.begin("agent")!;
    expect(admission.enterAgentLoop(ask)).toBe(false);
    expect(admission.enterAgentLoop(agent)).toBe(true);
    expect(admission.finish(ask)).toBe(false);
    expect(admission.kind).toBe("agent");
    expect(admission.loopEntered).toBe(true);
    expect(admission.finish(agent)).toBe(true);
    expect(admission.kind).toBeNull();
    expect(admission.loopEntered).toBe(false);
  });

  it("wires actual Ask/Agent admission and abortTurn through the tested cancellation route", () => {
    const source = readFileSync("src/cli/commands/desktop.ts", "utf8");
    const ask = source.slice(
      source.indexOf("  function runLightAskOnTab("),
      source.indexOf("  function handleDesktopSlash("),
    );
    const agent = source.slice(
      source.indexOf("  async function runTurn("),
      source.indexOf("  async function switchWorkspace("),
    );
    const abort = source.slice(
      source.indexOf("  function abortTurn("),
      source.indexOf("  function tabSessionLabel("),
    );
    expect(ask).toContain('tab.turnAdmission.begin("ask")');
    expect(agent).toContain('tab.turnAdmission.begin("agent")');
    const handoff = agent.indexOf("tab.turnAdmission.enterAgentLoop(generation)");
    expect(handoff).toBeGreaterThan(agent.indexOf("const report = await runHooks("));
    expect(agent.lastIndexOf("tab.aborter?.signal.throwIfAborted();", handoff)).toBeGreaterThan(
      agent.indexOf("const report = await runHooks("),
    );
    expect(handoff).toBeLessThan(agent.indexOf("rt.loop.step(modelText"));
    expect(handoff).toBeLessThan(agent.indexOf("rt.loop.retryFailedModelRequest("));
    expect(abort).toContain("abortDesktopTurnControllers(tab, opts)");
  });
});
