import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import {
  listSessions,
  loadSessionMessages,
  renameSession,
  sessionPath,
} from "../src/memory/session.js";

function summaryResponse(content = "Facts digest: compact summary."): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function deferredSummaryFetch(): {
  fetch: typeof fetch;
  started: Promise<void>;
  release: () => void;
} {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    fetch: vi.fn(async () => {
      markStarted();
      await gate;
      return summaryResponse();
    }) as unknown as typeof fetch,
    started,
    release,
  };
}

function makeLoop(session: string, fetch: typeof globalThis.fetch): CacheFirstLoop {
  return new CacheFirstLoop({
    client: new DeepSeekClient({ apiKey: "sk-test", fetch }),
    prefix: new ImmutablePrefix({ system: "You are a test coding agent." }),
    model: "deepseek-v4-flash",
    stream: false,
    session,
  });
}

function seedPersistedTurns(loop: CacheFirstLoop, count = 8): void {
  for (let i = 0; i < count; i++) {
    loop.appendAndPersist({
      role: "user",
      content: `q${i}: ${"context padding to weigh the turn ".repeat(8)}`,
    });
    loop.appendAndPersist({
      role: "assistant",
      content: `a${i}: ${"reply padding to weigh the turn ".repeat(8)}`,
    });
  }
}

describe("session rebinding during compaction", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jupiter-session-rebind-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it("commits an in-flight fold to the renamed path without resurrecting the old session", async () => {
    const oldName = "desktop-20260807010101000-1-1";
    const newName = "first-user-sentence";
    const deferred = deferredSummaryFetch();
    const loop = makeLoop(oldName, deferred.fetch);
    seedPersistedTurns(loop);

    const fold = loop.compactHistory({ keepRecentTokens: 40 });
    await deferred.started;
    const beforeFold = readFileSync(sessionPath(oldName), "utf8");
    expect(renameSession(oldName, newName)).toBe(true);
    loop.rebindSession(newName);
    deferred.release();

    const result = await fold;

    expect(result.folded).toBe(true);
    expect(existsSync(sessionPath(oldName))).toBe(false);
    expect(existsSync(sessionPath(newName))).toBe(true);
    expect(readFileSync(`${sessionPath(newName)}.bak`, "utf8")).toBe(beforeFold);
    expect(listSessions().map((session) => session.name)).toEqual([newName]);
  });

  it("does not overwrite a message appended while the fold summary is in flight", async () => {
    const name = "desktop-20260807020202000-1-1";
    const deferred = deferredSummaryFetch();
    const loop = makeLoop(name, deferred.fetch);
    seedPersistedTurns(loop);

    const fold = loop.compactHistory({ keepRecentTokens: 40 });
    await deferred.started;
    loop.appendAndPersist({ role: "user", content: "message appended during fold" });
    const expectedFile = readFileSync(sessionPath(name), "utf8");
    deferred.release();

    const result = await fold;

    expect(result).toMatchObject({ folded: false, reason: "log-changed" });
    expect(readFileSync(sessionPath(name), "utf8")).toBe(expectedFile);
    expect(loadSessionMessages(name).at(-1)?.content).toBe("message appended during fold");
    expect(existsSync(`${sessionPath(name)}.bak`)).toBe(false);
  });

  it("does not commit an old fold after switching to a different logical session", async () => {
    const oldName = "desktop-20260807030303000-1-1";
    const newName = "desktop-20260807040404000-2-1";
    const deferred = deferredSummaryFetch();
    const loop = makeLoop(oldName, deferred.fetch);
    seedPersistedTurns(loop);
    const oldFile = readFileSync(sessionPath(oldName), "utf8");

    const fold = loop.compactHistory({ keepRecentTokens: 40 });
    await deferred.started;
    loop.rebindSession(newName, { logicalSessionChanged: true });
    deferred.release();

    const result = await fold;

    expect(result).toMatchObject({ folded: false, reason: "session-changed" });
    expect(readFileSync(sessionPath(oldName), "utf8")).toBe(oldFile);
    expect(existsSync(sessionPath(newName))).toBe(false);
  });
});
