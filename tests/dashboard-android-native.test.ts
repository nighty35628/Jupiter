import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Request = {
  version: number;
  requestId: string;
  runId: string;
  command: string;
  args: Record<string, unknown>;
};
type Port = {
  postMessage: ReturnType<typeof vi.fn<(message: string) => void>>;
  onmessage?: (event: MessageEvent<string>) => void;
};

const RUN = "android-test-run";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
let host: EventTarget & { JupiterAndroid?: Port };
let port: Port;
let requests: Request[];
let outstanding: Promise<unknown>[];

function track<T>(promise: Promise<T>): Promise<T> {
  outstanding.push(promise);
  void promise.catch(() => undefined);
  return promise;
}

function reply(request: Request, fields: Record<string, unknown> = {}): void {
  port.onmessage?.({
    data: JSON.stringify({ requestId: request.requestId, runId: RUN, ok: true, ...fields }),
  } as MessageEvent<string>);
}

async function loadBridge(platform: string | null = "android", run: string | null = RUN) {
  vi.stubGlobal("document", {
    querySelector: (selector: string) => {
      const content =
        selector === 'meta[name="jupiter-platform"]'
          ? platform
          : selector === 'meta[name="jupiter-run"]'
            ? run
            : null;
      return content === null ? null : { getAttribute: () => content };
    },
  });
  return import("../dashboard/src/lib/android-native");
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  requests = [];
  outstanding = [];
  port = { postMessage: vi.fn((message: string) => requests.push(JSON.parse(message))) };
  host = Object.assign(new EventTarget(), { JupiterAndroid: port });
  vi.stubGlobal("window", host);
});

