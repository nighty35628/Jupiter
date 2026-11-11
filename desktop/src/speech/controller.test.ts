// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { DictationController, type SpeechHost, type SpeechEvent } from "./controller";

function fixture() {
  let text = "before after", revision = 0, active = true, composing = false;
  let receive: (event: SpeechEvent) => void = () => {};
  const host: SpeechHost = {
    listen: async callback => { receive = callback; return () => {}; },
    start: vi.fn(async () => {}), finish: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
  };
  const controller = new DictationController(host, {
    current: () => active,
    revision: () => revision,
    composing: () => composing,
    insert: (value, start, end, expected) => {
      if (!active || composing || revision !== expected) return false;
      text = text.slice(0, start) + value + text.slice(end);
      revision++;
      return true;
    },
  });
  return {
    controller, host, text: () => text,
    emit: (state: SpeechEvent["state"], value?: string, id = controller.sessionId) =>
      receive({ sessionId: id!, state, text: value }),
    edit(value: string) { text = value; revision++; },
    deactivate() { active = false; controller.cancel(); },
    compose(value: boolean) { composing = value; },
  };
}

describe("dictation draft ownership", { retry: 0 }, () => {
  it("inserts once at the captured selection without sending", async () => {
    const f = fixture();
    await f.controller.start("en", "local", 7, 7);
    const id = f.controller.sessionId;
    f.emit("result", "spoken ", id);
    f.emit("result", "duplicate", id);
    expect(f.text()).toBe("before spoken after");
    expect(f.controller.snapshot().candidate).toBe("");
  });
  it("detects an edited-then-restored draft and offers a candidate", async () => {
    const f = fixture();
    await f.controller.start("zh", "local", 0, 0);
    f.edit("changed"); f.edit("before after");
    f.emit("result", "hello");
    expect(f.text()).toBe("before after");
    expect(f.controller.snapshot().candidate).toBe("hello");
    f.controller.insertCandidate(0, 0);
    expect(f.text()).toBe("hellobefore after");
  });
  it("does not insert while IME composition is active", async () => {
    const f = fixture();
    await f.controller.start("ja", "local", 0, 0);
    f.compose(true); f.emit("result", "日本語");
    f.controller.insertCandidate(0, 0);
    expect(f.text()).toBe("before after");
    f.compose(false); f.controller.insertCandidate(0, 0);
    expect(f.text()).toBe("日本語before after");
  });
  it("rejects late results after cancellation and during the next recording", async () => {
    const f = fixture();
    await f.controller.start("en", "local", 0, 0);
    const old = f.controller.sessionId!;
    f.controller.cancel();
    await f.controller.start("fr", "local", 0, 0);
    f.emit("result", "old", old);
    expect(f.text()).toBe("before after");
    f.emit("result", "bonjour");
    expect(f.text()).toBe("bonjourbefore after");
  });
  it("does not insert after tab deactivation/send invalidation", async () => {
    const f = fixture();
    await f.controller.start("en", "local", 0, 0);
    const old = f.controller.sessionId!;
    f.deactivate(); f.emit("result", "late", old);
    expect(f.text()).toBe("before after");
    expect(f.controller.snapshot().candidate).toBe("");
  });
  it("ignores errors from an old finish request", async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.host.finish = () => new Promise((_, fail) => { reject = fail; });
    await f.controller.start("en", "local", 0, 0);
    f.emit("recording");
    const finishing = f.controller.finish();
    f.controller.cancel();
    await f.controller.start("de", "local", 0, 0);
    reject(new Error("old failure")); await finishing;
    expect(f.controller.snapshot().error).toBe("");
    expect(f.controller.sessionId).toBeDefined();
  });
});
