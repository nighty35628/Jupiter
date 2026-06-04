import { describe, expect, it } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";

function makeLoop(): CacheFirstLoop {
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetch: (async () => new Response("{}")) as typeof fetch,
  });
  return new CacheFirstLoop({
    client,
    prefix: new ImmutablePrefix({ system: "s" }),
    stream: false,
  });
}

describe("CacheFirstLoop rollbackToTurn", () => {
  it("preserves the selected user turn and drops everything after it", () => {
    const loop = makeLoop();
    loop.log.append({ role: "user", content: "u1" });
    loop.log.append({ role: "assistant", content: "a1" });
    loop.log.append({ role: "user", content: "u2" });
    loop.log.append({ role: "assistant", content: "a2" });

    expect(loop.rollbackToTurn({ turn: 1, role: "user" })).toBe(true);

    expect(loop.log.toFullHistory()).toEqual([{ role: "user", content: "u1" }]);
    expect(loop.currentTurn).toBe(1);
  });

  it("preserves the full selected assistant turn", () => {
    const loop = makeLoop();
    loop.log.append({ role: "user", content: "u1" });
    loop.log.append({ role: "assistant", content: "a1" });
    loop.log.append({ role: "user", content: "u2" });
    loop.log.append({ role: "assistant", content: "a2" });

    expect(loop.rollbackToTurn({ turn: 1, role: "assistant" })).toBe(true);

    expect(loop.log.toFullHistory()).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ]);
    expect(loop.currentTurn).toBe(1);
  });

  it("drops the latest user prompt and response when rewinding the latest turn", () => {
    const loop = makeLoop();
    loop.log.append({ role: "user", content: "u1" });
    loop.log.append({ role: "assistant", content: "a1" });
    loop.log.append({ role: "user", content: "u2" });
    loop.log.append({ role: "assistant", content: "a2" });

    expect(loop.rollbackLatestTurn()).toBe(true);

    expect(loop.log.toFullHistory()).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ]);
    expect(loop.currentTurn).toBe(1);
  });

  it("drops a pending latest user prompt even before a response exists", () => {
    const loop = makeLoop();
    loop.log.append({ role: "user", content: "u1" });
    loop.log.append({ role: "assistant", content: "a1" });
    loop.log.append({ role: "user", content: "u2" });

    expect(loop.rollbackLatestTurn()).toBe(true);

    expect(loop.log.toFullHistory()).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ]);
    expect(loop.currentTurn).toBe(1);
  });

  it("returns false when there is nothing after the selected turn", () => {
    const loop = makeLoop();
    loop.log.append({ role: "user", content: "u1" });

    expect(loop.rollbackToTurn({ turn: 1, role: "user" })).toBe(false);
  });
});