afterEach(async () => {
  host.dispatchEvent(new Event("pagehide"));
  await Promise.allSettled(outstanding);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Android native message bridge", { retry: 0 }, () => {
  it.each([
    [null, RUN],
    ["browser", RUN],
    ["android", null],
    ["android", ""],
  ])("rejects disconnected metadata (%s, %s) before sending", async (platform, run) => {
    const { callAndroid } = await loadBridge(platform, run);
    await expect(callAndroid("notificationStatus")).rejects.toThrow(
      "Android host is not connected",
    );
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it("rejects a missing native port", async () => {
    const { callAndroid } = await loadBridge();
    host.JupiterAndroid = undefined;
    await expect(callAndroid("notificationStatus")).rejects.toThrow(
      "Android host is not connected",
    );
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it("sends a versioned envelope and correlates out-of-order replies", async () => {
    const { callAndroid, isAndroidLocal } = await loadBridge();
    expect(isAndroidLocal).toBe(true);
    const first = track(callAndroid("openExternal", { url: "https://example.com" }));
    const second = track(callAndroid<boolean>("notificationStatus"));
    expect(requests[0]).toEqual({
      version: 1,
      requestId: expect.any(String),
      runId: RUN,
      command: "openExternal",
      args: { url: "https://example.com" },
    });
    expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId);
    expect(requests[1]!.args).toEqual({});
    reply(requests[1]!, { result: false });
    await expect(second).resolves.toBe(false);
    reply(requests[0]!, { result: "opened" });
    await expect(first).resolves.toBe("opened");
    expect(port.postMessage).toHaveBeenCalledTimes(2);
  });

  it("ignores another run, unknown IDs, and duplicates without settling other requests", async () => {
    const { callAndroid } = await loadBridge();
    const first = track(callAndroid("notificationStatus"));
    const second = track(callAndroid("notificationPermission"));
    const firstSettled = vi.fn();
    const secondSettled = vi.fn();
    void first.then(firstSettled, firstSettled);
    void second.then(secondSettled, secondSettled);
    reply(requests[0]!, { runId: "previous-run", result: "stale" });
    reply(requests[0]!, { requestId: "unknown", ok: false, error: "unknown" });
    reply(requests[0]!, { requestId: 12 });
    await Promise.resolve();
    expect(firstSettled).not.toHaveBeenCalled();
    expect(secondSettled).not.toHaveBeenCalled();
    reply(requests[0]!, { result: "first" });
    await expect(first).resolves.toBe("first");
    reply(requests[0]!, { ok: false, error: "duplicate" });
    expect(firstSettled).toHaveBeenCalledOnce();
    expect(secondSettled).not.toHaveBeenCalled();
    reply(requests[1]!, { result: "second" });
    await expect(second).resolves.toBe("second");
    expect(port.postMessage).toHaveBeenCalledTimes(2);
  });

  it.each(["{", "null", "1", '"reply"', "[]", "{}"])(
    "ignores malformed or non-envelope reply %s without losing the request",
    async (data) => {
      const { callAndroid } = await loadBridge();
      const pending = track(callAndroid("notificationStatus"));
      const settled = vi.fn();
      void pending.then(settled, settled);
      expect(() => port.onmessage?.({ data } as MessageEvent<string>)).not.toThrow();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      reply(requests[0]!, { result: true });
      await expect(pending).resolves.toBe(true);
    },
  );

  it("allows exactly 16 pending requests and reuses a slot only after a matching reply", async () => {
    const { callAndroid } = await loadBridge();
    const pending = Array.from({ length: 16 }, () => track(callAndroid("notificationStatus")));
    await expect(callAndroid("notificationStatus")).rejects.toThrow(
      "Too many pending Android operations",
    );
    reply(requests[0]!, { runId: "old-run" });
    reply(requests[0]!, { requestId: "unknown" });
    await expect(callAndroid("notificationStatus")).rejects.toThrow(
      "Too many pending Android operations",
    );
    expect(port.postMessage).toHaveBeenCalledTimes(16);
    reply(requests[4]!, { result: true });
    await expect(pending[4]).resolves.toBe(true);
    const replacement = track(callAndroid("notificationStatus"));
    expect(port.postMessage).toHaveBeenCalledTimes(17);
    reply(requests[4]!, { result: "duplicate" });
    await expect(callAndroid("notificationStatus")).rejects.toThrow(
      "Too many pending Android operations",
    );
    reply(requests[16]!, { result: "replacement" });
    await expect(replacement).resolves.toBe("replacement");
    host.dispatchEvent(new Event("pagehide"));
    const results = await Promise.allSettled(pending);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(15);
  });

  it.each(["a", "\u754c"])(
    "enforces the 8192-byte UTF-8 envelope boundary with %s",
    async (character) => {
      const { callAndroid } = await loadBridge();
      vi.spyOn(crypto, "randomUUID").mockReturnValue(REQUEST_ID);
      const envelopeBytes = new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          requestId: REQUEST_ID,
          runId: RUN,
          command: "notify",
          args: { text: "" },
        }),
      ).length;
      const remaining = 8192 - envelopeBytes;
      const width = new TextEncoder().encode(character).length;
      const text = character.repeat(Math.floor(remaining / width)) + "a".repeat(remaining % width);
      await expect(callAndroid("notify", { text: `${text}a` })).rejects.toThrow(
        "Android request is too large",
      );
      expect(port.postMessage).not.toHaveBeenCalled();
      const accepted = track(callAndroid("notify", { text }));
      expect(new TextEncoder().encode(port.postMessage.mock.calls[0]![0])).toHaveLength(8192);
      reply(requests[0]!, { result: "accepted" });
      await expect(accepted).resolves.toBe("accepted");
    },
  );

  it.each(["Native permission denied", ""])(
    "rejects native failure (%s) without resending",
    async (error) => {
      const { callAndroid } = await loadBridge();
      const pending = track(callAndroid("openExternal"));
      reply(requests[0]!, { ok: false, error });
      await expect(pending).rejects.toThrow(error || "Android operation failed");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(port.postMessage).toHaveBeenCalledOnce();
    },
  );

  it("releases a pending slot on channel failure without an automatic retry", async () => {
    const { callAndroid } = await loadBridge();
    port.postMessage.mockImplementationOnce(() => {
      throw new Error("port closed");
    });
    await expect(callAndroid("notificationStatus")).rejects.toThrow("Android host channel failed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(port.postMessage).toHaveBeenCalledOnce();
    const pending = Array.from({ length: 16 }, () => track(callAndroid("notificationStatus")));
    expect(requests).toHaveLength(16);
    for (const request of requests) reply(request, { result: true });
    await expect(Promise.all(pending)).resolves.toEqual(Array(16).fill(true));
  });

  it("rejects every outstanding operation on pagehide and ignores late replies", async () => {
    const { callAndroid } = await loadBridge();
    const pending = Array.from({ length: 16 }, () => track(callAndroid("notificationStatus")));
    const results = Promise.allSettled(pending);
    host.dispatchEvent(new Event("pagehide"));
    for (const result of await results) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: new Error("Android page disconnected"),
      });
    }
    for (const request of requests) reply(request, { result: "late" });
    host.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(port.postMessage).toHaveBeenCalledTimes(16);
  });
});

describe("Android file export result", { retry: 0 }, () => {
  it.each([{ cancelled: true }, { cancelled: true, saved: true }])(
    "surfaces native cancellation as AbortError without retry (%j)",
    async (result) => {
      const { downloadAndroidFile } = await loadBridge();
      const pending = track(downloadAndroidFile("test-file-id", "report.md"));
      expect(requests[0]).toMatchObject({
        command: "downloadFile",
        args: { fileId: "test-file-id", name: "report.md" },
      });
      reply(requests[0]!, { result });
      await expect(pending).rejects.toMatchObject({
        name: "AbortError",
        message: "Export cancelled",
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(port.postMessage).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, null, {}, { saved: false }])(
    "rejects an incomplete native save (%j)",
    async (result) => {
      const { downloadAndroidFile } = await loadBridge();
      const pending = track(downloadAndroidFile("test-file-id", "report.md"));
      reply(requests[0]!, { result });
      await expect(pending).rejects.toThrow("Android export did not complete");
      expect(port.postMessage).toHaveBeenCalledOnce();
    },
  );

  it("finishes only when Native confirms the file was saved", async () => {
    const { downloadAndroidFile } = await loadBridge();
    const pending = track(downloadAndroidFile("test-file-id", "report.md"));
    reply(requests[0]!, { result: { saved: true } });
    await expect(pending).resolves.toBeUndefined();
  });
});
