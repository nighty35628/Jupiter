import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RUN = "speech-test-run";
type Port = {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage?: (event: MessageEvent<string>) => void;
};
let port: Port;
let host: EventTarget & { JupiterAndroid?: Port };
let requests: { requestId: string; command: string; args: Record<string, unknown> }[];

async function load(platform = "android", run = RUN) {
  vi.stubGlobal("document", {
    querySelector: (selector: string) => ({
      getAttribute: () => (selector.includes("jupiter-platform") ? platform : run),
    }),
  });
  return import("../dashboard/src/lib/android-native");
}

function receive(message: unknown, source = port) {
  source.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>);
}
function speech(event: unknown, fields: Record<string, unknown> = {}) {
  receive({ type: "speech", runId: RUN, event, ...fields });
}

beforeEach(() => {
  vi.resetModules();
  requests = [];
  port = { postMessage: vi.fn((message: string) => requests.push(JSON.parse(message))) };
  host = Object.assign(new EventTarget(), { JupiterAndroid: port });
  vi.stubGlobal("window", host);
});

afterEach(() => {
  host.dispatchEvent(new Event("pagehide"));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Android speech event receiver", { retry: 0 }, () => {
  it("subscribes before any commands and routes each supported state", async () => {
    const { subscribeAndroidSpeech } = await load();
    const callback = vi.fn();
    subscribeAndroidSpeech(callback);
    for (const state of [
      "preparing",
      "recording",
      "transcribing",
      "result",
      "error",
      "cancelled",
    ]) {
      const event = {
        sessionId: "s1",
        state,
        ...(state === "result" ? { text: "hello" } : {}),
        ...(state === "error" ? { error: "No speech was detected" } : {}),
      };
      speech(event);
      expect(callback).toHaveBeenLastCalledWith(event);
    }
    expect(callback).toHaveBeenCalledTimes(6);
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it("keeps a subscription registered before the native port connects lazily", async () => {
    host.JupiterAndroid = undefined;
    const { subscribeAndroidSpeech, callAndroid } = await load();
    const callback = vi.fn();
    subscribeAndroidSpeech(callback);
    host.JupiterAndroid = port;
    const capabilities = callAndroid("speechCapabilities");
    receive({
      runId: RUN,
      requestId: requests[0]!.requestId,
      ok: true,
      result: { available: true },
    });
    await expect(capabilities).resolves.toEqual({ available: true });
    speech({ sessionId: "late-port", state: "recording" });
    expect(callback).toHaveBeenCalledWith({ sessionId: "late-port", state: "recording" });
  });

  it("can unsubscribe before the lazy port connection", async () => {
    host.JupiterAndroid = undefined;
    const { subscribeAndroidSpeech } = await load();
    const callback = vi.fn();
    const unsubscribe = subscribeAndroidSpeech(callback);
    unsubscribe();
    unsubscribe();
    host.JupiterAndroid = port;
    subscribeAndroidSpeech(vi.fn());
    speech({ sessionId: "s1", state: "recording" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("separates speech events from one-shot out-of-order command replies", async () => {
    const { subscribeAndroidSpeech, callAndroid } = await load();
    const callback = vi.fn();
    subscribeAndroidSpeech(callback);
    const start = callAndroid("speechStart", { sessionId: "s1", language: "zh", mode: "local" });
    const other = callAndroid("notificationStatus");
    const startSettled = vi.fn();
    void start.then(startSettled);
    const requestId = requests[0]!.requestId;
    speech(
      { sessionId: "s1", state: "recording", text: "partial" },
      { requestId, ok: true, result: "not a reply" },
    );
    await Promise.resolve();
    expect(startSettled).not.toHaveBeenCalled();
    receive({ runId: RUN, requestId: requests[1]!.requestId, ok: true, result: false });
    await expect(other).resolves.toBe(false);
    receive({ runId: RUN, requestId, ok: true, result: true });
    await expect(start).resolves.toBe(true);
    speech({ sessionId: "s1", state: "result", text: "final" });
    receive({ runId: RUN, requestId, ok: false, error: "duplicate ack" });
    expect(startSettled).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(requests[0]).toMatchObject({
      command: "speechStart",
      args: { language: "zh", mode: "local" },
    });
    expect(port.postMessage).toHaveBeenCalledTimes(2);
  });

  it.each([
    null,
    [],
    {},
    { sessionId: "s1", state: "idle" },
    { sessionId: 12, state: "recording" },
    { sessionId: "bad id", state: "recording" },
    { sessionId: "a".repeat(129), state: "recording" },
    { sessionId: "s1", state: "recording", text: 1 },
    { sessionId: "s1", state: "result" },
    { sessionId: "s1", state: "result", text: "  " },
    { sessionId: "s1", state: "error" },
    { sessionId: "s1", state: "error", error: false },
    { sessionId: "s1", state: "error", error: "a".repeat(513) },
    { sessionId: "s1", state: "result", text: "a".repeat(32769) },
  ])("ignores a malformed speech payload without disturbing the receiver (%#)", async (event) => {
    const { subscribeAndroidSpeech } = await load();
    const callback = vi.fn();
    subscribeAndroidSpeech(callback);
    speech(event);
    expect(callback).not.toHaveBeenCalled();
    speech({ sessionId: "s1", state: "recording" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("ignores stale runs, malformed JSON, unrelated replies, and disconnected ports", async () => {
    const { subscribeAndroidSpeech } = await load();
    const callback = vi.fn();
    subscribeAndroidSpeech(callback);
    speech({ sessionId: "s1", state: "recording" }, { runId: "previous-run" });
    port.onmessage?.({ data: "{" } as MessageEvent<string>);
    receive({ runId: RUN, requestId: "unknown", ok: true, result: true });
    host.JupiterAndroid = undefined;
    speech({ sessionId: "s1", state: "recording" });
    const oldPort = port;
    port = { postMessage: vi.fn() };
    host.JupiterAndroid = port;
    subscribeAndroidSpeech(vi.fn());
    receive(
      {
        type: "speech",
        runId: RUN,
        event: { sessionId: "s1", state: "result", text: "stale port" },
      },
      oldPort,
    );
    expect(callback).not.toHaveBeenCalled();
    speech({ sessionId: "s2", state: "recording" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("isolates subscribers and retains ordinary error replies", async () => {
    const { subscribeAndroidSpeech, callAndroid } = await load();
    const faulty = vi.fn(() => {
      throw new Error("subscriber failed");
    });
    const callback = vi.fn();
    subscribeAndroidSpeech(faulty);
    const off = subscribeAndroidSpeech(callback);
    speech({ sessionId: "s1", state: "preparing" });
    expect(callback).toHaveBeenCalledOnce();
    off();
    off();
    speech({ sessionId: "s1", state: "cancelled" });
    expect(callback).toHaveBeenCalledOnce();
    expect(faulty).toHaveBeenCalledTimes(2);
    const command = callAndroid("speechStart", {
      sessionId: "s1",
      language: "auto",
      mode: "local",
    });
    const rejected = expect(command).rejects.toThrow("Select a manual language");
    receive({
      runId: RUN,
      requestId: requests[0]!.requestId,
      ok: false,
      error: "Select a manual language",
    });
    await rejected;
  });

  it("disposes subscriptions and outstanding commands on pagehide", async () => {
    const { subscribeAndroidSpeech, callAndroid } = await load();
    const callback = vi.fn();
    subscribeAndroidSpeech(callback);
    const command = callAndroid("speechFinish", { sessionId: "s1" });
    const rejected = expect(command).rejects.toThrow("Android page disconnected");
    host.dispatchEvent(new Event("pagehide"));
    await rejected;
    speech({ sessionId: "s1", state: "result", text: "late" });
    receive({ runId: RUN, requestId: requests[0]!.requestId, ok: true });
    expect(callback).not.toHaveBeenCalled();
  });

  it.each([
    ["browser", RUN],
    ["android", ""],
  ])("does not subscribe without native metadata", async (platform, run) => {
    const { subscribeAndroidSpeech } = await load(platform, run);
    const off = subscribeAndroidSpeech(vi.fn());
    expect(off).toBeTypeOf("function");
    off();
    expect(port.onmessage).toBeUndefined();
    expect(port.postMessage).not.toHaveBeenCalled();
  });
});
