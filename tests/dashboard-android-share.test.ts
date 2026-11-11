import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AndroidShare } from "../dashboard/src/lib/android-native";
import type { WebDragDropEvent } from "../dashboard/src/lib/shell-services";
import { writeImageDraftIntake } from "../desktop/src/ui/image-draft-store";

vi.mock("../dashboard/src/lib/runtime-transport", () => ({
  emitRuntimeEvent: vi.fn(),
  getWebWorkspaceChoices: vi.fn(),
  uploadWebFile: vi.fn(),
}));

const ORIGIN = "http://127.0.0.1:1420";
const FILE_ID = "12345678-1234-4123-8123-123456789abc";
const SHARE_ID = "12345678-1234-4123-8123-123456789def";
type Drop = Extract<WebDragDropEvent["payload"], { type: "drop" }>;
let host: EventTarget;
let consume: ReturnType<typeof vi.fn>;
let acknowledge: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let platform: string;
let draftKey: string;

function completeShare(payload: Drop, persist: () => void = () => undefined) {
  payload.complete?.(() => {
    persist();
    writeImageDraftIntake(draftKey, payload.intakeId!, (draft) => ({
      ...draft,
      text: payload.text ?? draft.text,
    }));
  });
}

function share(overrides: Partial<AndroidShare> = {}): AndroidShare {
  return {
    id: SHARE_ID,
    text: "shared text",
    files: [
      {
        id: FILE_ID,
        name: "note.txt",
        mime: "text/plain",
        size: 5,
        url: `/native-share/${FILE_ID}`,
      },
    ],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ready() {
  host.dispatchEvent(new Event("jupiter:android-share-ready"));
}

async function shell() {
  return import("../dashboard/src/lib/shell-services");
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  draftKey = crypto.randomUUID();
  platform = "android";
  consume = vi.fn(async () => share());
  acknowledge = vi.fn(async () => undefined);
  fetchMock = vi.fn(async () => new Response(new Blob(["hello"], { type: "text/plain" })));
  vi.stubGlobal("fetch", fetchMock);
  host = new EventTarget();
  const port: {
    postMessage(message: string): void;
    onmessage?: (event: MessageEvent<string>) => void;
  } = {
    postMessage(message) {
      const request = JSON.parse(message);
      const operation = request.command === "consumeShare" ? consume : acknowledge;
      void Promise.resolve()
        .then(() => operation(request.args))
        .then(
          (result) =>
            port.onmessage?.({
              data: JSON.stringify({ ...request, ok: true, result }),
            } as MessageEvent<string>),
          (error) =>
            port.onmessage?.({
              data: JSON.stringify({ ...request, ok: false, error: error.message }),
            } as MessageEvent<string>),
        );
    },
  };
  Object.assign(host, { location: { origin: ORIGIN }, JupiterAndroid: port });
  vi.stubGlobal("window", host);
  vi.stubGlobal("document", {
    querySelector: (selector: string) => ({
      getAttribute: () =>
        selector === 'meta[name="jupiter-platform"]' ? platform : "share-test-run",
    }),
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  host.dispatchEvent(new Event("pagehide"));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Android share intake through the Web drop adapter", { retry: 0 }, () => {
  it("checks at boot only after a receiver exists and fetches same-origin Blob -> File", async () => {
    const { getCurrentWebview } = await shell();
    ready();
    expect(consume).not.toHaveBeenCalled();
    const order: string[] = [];
    let received: Drop | undefined;
    acknowledge.mockImplementation(async () => {
      order.push("ack");
    });
    const receiver = vi.fn(async ({ payload }: WebDragDropEvent) => {
      if (payload.type !== "drop") return;
      received = payload;
      order.push("draft-setters-processed");
      completeShare(payload, () => {
        order.push("persist");
      });
    });
    await getCurrentWebview().onDragDropEvent(receiver);
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
    expect(order).toEqual(["draft-setters-processed", "persist", "ack"]);
    expect(received).toMatchObject({ type: "drop", text: "shared text", intakeId: SHARE_ID });
    const file = received!.files![0]!;
    expect(file).toBeInstanceOf(File);
    expect([file.name, file.type, file.size, await file.text()]).toEqual([
      "note.txt",
      "text/plain",
      5,
      "hello",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(`/native-share/${FILE_ID}`, {
      headers: { "x-jupiter-share": SHARE_ID },
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
    expect(acknowledge).toHaveBeenCalledWith({ id: SHARE_ID });
  });

  it("accepts text-only shares without fetching a file", async () => {
    consume.mockResolvedValue(share({ files: [] }));
    const { getCurrentWebview } = await shell();
    await getCurrentWebview().onDragDropEvent(async ({ payload }) => {
      if (payload.type === "drop") completeShare(payload);
    });
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a ready event received between active callbacks for the next receiver", async () => {
    consume.mockResolvedValueOnce(null);
    const { getCurrentWebview } = await shell();
    const receiver = vi.fn(async ({ payload }: WebDragDropEvent) => {
      if (payload.type === "drop") completeShare(payload);
    });
    const stop = await getCurrentWebview().onDragDropEvent(receiver);
    await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce());
    stop();
    ready();
    await getCurrentWebview().onDragDropEvent(receiver);
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
    expect(consume).toHaveBeenCalledTimes(3);
    expect(receiver).toHaveBeenCalledOnce();
  });

  it("coalesces readiness across mounted tabs and holds acknowledgement until processing completes", async () => {
    const consumed = deferred<AndroidShare>();
    consume.mockReturnValue(consumed.promise);
    const processed = deferred<void>();
    const { getCurrentWebview } = await shell();
    const inactive = vi.fn(() => undefined);
    const active = vi.fn(async ({ payload }: WebDragDropEvent) => {
      await processed.promise;
      if (payload.type === "drop") completeShare(payload);
    });
    const otherActive = vi.fn(async () => undefined);
    await getCurrentWebview().onDragDropEvent(inactive);
    await getCurrentWebview().onDragDropEvent(active);
    await getCurrentWebview().onDragDropEvent(otherActive);
    ready();
    ready();
    consumed.resolve(share());
    await vi.waitFor(() => expect(active).toHaveBeenCalledOnce());
    expect(consume).toHaveBeenCalledOnce();
    expect(otherActive).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    processed.resolve();
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
  });

  it("waits for an active receiver without consuming another share", async () => {
    const { getCurrentWebview } = await shell();
    const inactive = vi.fn(() => undefined);
    await getCurrentWebview().onDragDropEvent(inactive);
    await vi.waitFor(() => expect(inactive).toHaveBeenCalledOnce());
    expect(acknowledge).not.toHaveBeenCalled();
    await getCurrentWebview().onDragDropEvent(async ({ payload }) => {
      if (payload.type === "drop") completeShare(payload);
    });
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
    expect(consume).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries a failed fetch only on the next explicit intake, never timers or remounts", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const { getCurrentWebview } = await shell();
    const receiver = vi.fn(async ({ payload }: WebDragDropEvent) => {
      if (payload.type === "drop") completeShare(payload);
    });
    const stop = await getCurrentWebview().onDragDropEvent(receiver);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    stop();
    await getCurrentWebview().onDragDropEvent(receiver);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(acknowledge).not.toHaveBeenCalled();
    vi.useRealTimers();
    ready();
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(consume).toHaveBeenCalledTimes(2);
    expect(receiver).toHaveBeenCalledOnce();
  });

  it.each(["persistence", "acknowledgement"])(
    "retries %s without duplicating draft intake",
    async (failure) => {
      const persist = vi.fn();
      if (failure === "persistence")
        persist.mockImplementationOnce(() => {
          throw new Error("quota");
        });
      else acknowledge.mockRejectedValueOnce(new Error("Native unavailable"));
      const { getCurrentWebview } = await shell();
      const receiver = vi.fn(async ({ payload }: WebDragDropEvent) => {
        if (payload.type === "drop") completeShare(payload, persist);
      });
      await getCurrentWebview().onDragDropEvent(receiver);
      await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
      expect(acknowledge).toHaveBeenCalledTimes(failure === "persistence" ? 0 : 1);
      ready();
      await vi.waitFor(() =>
        expect(acknowledge).toHaveBeenCalledTimes(failure === "persistence" ? 1 : 2),
      );
      expect(receiver).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(persist).toHaveBeenCalledTimes(failure === "persistence" ? 2 : 1);
    },
  );

  it("does not acknowledge a rejected or incomplete draft setter", async () => {
    const { getCurrentWebview } = await shell();
    const receiver = vi.fn(async () => undefined);
    await getCurrentWebview().onDragDropEvent(receiver);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(acknowledge).not.toHaveBeenCalled();
    ready();
    await vi.waitFor(() => expect(receiver).toHaveBeenCalledTimes(2));
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("does not acknowledge completion without a receipt persisted with the draft", async () => {
    const { getCurrentWebview } = await shell();
    await getCurrentWebview().onDragDropEvent(async ({ payload }) => {
      if (payload.type === "drop") payload.complete?.(() => undefined);
    });
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(acknowledge).not.toHaveBeenCalled();
    expect(localStorage.getItem(`jupiter.image-draft.v1:${draftKey}`)).toBeNull();
  });

  it("does not redeliver an already persisted share replayed by Native", async () => {
    const { getCurrentWebview } = await shell();
    const receiver = vi.fn(async ({ payload }: WebDragDropEvent) => {
      if (payload.type === "drop") completeShare(payload);
    });
    await getCurrentWebview().onDragDropEvent(receiver);
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
    ready();
    await vi.waitFor(() => expect(consume).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2));
    expect(receiver).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts a file fetch on pagehide without acknowledging or dispatching the share", async () => {
    fetchMock.mockImplementation(
      (_url, { signal }: RequestInit) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () => reject(new DOMException("pagehide", "AbortError")),
            { once: true },
          );
        }),
    );
    const { getCurrentWebview } = await shell();
    const receiver = vi.fn();
    await getCurrentWebview().onDragDropEvent(receiver);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    host.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
    ready();
    expect(receiver).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledOnce();
  });

  it.each([null, "browser"])(
    "does not consume shares on a non-Android surface (%s)",
    async (value) => {
      platform = value ?? "";
      const { getCurrentWebview } = await shell();
      await getCurrentWebview().onDragDropEvent(vi.fn());
      ready();
      expect(consume).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("Android share descriptor and file bounds", { retry: 0 }, () => {
  it("accepts null and exactly 12 files totaling 100 MiB", async () => {
    const { consumeAndroidShare } = await import("../dashboard/src/lib/android-native");
    consume.mockResolvedValueOnce(null);
    await expect(consumeAndroidShare()).resolves.toBeNull();
    const files = Array.from({ length: 12 }, (_, index) => {
      const id = `12345678-1234-4123-8123-${String(index).padStart(12, "0")}`;
      return {
        ...share().files[0]!,
        id,
        url: `/native-share/${id}`,
        size: index ? 0 : 100 * 1024 * 1024,
      };
    });
    consume.mockResolvedValueOnce(share({ files }));
    await expect(consumeAndroidShare()).resolves.toEqual(share({ files }));
  });

  it.each([
    { files: Array(13).fill(share().files[0]) },
    { files: [share().files[0], share().files[0]] },
    { files: [{ ...share().files[0], size: 100 * 1024 * 1024 + 1 }] },
    { files: [{ ...share().files[0], size: -1 }] },
    { files: [{ ...share().files[0], size: 0.5 }] },
    { files: [{ ...share().files[0], id: "not-a-uuid" }] },
    { id: "" },
    { text: 7 },
    { files: null },
    { files: [null] },
  ])("rejects invalid descriptor before any fetch (%j)", async (overrides) => {
    consume.mockResolvedValue({ ...share(), ...overrides });
    const { consumeAndroidShare } = await import("../dashboard/src/lib/android-native");
    await expect(consumeAndroidShare()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it.each([
    `https://example.com/native-share/${FILE_ID}`,
    `http://127.0.0.1:1421/native-share/${FILE_ID}`,
    `http://user:pass@127.0.0.1:1420/native-share/${FILE_ID}`,
    `/api/files/${FILE_ID}`,
    `/native-share/${SHARE_ID}`,
    `/native-share/${FILE_ID}?token=bad`,
    `/native-share/${FILE_ID}#bad`,
  ])("rejects a URL outside the exact share endpoint (%s)", async (url) => {
    consume.mockResolvedValue(share({ files: [{ ...share().files[0]!, url }] }));
    const { consumeAndroidShare } = await import("../dashboard/src/lib/android-native");
    await expect(consumeAndroidShare()).rejects.toThrow("Invalid Android share URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["not-found", "redirect", "size-mismatch"])(
    "does not intake/ack a bad file response (%s)",
    async (failure) => {
      if (failure === "not-found") fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
      else if (failure === "redirect") fetchMock.mockResolvedValue({ ok: true, redirected: true });
      else fetchMock.mockResolvedValue(new Response("unexpected extra bytes"));
      const { getCurrentWebview } = await shell();
      const receiver = vi.fn();
      await getCurrentWebview().onDragDropEvent(receiver);
      await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
      expect(receiver).not.toHaveBeenCalled();
      expect(acknowledge).not.toHaveBeenCalled();
    },
  );
});
