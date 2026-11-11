import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { redactSemanticEmbeddingConfig } from "../src/config.js";
import { classifyDesktopNaturalCommandIntent } from "../src/desktop/natural-command-intent.js";
import {
  createProviderVersionTracker,
  probeDesktopProvider,
  saveDesktopProvider,
  summarizeSettingsSave,
} from "../src/desktop/provider-settings.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";

const source = readFileSync("src/cli/commands/desktop.ts", "utf8");
const ast = ts.createSourceFile("desktop.ts", source, ts.ScriptTarget.Latest, true);

function declaration(name: string): string {
  let node: ts.FunctionDeclaration | undefined;
  function visit(item: ts.Node) {
    if (ts.isFunctionDeclaration(item) && item.name?.text === name) node = item;
    else ts.forEachChild(item, visit);
  }
  visit(ast);
  expect(node, `missing function ${name}`).toBeDefined();
  return node!.getText(ast).replace(/^export /, "");
}

function compile(code: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}

function rpc(cmd: string, bindings: Record<string, unknown>) {
  let branch: ts.IfStatement | undefined;
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(ast) === `msg.cmd === "${cmd}"`)
      branch ??= node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(branch).toBeDefined();
  return compile(`return async function(msg: any) { ${branch!.getText(ast)} };`, bindings) as (
    msg: Record<string, unknown>,
  ) => Promise<void>;
}

function policy(role?: "host" | "interactive" | "scheduled", env = {}) {
  return compile(`${declaration("desktopRuntimePolicy")} return desktopRuntimePolicy();`, {
    process: { env },
    getAndroidRuntimeContext: () => (role ? { role } : undefined),
  });
}

