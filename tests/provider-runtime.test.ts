import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadEndpoint,
  loadProviderDialect,
  readConfig,
  saveModel,
  saveProviderSettings,
} from "../src/config.js";
import { resolveProviderSnapshot } from "../src/provider-runtime.js";
import { normalizeProviderBaseUrl } from "../src/provider-url.js";

const dirs: string[] = [];

function configPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "jupiter-provider-"));
  dirs.push(dir);
  return join(dir, "config.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("provider configuration", () => {
  it("persists endpoint, key, model, and protocol atomically", () => {
    const path = configPath();
    saveProviderSettings(
      {
        baseUrl: "https://relay.example/v1/",
        apiKey: "relay-secret",
        model: "relay-model",
        dialect: "openai-compatible",
      },
      path,
    );

    expect(readConfig(path)).toMatchObject({
      baseUrl: "https://relay.example/v1",
      apiKey: "relay-secret",
      model: "relay-model",
      providerDialect: "openai-compatible",
    });
    expect(loadEndpoint(path)).toEqual({
      baseUrl: "https://relay.example/v1",
      apiKey: "relay-secret",
    });
    expect(loadProviderDialect(path)).toBe("openai-compatible");
  });

  it("uses the official endpoint as the canonical default", () => {
    const path = configPath();
    saveProviderSettings(
      {
        baseUrl: "https://api.deepseek.com/",
        apiKey: "official-secret",
        model: "deepseek-v4-flash",
        dialect: "auto",
      },
      path,
    );

    expect(readConfig(path).baseUrl).toBeUndefined();
    const snapshot = resolveProviderSnapshot({ configPath: path });
    expect(snapshot.id).toBe("deepseek-official");
    expect(snapshot.dialect).toBe("deepseek");
    expect(snapshot.officialDeepSeek).toBe(true);
  });

  it("keeps the saved official model and image capability aligned across model switches", () => {
    const path = configPath();
    saveProviderSettings(
      {
        baseUrl: "https://api.deepseek.com",
        apiKey: "official-test-key",
        model: "deepseek-v4-pro",
        dialect: "auto",
      },
      path,
    );
    expect(readConfig(path).baseUrl).toBeUndefined();
    for (const model of [
      "deepseek-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp",
    ]) {
      saveModel(model, path);
      const snapshot = resolveProviderSnapshot({ configPath: path });
      expect(snapshot.model).toBe(model);
      expect(snapshot.capability.supportsImages).toBe(model !== "deepseek-v4-pro");
    }
  });

  it("rejects unsafe public HTTP URLs and embedded credentials", () => {
    expect(() => normalizeProviderBaseUrl("http://relay.example/v1")).toThrow(/HTTPS/);
    expect(() => normalizeProviderBaseUrl("https://user:pass@relay.example/v1")).toThrow(
      /credentials/,
    );
    expect(normalizeProviderBaseUrl("http://192.168.1.20:8000/v1/")).toBe(
      "http://192.168.1.20:8000/v1",
    );
  });

  it("changes endpoint identity when the wire protocol changes", () => {
    const deepseek = resolveProviderSnapshot({
      baseUrl: "https://relay.example/v1",
      apiKey: "key",
      model: "model",
      dialect: "deepseek",
    });
    const openai = resolveProviderSnapshot({
      baseUrl: "https://relay.example/v1",
      apiKey: "key",
      model: "model",
      dialect: "openai-compatible",
    });
    expect(deepseek.endpointIdentity).not.toBe(openai.endpointIdentity);
  });
});
