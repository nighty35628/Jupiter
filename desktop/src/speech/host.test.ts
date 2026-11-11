// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { emitMockEvent } from "../../../tests/mocks/tauri-api-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { speechHost } from "./host";
import type { SpeechEvent } from "./controller";
const subscriptions: (() => void)[] = [];
afterEach(() => { subscriptions.splice(0).forEach(stop => stop()); vi.useRealTimers(); });
async function listen(receive: (event: SpeechEvent) => void) {
  const stop = await speechHost.listen(receive);
  subscriptions.push(stop);
  return stop;
}
function channel() {
  return ([...vi.mocked(invoke).mock.calls].reverse().find(([command]) => command === "speech_start")?.[1] as {
    onEvent: { onmessage(event: unknown): void };
  }).onEvent;
}

describe("native speech transport isolation", { retry: 0 }, () => {
  it("receives Desktop results through the caller channel, never global events", async () => {
    delete document.documentElement.dataset.hostPlatform;
    const receive = vi.fn();
    const stop = await listen(receive);
    await speechHost.start("transport-qa", "en", "local");
    const event = { sessionId: "transport-qa", state: "result", text: "owned channel" };
    emitMockEvent("jupiter:speech", event);
    expect(receive).not.toHaveBeenCalled();
    const args = [...vi.mocked(invoke).mock.calls].reverse().find(([command]) => command === "speech_start")?.[1] as {
      onEvent: { onmessage(event: unknown): void };
    };
    args.onEvent.onmessage(event);
    expect(receive).toHaveBeenCalledWith(event);
    stop();
    args.onEvent.onmessage(event);
    expect(receive).toHaveBeenCalledOnce();
  });
  it("reassembles private chunks before publishing exactly one final result", async () => {
    const receive = vi.fn();
    const stop = await listen(receive);
    await speechHost.start("chunks", "zh", "local");
    const transport = channel();
    const first = "语音\"\n".repeat(1200), second = "done";
    transport.onmessage({ sessionId: "chunks", state: "result", text: first, part: 0, last: false });
    expect(receive).not.toHaveBeenCalled();
    transport.onmessage({ sessionId: "chunks", state: "result", text: second, part: 1, last: true });
    expect(receive).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledWith({ sessionId: "chunks", state: "result", text: first + second });
    stop();
  });
  it("rejects missing or out-of-order chunks without publishing partial text", async () => {
    const receive = vi.fn();
    const stop = await listen(receive);
    await speechHost.start("chunk-order", "en", "local");
    const transport = channel();
    transport.onmessage({ sessionId: "wrong", state: "result", text: "foreign", part: 0, last: true });
    transport.onmessage({ sessionId: "chunk-order", state: "result", text: "lost first chunk", part: 1, last: true });
    expect(receive).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledWith({ sessionId: "chunk-order", state: "error", error: "transport" });
    stop();
  });
  it("discards unfinished chunks on native cancellation", async () => {
    const receive = vi.fn();
    const stop = await listen(receive);
    await speechHost.start("chunk-cancel", "en", "local");
    const transport = channel();
    transport.onmessage({ sessionId: "chunk-cancel", state: "result", text: "prefix", part: 0, last: false });
    transport.onmessage({ sessionId: "chunk-cancel", state: "cancelled" });
    transport.onmessage({ sessionId: "chunk-cancel", state: "result", text: "late", part: 1, last: true });
    expect(receive).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledWith({ sessionId: "chunk-cancel", state: "cancelled" });
    stop();
  });
  it("rejects a switch from chunks to a plain result or an oversized plain result", async () => {
    const receive = vi.fn();
    await listen(receive);
    await speechHost.start("chunk-switch", "en", "local");
    channel().onmessage({ sessionId: "chunk-switch", state: "result", text: "prefix", part: 0, last: false });
    channel().onmessage({ sessionId: "chunk-switch", state: "result", text: "suffix" });
    expect(receive).toHaveBeenCalledWith({ sessionId: "chunk-switch", state: "error", error: "transport" });
    await speechHost.start("too-long", "en", "local");
    channel().onmessage({ sessionId: "too-long", state: "result", text: "a".repeat(65537) });
    expect(receive).toHaveBeenLastCalledWith({ sessionId: "too-long", state: "error", error: "transport" });
    expect(receive).toHaveBeenCalledTimes(2);
  });
  it("expires incomplete chunks and never publishes the delayed tail", async () => {
    vi.useFakeTimers();
    const receive = vi.fn();
    await listen(receive);
    await speechHost.start("missing-tail", "en", "local");
    const transport = channel();
    transport.onmessage({ sessionId: "missing-tail", state: "result", text: "prefix", part: 0, last: false });
    await vi.advanceTimersByTimeAsync(10001);
    transport.onmessage({ sessionId: "missing-tail", state: "result", text: "tail", part: 1, last: true });
    expect(receive).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledWith({ sessionId: "missing-tail", state: "error", error: "transport" });
  });
  it("rejects an unfinished 128th chunk immediately", async () => {
    const receive = vi.fn();
    await listen(receive);
    await speechHost.start("capacity", "en", "local");
    const transport = channel();
    for (let part = 0; part < 128; part++) transport.onmessage({
      sessionId: "capacity", state: "result", text: "x", part, last: false,
    });
    expect(receive).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledWith({ sessionId: "capacity", state: "error", error: "transport" });
  });
});
