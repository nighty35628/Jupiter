import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionMessages, rewriteSession, sessionPath } from "../src/memory/session.js";
import { SharedSessionCoordinator } from "../src/memory/shared-session.js";

const fixture = vi.hoisted(() => ({ home: undefined as string | undefined }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => {
      if (!fixture.home) throw new Error("Compaction fixture HOME is not initialized");
      return fixture.home;
    },
  };
});

describe("cross-turn compaction regression", { retry: 0 }, () => {
  let home: string;
  let owner: SharedSessionCoordinator;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jupiter-fold-baseline-"));
    fixture.home = home;
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    expect(sessionPath("chat")).toBe(join(home, ".jupiter", "sessions", "chat.jsonl"));
    rewriteSession("chat", [{ role: "user", content: "original" }]);
    owner = new SharedSessionCoordinator("chat", "identity");
  });
  afterEach(() => {
    owner.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    fixture.home = undefined;
  });
  it("keeps the raw original but reuses the accepted semantic recap next turn", () => {
    const a = owner.beginTurn("a");
    a.beginRules?.("rules");
    const before = a.loadMessages();
    const summary = { role: "assistant" as const, content: "recap" };
    a.rewriteMessages([summary], "context");
    a.recordFold?.({ before, head: before, summary });
    a.appendMessage({ role: "user", content: "next" });
    owner.commit(a);
    const b = owner.beginTurn("b");
    b.beginRules?.("rules");
    expect(loadSessionMessages("chat")[0]?.content).toBe("original");
    expect(b.loadMessages()[0]?.content).toBe("recap");
  });
});
