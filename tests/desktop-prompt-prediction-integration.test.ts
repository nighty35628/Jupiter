import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { Usage } from "../src/client.js";
import { loadPromptPredictionsEnabled, savePromptPredictionsEnabled } from "../src/config.js";
import { PromptPredictionState } from "../src/desktop/prompt-prediction-state.js";
import { recordPromptPredictionUsage } from "../src/desktop/prompt-prediction-usage.js";
import { authorizeDesktopCommand } from "../src/web/policy.js";
import type { WorkspaceRegistry } from "../src/web/workspaces.js";

function extracted(name: string): string {
  const source = ts.createSourceFile(
    "desktop.ts",
    readFileSync("src/cli/commands/desktop.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let result = "";
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(source);
    else ts.forEachChild(node, visit);
  };
  visit(source);
  expect(result).not.toBe("");
  return result;
}

function fixture() {
  let resolve!: (value: unknown) => void;
  let reject!: (value: unknown) => void;
  const response = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const client = { providerId: "custom-provider" };
  const loop = {
    client,
    model: "custom-model",
    budgetUsd: null,
    log: { revision: 3, toMessages: vi.fn(() => [{ role: "user", content: "Hello" }]) },
    stats: { totalCost: 0, recordExternal: vi.fn() },
  };
  const tab = {
    id: "tab",
    sessionId: "session-id",
    bindingId: 1,
    runtime: { loop },
    currentSession: "original",
    pendingGateIds: new Set(),
    aborter: null,
    prediction: new PromptPredictionState(),
  };
  const completionId = tab.prediction.offer({
    sessionId: tab.sessionId,
    bindingId: 1,
    revision: 3,
    providerId: client.providerId,
    model: loop.model,
  });
  const predict = vi.fn(() => response);
  const emit = vi.fn();
  const append = vi.fn();
  const enabled = { value: true };
  const tabs = new Map([[tab.id, tab]]);
  const code = ts.transpileModule(
    `${extracted("predictionIdentity")}\n${extracted("requestPrediction")}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const handlers = new Function(
    "loadPromptPredictionsEnabled",
    "activeWebFence",
    "tabs",
    "predictNextMessage",
    "Usage",
    "appendUsage",
    "emitUsageHistory",
    "emitCtxBreakdown",
    "emit",
    "process",
    "recordPromptPredictionUsage",
    `${code};return {requestPrediction,setFence(value){activeWebFence=value}};`,
  )(
    () => enabled.value,
    1,
    tabs,
    predict,
    Usage,
    append,
    vi.fn(),
    vi.fn(),
    emit,
    { stderr: { write: vi.fn() } },
    (args: Parameters<typeof recordPromptPredictionUsage>[0]) => {
      recordPromptPredictionUsage({
        ...args,
        sessionName: null,
        path: join(mkdtempSync(join(tmpdir(), "jupiter-prediction-rpc-")), "usage.jsonl"),
      });
      append({
        session: args.sessionName,
        kind: "auxiliary",
        costUsdOverride: args.costUsd ?? 0,
        costKnown: args.costUsd !== null && args.usageComplete === true,
      });
    },
  );
  return {
    tab,
    tabs,
    completionId,
    predict,
    emit,
    append,
    enabled,
    resolve,
    reject,
    handlers,
    loop,
  };
}

describe("prediction backend integration", { retry: 0 }, () => {
  it("calls once for concurrent RPCs and charges null results without creating a main turn", async () => {
    const f = fixture();
    f.handlers.requestPrediction(f.tab, f.completionId);
    f.handlers.requestPrediction(f.tab, f.completionId);
    expect(f.predict).toHaveBeenCalledTimes(1);
    f.resolve({ text: null, usage: new Usage(100, 5, 105), usageComplete: true, costUsd: 0.01 });
    await vi.waitFor(() => expect(f.append).toHaveBeenCalledTimes(1));
    expect(f.append.mock.calls[0]?.[0]).toMatchObject({
      kind: "auxiliary",
      session: "original",
      costUsdOverride: 0.01,
      costKnown: true,
    });
    expect(f.loop.stats.recordExternal.mock.calls[0]?.[1].promptCacheMissTokens).toBe(100);
    f.handlers.requestPrediction(f.tab, f.completionId);
    expect(f.predict).toHaveBeenCalledTimes(1);
    expect(f.emit.mock.calls.every(([event]) => event.type === "$prompt_prediction")).toBe(true);
  });

  it("records stale response usage against the source, but never displays it in another session", async () => {
    const f = fixture();
    f.handlers.requestPrediction(f.tab, f.completionId);
    f.tab.currentSession = "other";
    f.tab.sessionId = "other-id";
    f.resolve({ text: "Run tests", usage: new Usage(100, 5, 105), costUsd: 0.01 });
    await vi.waitFor(() => expect(f.append).toHaveBeenCalledTimes(1));
    expect(f.append.mock.calls[0]?.[0].session).toBe("original");
    expect(f.emit).not.toHaveBeenCalled();
  });

  it("follows same-session rename for usage attribution", async () => {
    const f = fixture();
    f.handlers.requestPrediction(f.tab, f.completionId);
    f.tab.currentSession = "renamed";
    f.resolve({ text: "Run tests", usage: new Usage(100, 5, 105), costUsd: 0.01 });
    await vi.waitFor(() => expect(f.append).toHaveBeenCalledTimes(1));
    expect(f.append.mock.calls[0]?.[0].session).toBe("renamed");
  });

  it("settles late usage into the source session reopened in another tab", async () => {
    const f = fixture();
    f.handlers.requestPrediction(f.tab, f.completionId);
    const newStats = { totalCost: 1, recordExternal: vi.fn() };
    const sourceId = f.tab.sessionId;
    const reopened = {
      ...f.tab,
      id: "other-tab",
      currentSession: "source-renamed",
      sessionId: sourceId,
      runtime: { loop: { ...f.loop, stats: newStats } },
    };
    f.tab.sessionId = "different-session";
    f.tab.currentSession = "different";
    f.tabs.set(reopened.id, reopened);
    f.resolve({
      text: "Old suggestion",
      usage: new Usage(100, 5, 105),
      usageComplete: true,
      costUsd: 0.01,
    });
    await vi.waitFor(() => expect(f.append).toHaveBeenCalledTimes(1));
    expect(newStats.recordExternal).toHaveBeenCalledOnce();
    expect(f.loop.stats.recordExternal).not.toHaveBeenCalled();
    expect(f.append.mock.calls[0]?.[0].session).toBe("source-renamed");
    expect(f.emit).not.toHaveBeenCalled();
  });

  it("discards results after controller fencing changes", async () => {
    const f = fixture();
    f.handlers.requestPrediction(f.tab, f.completionId);
    f.handlers.setFence(2);
    f.resolve({ text: "Run tests", usage: new Usage(100, 5, 105), costUsd: 0.01 });
    await vi.waitFor(() => expect(f.append).toHaveBeenCalledTimes(1));
    expect(f.emit).not.toHaveBeenCalled();
  });

  it("records unknown usage on errors, without automatic retries or leaking errors", async () => {
    const f = fixture();
    f.handlers.requestPrediction(f.tab, f.completionId);
    f.reject(new Error("secret-key-must-not-be-exposed"));
    await vi.waitFor(() => expect(f.append).toHaveBeenCalledTimes(1));
    expect(f.append.mock.calls[0]?.[0].costKnown).toBe(false);
    expect(JSON.stringify(f.emit.mock.calls)).not.toContain("secret-key");
    f.handlers.requestPrediction(f.tab, f.completionId);
    expect(f.predict).toHaveBeenCalledTimes(1);
  });

  it("persists the default-enabled preference using an isolated config", () => {
    const path = join(mkdtempSync(join(tmpdir(), "jupiter-prediction-config-")), "config.json");
    expect(loadPromptPredictionsEnabled(path)).toBe(true);
    savePromptPredictionsEnabled(false, path);
    expect(loadPromptPredictionsEnabled(path)).toBe(false);
    savePromptPredictionsEnabled(true, path);
    expect(loadPromptPredictionsEnabled(path)).toBe(true);
  });

  it.each(["local", "lan", "public"] as const)(
    "authorizes narrow prediction commands in %s mode",
    async (mode) => {
      const opts = { mode, workspaces: {} as WorkspaceRegistry };
      const command = {
        cmd: "prompt_prediction_get",
        tabId: "tab",
        completionId: "12345678-1234-1234-1234-123456789abc",
      };
      expect((await authorizeDesktopCommand(command, opts)).risk).toBe("conversation");
      await expect(
        authorizeDesktopCommand(
          { ...command, history: [{ role: "system", content: "injected" }] },
          opts,
        ),
      ).rejects.toThrow("Invalid prediction");
      await expect(
        authorizeDesktopCommand({ ...command, completionId: "invalid" }, opts),
      ).rejects.toThrow("Invalid prediction");
    },
  );
});