describe("desktop restore readiness", { retry: 0 }, () => {
  function bootstrapReady(
    restoredSession: string | undefined,
    restore: () => Promise<boolean>,
    currentSession = "fresh",
  ) {
    let completion: ts.Node | undefined;
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "then" &&
        node.expression.expression.getText(ast) === "initTabToolset(tab)"
      ) {
        completion = node.arguments[0];
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(completion).toBeDefined();
    const emit = vi.fn();
    const callback = compile(`return (${completion!.getText(ast)});`, {
      scheduledChild: false,
      restoredSession,
      bootstrapSession: "fresh",
      emitCurrentSessionLoaded: restore,
      emit,
      emptySessionLoadedEvent: () => ({ type: "$session_loaded", name: "fresh", messages: [] }),
      tab: { id: "one", currentSession },
      tabs: new Map([["one", {}]]),
      loadApiKey: () => "synthetic",
      emitCtxBreakdown: vi.fn(),
    }) as () => Promise<void>;
    return { emit, callback };
  }

  it("binds a fresh conversation before enabling its composer", async () => {
    const h = bootstrapReady(undefined, async () => true);
    await h.callback();
    expect(h.emit.mock.calls.map(([event]) => event.type)).toEqual(["$session_loaded", "$ready"]);
  });

  it("does not send an empty snapshot if the user selects history during initialization", async () => {
    const restore = vi.fn(async () => false);
    const h = bootstrapReady(undefined, restore, "selected-history");
    await h.callback();
    expect(restore).toHaveBeenCalledOnce();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("does not release bootstrap readiness while restoration is pending or failed", async () => {
    let resolve!: (result: boolean) => void;
    const deferred = new Promise<boolean>((done) => {
      resolve = done;
    });
    const h = bootstrapReady("history", () => deferred);
    const pending = h.callback();
    await Promise.resolve();
    expect(h.emit).not.toHaveBeenCalled();
    resolve(false);
    await pending;
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("awaits the retried bootstrap snapshot before reporting successful restoration", async () => {
    let resolveSnapshot!: (snapshot: object) => void;
    const delayed = new Promise<object>((resolve) => {
      resolveSnapshot = resolve;
    });
    const tab = { id: "restored", currentSession: "history", bindingId: 1 };
    const emit = vi.fn();
    const currentSessionSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient synthetic read failure"))
      .mockReturnValueOnce(delayed);
    const restore = compile(
      `${declaration("emitCurrentSessionLoaded")} return emitCurrentSessionLoaded;`,
      {
        currentSessionSnapshot,
        emit,
        emitPendingGateEvents: vi.fn(),
      },
    ) as (tab: object) => Promise<boolean>;
    let settled = false;
    const pending = restore(tab).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(emit).not.toHaveBeenCalled();
    resolveSnapshot({ type: "$session_loaded", name: "history", snapshot: { bindingId: 1 } });
    expect(await pending).toBe(true);
    expect(currentSessionSnapshot).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledOnce();
  });

  it("reports final restore failure without returning a successful readiness result", async () => {
    const emit = vi.fn();
    const restore = compile(
      `${declaration("emitCurrentSessionLoaded")} return emitCurrentSessionLoaded;`,
      {
        currentSessionSnapshot: vi
          .fn()
          .mockRejectedValue(new Error("synthetic unreadable history")),
        emit,
        emitPendingGateEvents: vi.fn(),
      },
    ) as (tab: object) => Promise<boolean>;
    expect(await restore({ id: "restored" })).toBe(false);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "$error" }), "restored");
  });

  function resyncHarness(runtime: object | null = {}) {
    let resolveSnapshot!: (snapshot: object) => void;
    let rejectSnapshot!: (error: Error) => void;
    const snapshot = new Promise<object>((resolve, reject) => {
      resolveSnapshot = resolve;
      rejectSnapshot = reject;
    });
    const tab = { id: "restored", currentSession: "history", bindingId: 1, toolset: {}, runtime };
    const emit = vi.fn();
    const noop = vi.fn();
    const bindings = {
      randomUUID: () => "snapshot-id",
      emitAtomicDesktopSnapshot: (run: () => Promise<void>) => run(),
      emit,
      loadApiKey: () => "synthetic",
      tabs: new Map([[tab.id, tab]]),
      lastActiveTabId: tab.id,
      emitSessions: noop,
      emitSettings: noop,
      emitMcpSpecs: noop,
      emitSkills: noop,
      emitMemory: noop,
      emitLibrary: noop,
      emitQQSettings: noop,
      emitUsageHistory: noop,
      emitBalance: async () => {},
      currentSessionSnapshot: () => snapshot,
      emitPendingGateEvents: noop,
      emitCtxBreakdown: noop,
      predictionIdentity: () => null,
      desktopIntegrationsAllowed: false,
    };
    const emitCurrentSessionLoaded = compile(
      `${declaration("emitCurrentSessionLoaded")} return emitCurrentSessionLoaded;`,
      bindings,
    );
    return {
      emit,
      resolveSnapshot,
      rejectSnapshot,
      handle: rpc("desktop_resync", { ...bindings, emitCurrentSessionLoaded }),
    };
  }

  it("does not enable input before a slow restored-session snapshot arrives", async () => {
    const h = resyncHarness();
    const pending = h.handle({ cmd: "desktop_resync" });
    await Promise.resolve();
    expect(h.emit.mock.calls.some(([event]) => event.type === "$ready")).toBe(false);
    h.resolveSnapshot({ type: "$session_loaded", name: "history", snapshot: { bindingId: 1 } });
    await pending;
    const events = h.emit.mock.calls.map(([event]) => event.type);
    expect(events.indexOf("$session_loaded")).toBeLessThan(events.indexOf("$ready"));
  });

  it("does not treat a built toolset as an initialized runtime", async () => {
    const h = resyncHarness(null);
    const pending = h.handle({ cmd: "desktop_resync" });
    h.resolveSnapshot({
      type: "$session_loaded",
      name: "history",
      snapshot: { bindingId: 1 },
      runtimeReady: false,
    });
    await pending;
    expect(h.emit.mock.calls.some(([event]) => event.type === "$ready")).toBe(false);
  });

  it("reports unreadable history instead of enabling an unbound restored conversation", async () => {
    const h = resyncHarness();
    const pending = h.handle({ cmd: "desktop_resync" });
    h.rejectSnapshot(new Error("synthetic history read failure"));
    await pending;
    expect(h.emit.mock.calls.some(([event]) => event.type === "$ready")).toBe(false);
    expect(h.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "$error",
        message: expect.stringContaining("synthetic history read failure"),
      }),
      "restored",
    );
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "$resync_complete" }));
  });
});

