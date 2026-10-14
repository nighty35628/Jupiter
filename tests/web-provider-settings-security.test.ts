import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  createProviderVersionTracker,
  probeDesktopProvider,
  saveDesktopProvider,
} from "../src/desktop/provider-settings.js";
import { authorizeDesktopCommand } from "../src/web/policy.js";
import type { WorkspaceRegistry } from "../src/web/workspaces.js";

const policies = (["local", "lan", "public"] as const).flatMap((mode) =>
  [false, true].map((highRiskEnabled) => ({ mode, highRiskEnabled })),
);
const workspaces = {} as WorkspaceRegistry;

function setupKeyHandler(web: boolean, plausible = true, failRuntime = false) {
  const source = readFileSync("src/cli/commands/desktop.ts", "utf8");
  const start = source.indexOf('if (msg.cmd === "setup_save_key")');
  const end = source.indexOf('if (msg.cmd === "settings_sign_out")', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  // Isolate the actual backend branch; no config writes, runtime startup or network calls.
  const code = ts.transpileModule(
    `async function handle(msg: unknown) { ${source.slice(start, end)} }`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    },
  ).outputText;
  let current = {
    baseUrl: "https://relay.example/v1",
    apiKey: "mock-initial-key",
    model: "mock-model",
    dialectPreference: "auto" as const,
    endpointIdentity: "relay",
    officialDeepSeek: false,
    label: "Relay",
    capability: { supportsImages: false },
  };
  const resolveProviderSnapshot = vi.fn(
    (
      input: {
        baseUrl?: string;
        apiKey?: string;
        model?: string;
        dialect?: "auto" | "deepseek" | "openai-compatible";
      } = {},
    ) => ({ ...current, ...input, dialectPreference: input.dialect ?? current.dialectPreference }),
  );
  const providerVersions = createProviderVersionTracker("setup-server");
  const initialVersion = providerVersions.observe(current);
  const saveApiKey = vi.fn((key: string) => {
    current = { ...current, apiKey: key };
  });
  const bridgeEndpointEnv = vi.fn();
  const isPlausibleKey = vi.fn(() => plausible);
  const emit = vi.fn();
  const emitSettings = vi.fn(() => providerVersions.observe(resolveProviderSnapshot()));
  const emitBalance = vi.fn(async () => null);
  const replaceRuntimeFor = vi.fn(() => {
    throw new Error("mock runtime rebuild failure");
  });
  const tabs = failRuntime ? new Map([["mock-tab", { toolset: {} }]]) : new Map();
  const handle = new Function(
    "saveApiKey",
    "bridgeEndpointEnv",
    "isPlausibleKey",
    "tabs",
    "emit",
    "isWebSurface",
    "first",
    "providerVersions",
    "resolveProviderSnapshot",
    "replaceRuntimeFor",
    "emitSettings",
    "emitBalance",
    `${code}; return handle;`,
  )(
    saveApiKey,
    bridgeEndpointEnv,
    isPlausibleKey,
    tabs,
    emit,
    web,
    {
      id: "mock-tab",
    },
    providerVersions,
    resolveProviderSnapshot,
    replaceRuntimeFor,
    emitSettings,
    emitBalance,
  ) as (msg: { cmd: "setup_save_key"; key: string }) => Promise<void>;
  return {
    handle,
    saveApiKey,
    bridgeEndpointEnv,
    isPlausibleKey,
    emit,
    providerVersions,
    resolveProviderSnapshot,
    initialVersion,
    replaceRuntimeFor,
    emitSettings,
  };
}

