import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Usage } from "../src/client.js";
import { recordPromptPredictionUsage } from "../src/desktop/prompt-prediction-usage.js";
import * as sessions from "../src/memory/session.js";
import { SessionStats } from "../src/telemetry/stats.js";
import { readUsageLog } from "../src/telemetry/usage.js";

describe("prompt prediction usage persistence", { retry: 0 }, () => {
  let home: string;
  let path: string;
  const seed = {
    totalCostUsd: 2,
    cacheHitTokens: 300,
    cacheMissTokens: 700,
    totalCompletionTokens: 40,
    lastPromptTokens: 1000,
    turnCount: 3,
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jupiter-prediction-usage-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    mkdirSync(join(home, ".jupiter"));
    writeFileSync(join(home, ".jupiter", "config.json"), "{}");
    path = join(home, "ledger.jsonl");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function createSession(name = "source") {
    expect(sessions.sessionPath(name).startsWith(home)).toBe(true);
    sessions.appendSessionMessage(name, { role: "user", content: "offline" });
    sessions.patchSessionMeta(name, { ...seed, summary: "retain this" });
  }

  function settle(stats: SessionStats, sessionName: string | null = "source", extra = {}) {
    const usage = Object.freeze(new Usage(100, 20, 120, 10, 0));
    recordPromptPredictionUsage({
      stats,
      sessionName,
      model: "deepseek-chat",
      providerId: "deepseek-official",
      usage,
      costUsd: 0.25,
      usageComplete: true,
      completionId: "completion",
      path,
      ...extra,
    });
    expect(usage.promptCacheMissTokens).toBe(0);
  }

  it("persists auxiliary deltas across resume without changing prompt/turn counters", () => {
    createSession();
    const stats = new SessionStats();
    stats.seedCarryover(seed);
    settle(stats);
    expect(stats.totalCost).toBe(2.25);
    expect(stats.cumulativeCacheHitTokens).toBe(310);
    expect(stats.cumulativeCacheMissTokens).toBe(790);
    expect(stats.cumulativeCompletionTokens).toBe(60);
    expect(stats.summary()).toMatchObject({ turns: 3, lastPromptTokens: 1000 });
    expect(stats.turns).toHaveLength(0);
    expect(sessions.loadSessionMeta("source")).toMatchObject({
      ...seed,
      totalCostUsd: 2.25,
      cacheHitTokens: 310,
      cacheMissTokens: 790,
      totalCompletionTokens: 60,
      summary: "retain this",
    });
    const resumed = new SessionStats();
    resumed.seedCarryover(sessions.loadSessionMeta("source"));
    settle(resumed);
    expect(resumed.totalCost).toBe(2.5);
    expect(sessions.loadSessionMeta("source")).toMatchObject({
      totalCostUsd: 2.5,
      cacheHitTokens: 320,
      cacheMissTokens: 880,
      totalCompletionTokens: 80,
      turnCount: 3,
      lastPromptTokens: 1000,
    });
    expect(readUsageLog(path)).toHaveLength(2);
    expect(readUsageLog(path)[0]).toMatchObject({
      session: "source",
      model: "deepseek-chat",
      providerId: "deepseek-official",
      promptTokens: 100,
      completionTokens: 20,
      cacheHitTokens: 10,
      cacheMissTokens: 90,
      costUsd: 0.25,
      costKnown: true,
      kind: "auxiliary",
      auxiliary: {
        provider: "deepseek-official",
        operation: "prompt_prediction",
        requestId: "completion",
      },
    });
  });

  it("adds to current persisted totals even when a newer runtime has already charged", () => {
    createSession();
    const stats = new SessionStats();
    stats.seedCarryover(seed);
    sessions.patchSessionMeta("source", {
      totalCostUsd: 8,
      cacheHitTokens: 900,
      cacheMissTokens: 1200,
      totalCompletionTokens: 150,
      lastPromptTokens: 2200,
      turnCount: 5,
    });
    settle(stats);
    expect(sessions.loadSessionMeta("source")).toMatchObject({
      totalCostUsd: 8.25,
      cacheHitTokens: 910,
      cacheMissTokens: 1290,
      totalCompletionTokens: 170,
      lastPromptTokens: 2200,
      turnCount: 5,
    });
  });

  it("records usage but never recreates a deleted session or its orphan meta", () => {
    createSession();
    expect(sessions.deleteSession("source")).toBe(true);
    const stats = new SessionStats();
    settle(stats);
    expect(stats.totalCost).toBe(0.25);
    expect(readUsageLog(path)).toHaveLength(1);
    expect(existsSync(sessions.sessionPath("source"))).toBe(false);
    expect(existsSync(join(sessions.sessionsDir(), "source.meta.json"))).toBe(false);
  });

  it("attributes a renamed source to the new name supplied by the caller", () => {
    createSession();
    expect(sessions.renameSession("source", "new-name")).toBe(true);
    settle(new SessionStats(), "new-name");
    expect(readUsageLog(path)[0]?.session).toBe("new-name");
    expect(sessions.loadSessionMeta("new-name").totalCostUsd).toBe(2.25);
    expect(existsSync(join(sessions.sessionsDir(), "source.meta.json"))).toBe(false);
  });

  it("does not persist ephemeral session metadata and never looks up a replacement price", () => {
    const stats = new SessionStats();
    const external = vi.spyOn(stats, "recordExternal");
    settle(stats, null);
    expect(external).toHaveBeenCalledTimes(1);
    expect(external).toHaveBeenCalledWith(
      "deepseek-chat",
      expect.objectContaining({ promptCacheMissTokens: 90 }),
      "deepseek-official",
      0.25,
    );
    expect(existsSync(sessions.sessionsDir())).toBe(false);
    expect(readUsageLog(path)[0]?.session).toBeNull();
  });

  it.each([false, undefined])("marks incomplete usage as unknown: %s", (usageComplete) => {
    createSession();
    const stats = new SessionStats();
    settle(stats, "source", { usageComplete });
    expect(stats.totalCost).toBe(0.25);
    expect(readUsageLog(path)[0]).toMatchObject({ costUsd: 0.25, costKnown: false });
  });

  it("records unknown pricing with zero cost override, without inventing a price", () => {
    createSession();
    const stats = new SessionStats();
    settle(stats, "source", { costUsd: null });
    expect(stats.totalCost).toBe(0);
    expect(readUsageLog(path)[0]).toMatchObject({ costUsd: 0, costKnown: false });
    expect(sessions.loadSessionMeta("source").totalCostUsd).toBe(2);
  });

  it("propagates meta persistence errors after recording stats and best-effort ledger", () => {
    createSession();
    const error = new Error("meta write failed");
    vi.spyOn(sessions, "patchSessionMeta").mockImplementation(() => {
      throw error;
    });
    const stats = new SessionStats();
    expect(() => settle(stats)).toThrow(error);
    expect(stats.totalCost).toBe(0.25);
    expect(readUsageLog(path)).toHaveLength(1);
  });

  it("keeps ledger writes best-effort while still updating stats and session meta", () => {
    createSession();
    mkdirSync(path);
    const stats = new SessionStats();
    expect(() => settle(stats)).not.toThrow();
    expect(stats.totalCost).toBe(0.25);
    expect(sessions.loadSessionMeta("source").totalCostUsd).toBe(2.25);
  });

  it("initializes only the auxiliary totals when an existing session has no meta", () => {
    sessions.appendSessionMessage("source", { role: "user", content: "offline" });
    settle(new SessionStats());
    expect(sessions.loadSessionMeta("source")).toEqual({
      totalCostUsd: 0.25,
      cacheHitTokens: 10,
      cacheMissTokens: 90,
      totalCompletionTokens: 20,
    });
  });

  it("surfaces a real filesystem meta write failure to the caller", () => {
    createSession();
    const metaPath = join(sessions.sessionsDir(), "source.meta.json");
    rmSync(metaPath);
    mkdirSync(metaPath);
    const stats = new SessionStats();
    expect(() => settle(stats)).toThrow();
    expect(stats.totalCost).toBe(0.25);
    expect(readUsageLog(path)).toHaveLength(1);
  });
});