function harness(web: boolean, trustedAndroid: boolean, unconfigured = false) {
  let snapshot = {
    baseUrl: "https://relay.example/v1",
    apiKey: unconfigured ? "" : "fake-existing-key-123456",
    model: "fake-model",
    dialectPreference: "auto" as const,
    endpointIdentity: "relay.example",
    officialDeepSeek: false,
    label: "Relay",
    capability: { supportsImages: false },
  };
  const providerVersions = createProviderVersionTracker("mobile-test");
  const version = providerVersions.observe(snapshot);
  const tab = {
    id: "one",
    runtime: null as null | { loop: { model: string } },
    aborter: null,
    unconfiguredSkeleton: unconfigured,
    currentModel: "deepseek-flash",
    currentSession: "empty",
    sessionId: "empty-id",
    turnAdmission: { running: false },
    toolset: { semantic: { enabled: false } },
    rootDir: "/work",
  };
  const config: Record<string, unknown> = {};
  const bindings = {
    isWebSurface: web,
    trustedAndroid,
    tabs: new Map([[tab.id, tab]]),
    tab,
    first: tab,
    settingsRevision: 0,
    providerVersions,
    resolveProviderSnapshot: vi.fn((patch = {}) => ({ ...snapshot, ...patch })),
    saveDesktopProvider,
    probeDesktopProvider,
    summarizeSettingsSave,
    inspectEndpointSources: () => ({ baseUrlSource: "config", apiKeySource: "config" }),
    bindLegacySessionsToCurrentProvider: vi.fn(),
    saveProviderSettings: vi.fn((input) => {
      snapshot = { ...snapshot, ...input };
    }),
    createProviderClient: vi.fn(() => ({
      listModels: vi.fn(async () => ({ data: [{ id: "fake-model" }] })),
      chat: vi.fn(async () => undefined),
    })),
    saveApiKey: vi.fn((apiKey: string) => {
      snapshot = { ...snapshot, apiKey };
    }),
    clearApiKey: vi.fn(),
    isPlausibleKey: () => true,
    bridgeEndpointEnv: vi.fn(),
    emitSettings: vi.fn(),
    emitSettingsToAll: vi.fn(),
    emitBalance: vi.fn(),
    emitStatus: vi.fn(),
    emit: vi.fn(),
    readConfig: vi.fn(() => ({ ...config })),
    writeConfig: vi.fn((next) => Object.assign(config, next)),
    isWebSearchEngine: (value: string) => value === "tavily",
    saveSemanticEmbeddingConfig: vi.fn(),
    isWebFetchEngine: () => true,
    loadSessionMessages: vi.fn((): unknown[] => []),
    hasSharedTurnRecovery: vi.fn(() => false),
    codeSystemPrompt: (_root: string, options: { modelId: string }) => `model=${options.modelId}`,
    loadEngineeringLifecycleMode: () => "auto",
    loadLibraryRetrievalMode: () => "auto",
    replaceRuntimeFor: vi.fn((item) => {
      item.runtime = { loop: { model: item.currentModel } };
    }),
    bridgeTabMcp: vi.fn(async () => {}),
  };
  Object.assign(
    bindings,
    compile(
      `${declaration("bindAndroidUnconfiguredModel")}
    ${declaration("activateAndroidUnconfiguredTabs")}
    return { bindAndroidUnconfiguredModel, activateAndroidUnconfiguredTabs };`,
      bindings,
    ),
  );
  return { bindings, version, config, handle: (cmd: string) => rpc(cmd, bindings) };
}

