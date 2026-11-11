import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AndroidShare } from "../dashboard/src/lib/android-native";
import type { WebDragDropEvent } from "../dashboard/src/lib/shell-services";

vi.mock("../dashboard/src/lib/runtime-transport", () => ({
  emitRuntimeEvent: vi.fn(),
  getWebWorkspaceChoices: vi.fn(),
  uploadWebFile: vi.fn(),
}));

const KEY = "conversation:share-restart-test";
const PREFIX = "jupiter.image-draft.v1:";
const first: AndroidShare = { id: "share-first", text: "first text", files: [] };
const second: AndroidShare = { id: "share-second", text: "second text", files: [] };
let queue: AndroidShare[];
let acknowledge: ReturnType<typeof vi.fn>;
let consume: ReturnType<typeof vi.fn>;
let discard: ReturnType<typeof vi.fn>;
let notifyOnAck: boolean;
let host: EventTarget;
let delivered: string[];
let statuses: { error: string | null; busy: boolean }[];
let persistChecks: ReturnType<typeof vi.fn>;
const image = {
  kind: "image" as const,
  id: "a".repeat(64),
  name: "shared.png",
  mime: "image/png" as const,
  bytes: 5,
  width: 1,
  height: 1,
};

async function newWebview() {
  vi.resetModules();
  host = new EventTarget();
  host.addEventListener("jupiter:android-share-status", (event) =>
    statuses.push((event as CustomEvent).detail),
  );
  const port: {
    postMessage(message: string): void;
    onmessage?: (event: MessageEvent<string>) => void;
  } = {
    postMessage(message) {
      const request = JSON.parse(message);
      void Promise.resolve()
        .then(async () => {
          if (request.command === "consumeShare") return consume();
          if (request.command === "discardShare") {
            const result = await discard(request.args);
            if (
              result?.discarded === true &&
              (!request.args.id || queue[0]?.id === request.args.id)
            )
              queue.shift();
            return result;
          }
          await acknowledge(request.args.id);
          if (queue[0]?.id === request.args.id) queue.shift();
          if (notifyOnAck) host.dispatchEvent(new Event("jupiter:android-share-ready"));
          return undefined;
        })
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
  Object.assign(host, { location: { origin: "http://127.0.0.1:1420" }, JupiterAndroid: port });
  vi.stubGlobal("window", host);
  vi.stubGlobal("document", {
    querySelector: (selector: string) => ({
      getAttribute: () =>
        selector === 'meta[name="jupiter-platform"]' ? "android" : "restart-run",
    }),
  });
  const store = await import("../desktop/src/ui/image-draft-store");
  const shell = await import("../dashboard/src/lib/shell-services");
  await shell.getCurrentWebview().onDragDropEvent(async ({ payload }: WebDragDropEvent) => {
    if (payload.type !== "drop") return;
    delivered.push(payload.intakeId!);
    store.writeImageDraftIntake(KEY, payload.intakeId!, (draft) => ({
      ...draft,
      text:
        draft.text +
        payload.text +
        (payload.files?.some((file) => file.type === "text/plain")
          ? " @jupiter-file:uploaded"
          : ""),
      attachments: [
        ...(draft.attachments ?? []),
        ...(payload.files?.some((file) => file.type === "image/png") ? [image] : []),
      ],
    }));
    payload.complete?.(() => {
      persistChecks(KEY, payload.intakeId);
      if (!store.imageDraftIntakePersisted(KEY, payload.intakeId!))
        throw new Error("original draft moved");
    });
  });
  return { store, shell };
}

beforeEach(() => {
  localStorage.clear();
  queue = [first];
  delivered = [];
  statuses = [];
  persistChecks = vi.fn();
  acknowledge = vi.fn(async () => undefined);
  consume = vi.fn(async () => queue[0] ?? null);
  discard = vi.fn(async () => ({ discarded: false }));
  notifyOnAck = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("hello")),
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  host?.dispatchEvent(new Event("pagehide"));
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("durable Android share delivery", { retry: 0 }, () => {
  it.each(["failed", "delayed"])(
    "does not reappend after %s ack and a cold WebView restart",
    async (failure) => {
      if (failure === "failed") acknowledge.mockRejectedValueOnce(new Error("ack lost"));
      else acknowledge.mockImplementationOnce(() => new Promise(() => {}));
      await newWebview();
      await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
      expect(JSON.parse(localStorage.getItem(PREFIX + KEY)!).text).toBe("first text");
      host.dispatchEvent(new Event("pagehide"));
      const cold = await newWebview();
      await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2));
      expect(cold.store.readImageDraft(KEY).text).toBe("first text");
      expect(delivered).toEqual([first.id]);
    },
  );

  it.each(["ready", "retry"])(
    "acknowledges the old persisted share then intakes the newly queued share on one %s event",
    async (event) => {
      acknowledge.mockRejectedValueOnce(new Error("ack lost"));
      await newWebview();
      await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
      queue.push(second);
      host.dispatchEvent(new Event(`jupiter:android-share-${event}`));
      await vi.waitFor(() => expect(delivered).toEqual([first.id, second.id]));
      await vi.waitFor(() => expect(queue).toEqual([]));
      expect(JSON.parse(localStorage.getItem(PREFIX + KEY)!).text).toBe("first textsecond text");
    },
  );

  it.each(["image/png", "text/plain"])(
    "does not duplicate or refetch %s after cold restart",
    async (mime) => {
      const id = "12345678-1234-4123-8123-123456789abc";
      queue[0] = {
        ...first,
        files: [{ id, name: "shared", mime, size: 5, url: `/native-share/${id}` }],
      };
      acknowledge.mockRejectedValueOnce(new Error("ack lost"));
      await newWebview();
      await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
      const before = JSON.parse(localStorage.getItem(PREFIX + KEY)!);
      host.dispatchEvent(new Event("pagehide"));
      const cold = await newWebview();
      await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2));
      expect(cold.store.readImageDraft(KEY)).toEqual(before);
      expect(fetch).toHaveBeenCalledOnce();
      expect(delivered).toEqual([first.id]);
    },
  );

  it("drains a share announced while an older acknowledgement is still in flight", async () => {
    let finish!: () => void;
    acknowledge.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await newWebview();
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
    queue.push(second);
    host.dispatchEvent(new Event("jupiter:android-share-ready"));
    finish();
    await vi.waitFor(() => expect(queue).toEqual([]));
    expect(delivered).toEqual([first.id, second.id]);
    expect(acknowledge).toHaveBeenCalledTimes(2);
  });

  it("uses the durable receipt after the original new-tab draft is handed off before ack retry", async () => {
    acknowledge.mockRejectedValueOnce(new Error("ack lost"));
    const warm = await newWebview();
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(warm.store.handoffImageDraft(KEY, "newly-bound-draft")).toBe(true);
    expect(localStorage.getItem(PREFIX + KEY)).toBeNull();
    host.dispatchEvent(new Event("jupiter:android-share-retry"));
    await vi.waitFor(() => expect(queue).toEqual([]));
    expect(delivered).toEqual([first.id]);
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(persistChecks).not.toHaveBeenCalled();
  });

  it("publishes a recoverable failure until explicit UI retry succeeds", async () => {
    acknowledge.mockRejectedValueOnce(new Error("ack lost"));
    await newWebview();
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({ error: "ack lost", busy: false }));
    host.dispatchEvent(new Event("jupiter:android-share-status-request"));
    expect(statuses.at(-1)).toEqual({ error: "ack lost", busy: false });
    expect(queue).toEqual([first]);
    host.dispatchEvent(new Event("jupiter:android-share-retry"));
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({ error: null, busy: false }));
    expect(queue).toEqual([]);
    expect(delivered).toEqual([first.id]);
  });

  it("preserves Native ready events fired during acknowledgement and drains the new head", async () => {
    notifyOnAck = true;
    queue.push(second);
    await newWebview();
    await vi.waitFor(() => expect(queue).toEqual([]));
    expect(delivered).toEqual([first.id, second.id]);
    expect(acknowledge).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(consume).toHaveBeenCalledTimes(3));
  });

  it("discards an unreadable head without an ID only after Native confirmation, then intakes the next share", async () => {
    queue.push(second);
    consume.mockImplementation(async () => {
      if (queue[0]?.id === first.id) throw new Error("URI grant was lost");
      return queue[0] ?? null;
    });
    discard.mockResolvedValue({ discarded: true });
    await newWebview();
    await vi.waitFor(() => expect(statuses.at(-1)?.error).toBe("URI grant was lost"));
    expect(acknowledge).not.toHaveBeenCalled();
    host.dispatchEvent(new Event("jupiter:android-share-discard"));
    await vi.waitFor(() => expect(queue).toEqual([]));
    expect(discard).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledWith({});
    expect(delivered).toEqual([second.id]);
    expect(JSON.parse(localStorage.getItem(PREFIX + KEY)!).text).toBe("second text");
  });

  it("clears only the matching failed JS intake after confirmed discard and does not retry its fetch", async () => {
    const id = "12345678-1234-4123-8123-123456789abc";
    queue[0] = {
      ...first,
      files: [{ id, name: "lost", mime: "text/plain", size: 5, url: `/native-share/${id}` }],
    };
    queue.push(second);
    vi.mocked(fetch).mockRejectedValueOnce(new Error("lost staged copy"));
    discard.mockResolvedValue({ discarded: true });
    await newWebview();
    await vi.waitFor(() => expect(statuses.at(-1)?.error).toBe("lost staged copy"));
    host.dispatchEvent(new Event("jupiter:android-share-discard"));
    await vi.waitFor(() => expect(queue).toEqual([]));
    expect(discard).toHaveBeenCalledWith({ id: first.id });
    expect(fetch).toHaveBeenCalledOnce();
    expect(delivered).toEqual([second.id]);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith(second.id);
  });

  it("does not remove an already committed draft or receipt when discarding only the Native copy", async () => {
    acknowledge.mockRejectedValueOnce(new Error("ack lost"));
    discard.mockResolvedValue({ discarded: true });
    await newWebview();
    await vi.waitFor(() => expect(statuses.at(-1)?.error).toBe("ack lost"));
    const before = localStorage.getItem(PREFIX + KEY);
    host.dispatchEvent(new Event("jupiter:android-share-discard"));
    await vi.waitFor(() => expect(queue).toEqual([]));
    expect(localStorage.getItem(PREFIX + KEY)).toBe(before);
    expect(delivered).toEqual([first.id]);
    expect(discard).toHaveBeenCalledWith({ id: first.id });
  });

  it.each(["cancelled", "invalid-result", "failed"])(
    "keeps the head and JS pending on %s discard without another consume",
    async (outcome) => {
      acknowledge.mockRejectedValueOnce(new Error("ack lost"));
      if (outcome === "invalid-result") discard.mockResolvedValue({ discarded: "true" });
      if (outcome === "failed") discard.mockRejectedValue(new Error("Native confirmation failed"));
      await newWebview();
      await vi.waitFor(() => expect(statuses.at(-1)?.error).toBe("ack lost"));
      const before = localStorage.getItem(PREFIX + KEY);
      host.dispatchEvent(new Event("jupiter:android-share-discard"));
      await vi.waitFor(() => expect(discard).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(statuses.at(-1)?.busy).toBe(false));
      expect(queue).toEqual([first]);
      expect(consume).toHaveBeenCalledOnce();
      expect(acknowledge).toHaveBeenCalledOnce();
      expect(localStorage.getItem(PREFIX + KEY)).toBe(before);
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(consume).toHaveBeenCalledOnce();
      vi.useRealTimers();
      host.dispatchEvent(new Event("jupiter:android-share-retry"));
      await vi.waitFor(() => expect(queue).toEqual([]));
      expect(delivered).toEqual([first.id]);
    },
  );

  it("serializes Native discard confirmation and preserves pending until it confirms", async () => {
    acknowledge.mockRejectedValueOnce(new Error("ack lost"));
    let confirm!: (result: { discarded: boolean }) => void;
    discard.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    await newWebview();
    await vi.waitFor(() => expect(statuses.at(-1)?.error).toBe("ack lost"));
    host.dispatchEvent(new Event("jupiter:android-share-discard"));
    await vi.waitFor(() => expect(discard).toHaveBeenCalledOnce());
    host.dispatchEvent(new Event("jupiter:android-share-discard"));
    host.dispatchEvent(new Event("jupiter:android-share-retry"));
    expect(statuses.at(-1)?.busy).toBe(true);
    expect(queue).toEqual([first]);
    expect(discard).toHaveBeenCalledOnce();
    expect(consume).toHaveBeenCalledOnce();
    confirm({ discarded: false });
    await vi.waitFor(() => expect(statuses.at(-1)?.busy).toBe(false));
    expect(queue).toEqual([first]);
    expect(consume).toHaveBeenCalledOnce();
  });
});
