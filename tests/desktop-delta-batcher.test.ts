import { describe, expect, it } from "vitest";
import {
  OrderedDeltaBatcher,
  type OrderedWireEvent,
} from "../src/desktop/ordered-delta-batcher.js";

describe("OrderedDeltaBatcher", () => {
  it(
    "keeps the latest same-request metadata while concatenating text and batch counts",
    { retry: 0 },
    () => {
      const written: OrderedWireEvent[] = [];
      const batcher = new OrderedDeltaBatcher((event) => written.push(event));
      const base = {
        type: "model.delta",
        tabId: "t1",
        turn: 2,
        channel: "content",
        requestId: "r1",
      };
      const first = {
        ...base,
        id: 1,
        ts: "first",
        text: "ab",
        outputChars: 2,
        reasoningChars: 3,
        toolArgsChars: 4,
        batchCount: 2,
        oldOnly: true,
      };
      const latest = {
        ...base,
        id: 5,
        ts: "latest",
        text: "cde",
        outputChars: 5,
        reasoningChars: 6,
        toolArgsChars: 7,
        batchCount: 3,
      };

      batcher.push(first);
      batcher.push(latest);
      batcher.flush();

      expect(written).toEqual([{ ...latest, text: "abcde", batchCount: 5 }]);
      expect(first.text).toBe("ab");
      expect(latest.text).toBe("cde");
    },
  );

  it.each([
    ["r1", "r2"],
    [undefined, "r2"],
    ["r1", undefined],
  ])("does not merge different request identities (%s, %s)", { retry: 0 }, (left, right) => {
    const written: OrderedWireEvent[] = [];
    const batcher = new OrderedDeltaBatcher((event) => written.push(event));
    const base = { type: "model.delta", tabId: "t1", turn: 1, channel: "content" };
    const first = { ...base, requestId: left, text: "first", outputChars: 5 };
    const second = { ...base, requestId: right, text: "second", outputChars: 6 };

    batcher.push(first);
    batcher.push(second);
    batcher.flush();

    expect(written).toEqual([first, second]);
  });

  it("coalesces adjacent deltas from the same tab, turn, and channel", () => {
    const written: OrderedWireEvent[] = [];
    let scheduled: (() => void) | undefined;
    const batcher = new OrderedDeltaBatcher((event) => written.push(event), {
      schedule: (callback) => {
        scheduled = callback;
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      cancel: () => {},
    });

    batcher.push({ type: "model.delta", tabId: "t1", turn: 2, channel: "content", text: "a" });
    batcher.push({ type: "model.delta", tabId: "t1", turn: 2, channel: "content", text: "b" });
    scheduled?.();

    expect(written).toEqual([
      {
        type: "model.delta",
        tabId: "t1",
        turn: 2,
        channel: "content",
        text: "ab",
        batchCount: 2,
      },
    ]);
  });

  it("flushes before every lifecycle barrier", () => {
    const written: OrderedWireEvent[] = [];
    const batcher = new OrderedDeltaBatcher((event) => written.push(event));

    batcher.push({ type: "model.delta", tabId: "t1", turn: 1, channel: "reasoning", text: "r" });
    batcher.push({ type: "tool.intent", tabId: "t1", turn: 1, callId: "c1" });
    batcher.push({ type: "model.delta", tabId: "t1", turn: 1, channel: "content", text: "c" });
    batcher.push({ type: "model.final", tabId: "t1", turn: 1, content: "c" });

    expect(written.map((event) => event.type)).toEqual([
      "model.delta",
      "tool.intent",
      "model.delta",
      "model.final",
    ]);
  });

  it("does not merge deltas across tabs or channels", () => {
    const written: OrderedWireEvent[] = [];
    const batcher = new OrderedDeltaBatcher((event) => written.push(event));

    batcher.push({ type: "model.delta", tabId: "a", turn: 1, channel: "content", text: "1" });
    batcher.push({ type: "model.delta", tabId: "b", turn: 1, channel: "content", text: "2" });
    batcher.push({ type: "model.delta", tabId: "b", turn: 1, channel: "reasoning", text: "3" });
    batcher.flush();

    expect(written.map((event) => event.text)).toEqual(["1", "2", "3"]);
  });
});