describe("Web legacy provider credential boundary", { retry: 0 }, () => {
  it.each(policies)(
    "rejects setup_save_key in $mode (high risk: $highRiskEnabled)",
    async (policy) => {
      await expect(
        authorizeDesktopCommand(
          { cmd: "setup_save_key", key: "mock-key-long-enough-123" },
          { ...policy, workspaces },
        ),
      ).rejects.toThrow();
    },
  );

  it.each(policies)(
    "preserves settings reads in $mode (high risk: $highRiskEnabled)",
    async (policy) => {
      const result = await authorizeDesktopCommand(
        { cmd: "settings_get" },
        { ...policy, workspaces },
      );
      expect(result.command).toEqual({ cmd: "settings_get" });
      expect(result.risk).toBe("read");
    },
  );

  it("rejects backend Web setup before reading, validating or writing the key", async () => {
    const f = setupKeyHandler(true);
    const readKey = vi.fn(() => "mock-key-long-enough-123");
    await f.handle({
      cmd: "setup_save_key",
      get key() {
        return readKey();
      },
    });
    expect(readKey).not.toHaveBeenCalled();
    expect(f.isPlausibleKey).not.toHaveBeenCalled();
    expect(f.saveApiKey).not.toHaveBeenCalled();
    expect(f.bridgeEndpointEnv).not.toHaveBeenCalled();
    expect(f.emit).toHaveBeenCalledWith(
      {
        type: "$error",
        message: "Provider credentials can only be changed in Jupiter Desktop.",
      },
      "mock-tab",
    );
    expect(JSON.stringify(f.emit.mock.calls)).not.toContain("mock-key-long-enough-123");
  });

  it("preserves Desktop setup key validation and saving", async () => {
    const f = setupKeyHandler(false);
    await f.handle({ cmd: "setup_save_key", key: " mock-key-long-enough-123 " });
    expect(f.saveApiKey).toHaveBeenCalledTimes(1);
    expect(f.saveApiKey).toHaveBeenCalledWith("mock-key-long-enough-123");
    expect(f.bridgeEndpointEnv).toHaveBeenCalledTimes(1);
    expect(f.emit).not.toHaveBeenCalled();
    const invalid = setupKeyHandler(false, false);
    await invalid.handle({ cmd: "setup_save_key", key: "short" });
    expect(invalid.saveApiKey).not.toHaveBeenCalled();
    expect(invalid.bridgeEndpointEnv).not.toHaveBeenCalled();
    expect(invalid.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "$error" }));
  });

  it("advances the credential clock before a failed Desktop runtime refresh", async () => {
    const f = setupKeyHandler(false, true, true);
    await f.handle({ cmd: "setup_save_key", key: "mock-rotated-key" });
    expect(f.saveApiKey).toHaveBeenCalledTimes(1);
    expect(f.replaceRuntimeFor).toHaveBeenCalledTimes(1);
    expect(f.emitSettings).not.toHaveBeenCalled();
    expect(f.providerVersions.version).not.toBe(f.initialVersion);
  });

  it("invalidates old probes and CAS after setup key ABA even when runtime refresh fails", async () => {
    const f = setupKeyHandler(false, true, true);
    let release!: (models: { data: { id: string }[] }) => void;
    const chat = vi.fn();
    const pending = probeDesktopProvider(
      {
        requestId: "probe-before-setup",
        expectedProviderVersion: f.initialVersion,
        baseUrl: "https://relay.example/v1",
        model: "mock-model",
        providerDialect: "auto",
      },
      {
        resolve: f.resolveProviderSnapshot,
        tracker: f.providerVersions,
        createClient: () => ({
          listModels: () =>
            new Promise((resolve) => {
              release = resolve;
            }),
          chat,
        }),
      },
    );
    await f.handle({ cmd: "setup_save_key", key: "mock-rotated-key" });
    await f.handle({ cmd: "setup_save_key", key: "mock-initial-key" });
    release({ data: [{ id: "mock-model" }] });
    const probe = await pending;
    const save = vi.fn();
    const saved = saveDesktopProvider(
      { expectedProviderVersion: f.initialVersion, model: "next-model" },
      {
        resolve: f.resolveProviderSnapshot,
        tracker: f.providerVersions,
        save,
        bindLegacy: vi.fn(),
        sources: () => ({ baseUrlSource: "config", apiKeySource: "config" }),
      },
    );
    expect({ probe: probe.status, cas: saved.status, writes: save.mock.calls.length }).toEqual({
      probe: "conflict",
      cas: "conflict",
      writes: 0,
    });
    expect(probe.ok).toBe(false);
    expect(chat).not.toHaveBeenCalled();
    expect(f.emitSettings).not.toHaveBeenCalled();
    expect(JSON.stringify(probe)).not.toMatch(/mock-(initial|rotated)-key/);
  });
});