describe("trusted Android desktop backend adaptation", { retry: 0 }, () => {
  it("activates a no-config Android skeleton on the first complete provider save", async () => {
    const h = harness(true, true, true);
    await h.handle("settings_save")({
      cmd: "settings_save",
      requestId: "first-save",
      expectedProviderVersion: h.version,
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "synthetic-first-provider-key",
      model: "smoke-model",
      providerDialect: "auto",
    });
    expect(h.bindings.emit).toHaveBeenCalledWith({ type: "$ready" }, "one");
    expect(h.bindings.tab.currentModel).toBe("smoke-model");
    expect(h.bindings.tab.runtime?.loop.model).toBe("smoke-model");
    expect(h.bindings.saveApiKey).not.toHaveBeenCalled();
  });

  it("sends the saved model to the local fake Provider for classification and the real Agent loop", async () => {
    const home = mkdtempSync(join(tmpdir(), "jupiter-first-provider-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const requests: Array<{ model: string; messages: unknown[] }> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(input);
      const content = requests.length === 1 ? '{"command":"none"}' : "Synthetic answer";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No fake Provider port");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const h = harness(true, true, true);
    let loop: CacheFirstLoop | undefined;
    h.bindings.replaceRuntimeFor.mockImplementation((item) => {
      const provider = h.bindings.resolveProviderSnapshot();
      loop = new CacheFirstLoop({
        client: new DeepSeekClient({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          retry: { maxAttempts: 1 },
        }),
        model: item.currentModel,
        prefix: new ImmutablePrefix({ system: "Synthetic QA" }),
        stream: false,
        thinkingEnabled: false,
      });
      item.runtime = { loop };
    });
    try {
      await h.handle("settings_save")({
        cmd: "settings_save",
        requestId: "first-save",
        expectedProviderVersion: h.version,
        baseUrl,
        apiKey: "synthetic-first-provider-key",
        model: "smoke-model",
        providerDialect: "auto",
      });
      expect(h.bindings.emit).toHaveBeenCalledWith({ type: "$ready" }, "one");
      expect(loop).toBeDefined();
      await classifyDesktopNaturalCommandIntent(loop!.client, {
        model: h.bindings.tab.currentModel,
        text: "Synthetic request",
      });
      await loop!.run("Synthetic request");
      expect(requests.map((request) => request.model)).toEqual(["smoke-model", "smoke-model"]);
      expect(h.bindings.saveApiKey).not.toHaveBeenCalled();
    } finally {
      loop?.dispose();
      await new Promise<void>((done) => server.close(() => done()));
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(["configured", "history", "recovery", "running", "restored"])(
    "does not reset a genuine %s conversation during provider save",
    async (kind) => {
      const h = harness(true, true, true);
      h.bindings.tab.currentModel = "original-session-model";
      if (kind === "configured")
        h.bindings.tab.runtime = { loop: { model: "original-session-model" } };
      if (kind === "history")
        h.bindings.loadSessionMessages.mockReturnValue([{ role: "user", content: "old" }]);
      if (kind === "recovery") h.bindings.hasSharedTurnRecovery.mockReturnValue(true);
      if (kind === "running") h.bindings.tab.turnAdmission.running = true;
      if (kind === "restored") h.bindings.tab.unconfiguredSkeleton = false;
      await h.handle("settings_save")({
        cmd: "settings_save",
        requestId: "save",
        expectedProviderVersion: h.version,
        apiKey: "synthetic-new-key",
        model: "smoke-model",
      });
      expect(h.bindings.tab.currentModel).toBe("original-session-model");
      expect(h.bindings.replaceRuntimeFor).not.toHaveBeenCalled();
      expect(h.bindings.emit.mock.calls.some(([event]) => event.type === "$ready")).toBe(false);
    },
  );

  it("binds a still-bootstrapping skeleton without building a duplicate runtime", async () => {
    const h = harness(true, true, true);
    Object.assign(h.bindings.tab, { initializing: true });
    await h.handle("settings_save")({
      cmd: "settings_save",
      requestId: "save",
      expectedProviderVersion: h.version,
      apiKey: "synthetic-new-key",
      model: "smoke-model",
    });
    expect(h.bindings.tab.currentModel).toBe("smoke-model");
    expect(h.bindings.replaceRuntimeFor).not.toHaveBeenCalled();
    expect(h.bindings.emit.mock.calls.some(([event]) => event.type === "$ready")).toBe(false);
  });
  it.each(["host", "interactive", "scheduled"] as const)(
    "%s remains a Web transport without desktop integrations",
    (role) => {
      const result = policy(role);
      expect(result.trustedAndroid).toBe(true);
      expect(result.isWebSurface).toBe(true);
      expect(result.scheduledChild).toBe(role === "scheduled");
      expect(result.desktopIntegrationsAllowed).toBe(false);
    },
  );

  it("does not trust Android-looking environment flags", () => {
    const result = policy(undefined, {
      JUPITER_RUNTIME_SURFACE: "android",
      JUPITER_ANDROID: "1",
    });
    expect(result.trustedAndroid).toBe(false);
  });

  it("preserves desktop and ordinary Web identities", () => {
    expect(policy()).toMatchObject({ isWebSurface: false, desktopIntegrationsAllowed: true });
    expect(policy(undefined, { JUPITER_RUNTIME_SURFACE: "web-beta" })).toMatchObject({
      isWebSurface: true,
      trustedAndroid: false,
      desktopIntegrationsAllowed: false,
    });
  });

  it.each([
    ["Android", true, true, true],
    ["Desktop", false, false, true],
    ["Web", true, false, false],
  ] as const)(
    "%s setup/sign-out obey the credential boundary",
    async (_, web, android, allowed) => {
      const h = harness(web, android);
      await h.handle("setup_save_key")({ cmd: "setup_save_key", key: "fake-new-key-123456789" });
      await h.handle("settings_sign_out")({ cmd: "settings_sign_out" });
      expect(h.bindings.saveApiKey).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(h.bindings.clearApiKey).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it.each([
    ["Android", true, true, true],
    ["Desktop", false, false, true],
    ["Web", true, false, false],
  ] as const)("%s provider save preserves the CAS tuple", async (_, web, android, allowed) => {
    const h = harness(web, android);
    const save = h.handle("settings_save");
    const msg = {
      cmd: "settings_save",
      requestId: "save",
      expectedProviderVersion: h.version,
      baseUrl: "https://relay.example/v1",
      apiKey: "fake-new-key-123456789",
      model: "fake-model",
      providerDialect: "auto",
    };
    await save({ ...msg, expectedProviderVersion: "stale" });
    expect(h.bindings.saveProviderSettings).not.toHaveBeenCalled();
    await save(msg);
    expect(h.bindings.saveProviderSettings).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) {
      expect(h.bindings.saveProviderSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: msg.baseUrl,
          apiKey: msg.apiKey,
          model: msg.model,
          dialect: "auto",
        }),
      );
      await save(msg);
      expect(h.bindings.saveProviderSettings).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ["Android", true, true, true],
    ["Desktop", false, false, true],
    ["Web", true, false, false],
  ] as const)(
    "%s provider probe stays behind the same boundary",
    async (_, web, android, allowed) => {
      const h = harness(web, android);
      await h.handle("provider_test")({
        cmd: "provider_test",
        requestId: "probe",
        expectedProviderVersion: h.version,
        baseUrl: "https://relay.example/v1",
        model: "fake-model",
        providerDialect: "auto",
      });
      expect(h.bindings.createProviderClient).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(h.bindings.emit.mock.calls.at(-1)?.[0]).toMatchObject({
        status: allowed ? "success" : "failure",
      });
    },
  );

  it("rejects a probe result after provider credentials change", async () => {
    const h = harness(true, true);
    h.bindings.createProviderClient.mockReturnValue({
      listModels: vi.fn(async () => {
        h.bindings.saveProviderSettings({ apiKey: "changed-key" });
        return { data: [{ id: "fake-model" }] };
      }),
      chat: vi.fn(),
    });
    await h.handle("provider_test")({ cmd: "provider_test", requestId: "r" });
    expect(h.bindings.emit.mock.calls.at(-1)?.[0]).toMatchObject({ status: "conflict" });
  });

  it("persists Android search credentials together and embedding as a whole tuple", async () => {
    const h = harness(true, true);
    const semanticEmbedding = {
      provider: "openai-compat",
      openaiCompat: {
        baseUrl: "https://embedding.example/v1",
        model: "embed",
        apiKey: "fake-embed-key",
      },
    };
    await h.handle("settings_save")({
      cmd: "settings_save",
      requestId: "search",
      webSearchEngine: "tavily",
      tavilyApiKey: "fake-search-key",
      semanticEmbedding,
    });
    expect(h.bindings.writeConfig).toHaveBeenCalledTimes(1);
    expect(h.config).toMatchObject({ webSearchEngine: "tavily", tavilyApiKey: "fake-search-key" });
    expect(h.bindings.saveSemanticEmbeddingConfig).toHaveBeenCalledOnce();
    expect(h.bindings.saveSemanticEmbeddingConfig).toHaveBeenCalledWith(semanticEmbedding);
  });

  it("ordinary Web cannot write embedding credentials even without a policy sanitizer", async () => {
    const h = harness(true, false);
    await h.handle("settings_save")({
      cmd: "settings_save",
      requestId: "embed",
      semanticEmbedding: { provider: "ollama" },
    });
    expect(h.bindings.saveSemanticEmbeddingConfig).not.toHaveBeenCalled();
    expect(h.bindings.emit.mock.calls.some(([event]) => event.type === "$error")).toBe(true);
  });

  it.each(["host", "interactive", "scheduled"] as const)(
    "%s does not auto-start messaging connectors or the desktop updater",
    (role) => {
      const start = source.indexOf(
        "  const qqConfig = loadQQConfig();",
        source.indexOf("const savedTabs"),
      );
      const end = source.indexOf("  scheduledEngine?.start();", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const starts = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
      const enabled = {
        enabled: true,
        appId: "id",
        appSecret: "secret",
        clientId: "id",
        clientSecret: "secret",
      };
      compile(source.slice(start, end), {
        ...policy(role),
        loadQQConfig: () => enabled,
        loadFeishuConfig: () => enabled,
        loadDingTalkConfig: () => enabled,
        startDesktopQQ: starts[0],
        startDesktopFeishu: starts[1],
        startDesktopDingTalk: starts[2],
        emitDesktopUpdateCheck: starts[3],
        broadcastQQSettings: vi.fn(),
        broadcastFeishuSettings: vi.fn(),
        broadcastDingTalkSettings: vi.fn(),
      });
      for (const start of starts) expect(start).not.toHaveBeenCalled();
    },
  );

  it("blocks direct Android update checks, including manual checks", async () => {
    const checkDesktopUpdate = vi.fn();
    const update = compile(
      `${declaration("emitDesktopUpdateCheck")} return emitDesktopUpdateCheck;`,
      {
        getAndroidRuntimeContext: () => ({ role: "scheduled" }),
        checkDesktopUpdate,
      },
    );
    await update(false);
    await update(true);
    expect(checkDesktopUpdate).not.toHaveBeenCalled();
  });

  it("returns only the existing redacted embedding view", () => {
    let spread: ts.SpreadAssignment | undefined;
    function visit(node: ts.Node) {
      if (ts.isSpreadAssignment(node) && node.getText(ast).includes("semanticEmbedding"))
        spread ??= node;
      ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(spread).toBeDefined();
    const secret = "fake-secret-embedding-token-123456789";
    const result = compile(`return ({ ${spread!.getText(ast)} });`, {
      getAndroidRuntimeContext: () => ({ role: "interactive" }),
      loadSemanticEmbeddingUserConfig: () => ({
        provider: "openai-compat",
        openaiCompat: { apiKey: secret },
      }),
      redactSemanticEmbeddingConfig,
    });
    expect(result.semanticEmbedding.openaiCompat.apiKeySet).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each(["host", "interactive", "scheduled"] as const)(
    "%s describes phone-local capabilities in model and help context",
    (role) => {
      const getAndroidRuntimeContext = () => ({ role });
      const runtimeIdentity = compile(
        `${declaration("androidRuntimeIdentity")} return androidRuntimeIdentity();`,
        {
          getAndroidRuntimeContext,
        },
      );
      expect(runtimeIdentity).toContain("locally on this phone");
      expect(runtimeIdentity).toContain("No desktop filesystem access");
      const context = compile(`${declaration("desktopHelpContext")} return desktopHelpContext;`, {
        getAndroidRuntimeContext,
        process: { env: {} },
        loadComputerUseEnabled: () => true,
        resolveProviderSnapshot: () => ({ capability: { supportsImages: true } }),
        desktopOptionalComponents: () => [],
      })({ runtimeIdentity, currentModel: "fake-model" });
      expect(context).toMatchObject({
        surface: "web",
        runtimeIdentity,
        computerUseEnabled: false,
        computerUseStatus: { available: false, driver: false, enabled: false },
      });
    },
  );

  it("retains phone identity whenever the system prompt is rebuilt", () => {
    let prompts = 0;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "codeSystemPrompt") {
        prompts++;
        expect(node.arguments[1]?.getText(ast)).toContain("systemAppend: tab.runtimeIdentity");
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(prompts).toBe(5);
  });

  it.each(["host", "interactive", "scheduled"] as const)(
    "%s performs no dotenv, shell PATH, optional-component or CU probing",
    async (role) => {
      const getAndroidRuntimeContext = () => ({ role });
      const detectOptionalComponents = vi.fn();
      const components = compile(
        `${declaration("desktopOptionalComponents")} return desktopOptionalComponents;`,
        {
          getAndroidRuntimeContext,
          detectOptionalComponents,
        },
      );
      expect(components(true)).toEqual([]);
      expect(detectOptionalComponents).not.toHaveBeenCalled();
      const start = compile(`${declaration("startComputerUse")} return startComputerUse;`, {
        getAndroidRuntimeContext,
        process: { env: {} },
      });
      await expect(start({ toolset: {} })).resolves.toBeUndefined();
      const begin = source.indexOf("export async function desktopCommand(");
      const end = source.indexOf("  installDesktopCrashGuards();", begin);
      const prefix = source.slice(source.indexOf("\n", begin) + 1, end);
      const loadDotenv = vi.fn();
      const augmentProcessPath = vi.fn(() => ({ added: [] }));
      compile(`${declaration("desktopRuntimePolicy")} ${prefix}`, {
        getAndroidRuntimeContext,
        process: { env: {}, stderr: { write: vi.fn() } },
        ScheduledTaskStore: class {},
        loadDotenv,
        augmentProcessPath,
      });
      expect(loadDotenv).not.toHaveBeenCalled();
      expect(augmentProcessPath).not.toHaveBeenCalled();
    },
  );
});
