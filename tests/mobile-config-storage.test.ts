import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeConfigEnvelope, encodeConfigEnvelope } from "../src/mobile/config-envelope.js";

type Config = typeof import("../src/config.js");
type Runtime = typeof import("../src/mobile/runtime-context.js");
let config: Config;
let runtime: Runtime;
let dir: string;
let path: string;
let dek: Buffer;

beforeEach(async () => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), "jupiter-mobile-config-"));
  path = join(dir, "config.json");
  dek = randomBytes(32);
  runtime = await import("../src/mobile/runtime-context.js");
  runtime.initializeAndroidRuntimeContext({
    role: "host",
    runId: randomUUID(),
    configPath: path,
    dek,
  });
  config = await import("../src/config.js");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("Android managed config storage", { retry: 0 }, () => {
  it("encrypts a complete config and reads it after save", () => {
    const value = {
      apiKey: "sk-main-storage-secret",
      model: "deepseek-v4-pro",
      lang: "EN" as const,
    };
    config.writeConfig(value, path);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(value.apiKey);
    expect(raw).not.toContain(value.model);
    expect(JSON.parse(decodeConfigEnvelope(raw, dek))).toEqual(value);
    expect(config.readConfig(path)).toEqual(value);
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  it("allows missing-file first setup without exporting the saved API key", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-dotenv-stale");
    vi.stubEnv("DEEPSEEK_BASE_URL", "https://stale.invalid/v1");
    expect(config.readConfig(path)).toEqual({});
    expect(config.loadApiKey(path)).toBeUndefined();
    config.saveApiKey("  sk-first-setup-secret  ", path);
    expect(config.loadApiKey(path)).toBe("sk-first-setup-secret");
    expect(config.loadBaseUrl(path)).toBeUndefined();
    expect(config.readConfig(path).setupCompleted).toBe(true);
    expect(process.env.DEEPSEEK_API_KEY).toBe("sk-dotenv-stale");
    expect(JSON.parse(decodeConfigEnvelope(readFileSync(path, "utf8"), dek)).apiKey).toBe(
      "sk-first-setup-secret",
    );
  });

  it.each([
    ["host", "interactive"],
    ["host", "scheduled"],
    ["interactive", "scheduled"],
  ] as const)(
    "reopens saved config in a fresh process via %s -> %s stdin only",
    async (parentRole, role) => {
      config.saveApiKey("sk-reopen-secret");
      config.saveModel("deepseek-v4-pro");
      let parent = runtime;
      if (parentRole === "interactive") {
        vi.resetModules();
        parent = await import("../src/mobile/runtime-context.js");
        parent.initializeAndroidRuntimeContext({
          role: parentRole,
          runId: randomUUID(),
          configPath: path,
          dek,
        });
      }
      // This is a test-only stdin consumer, not an installed bootstrap entry point.
      const script = `
        import { readFileSync } from 'node:fs';
        import { initializeAndroidRuntimeContext } from './src/mobile/runtime-context.ts';
        import { defaultConfigPath, loadApiKey, loadModel, readConfig } from './src/config.ts';
        const input = JSON.parse(readFileSync(0, 'utf8'));
        const dek = Buffer.from(input.dek, 'base64');
        initializeAndroidRuntimeContext({ ...input, dek });
        dek.fill(0);
        const ok = defaultConfigPath() === input.configPath
          && loadApiKey() === input.expectedApiKey
          && loadModel() === 'deepseek-v4-pro'
          && readConfig().setupCompleted === true;
        process.stdout.write(JSON.stringify({ ok }));
      `;
      parent.withAndroidChildBootstrap(role, randomUUID(), (metadata, childKey) => {
        const result = spawnSync(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script],
          {
            input: JSON.stringify({
              ...metadata,
              dek: Buffer.from(childKey).toString("base64"),
              expectedApiKey: "sk-reopen-secret",
            }),
            encoding: "utf8",
            timeout: 15_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ ok: true });
        expect(result.stderr).not.toContain("sk-reopen-secret");
        expect(result.stderr).not.toContain(dek.toString("base64"));
      });
    },
  );

  it("saves endpoint/key/model as one tuple and clears without env fallback", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-dotenv-stale");
    vi.stubEnv("DEEPSEEK_API_BASE_URL", "https://dotenv.invalid/v1");
    config.saveProviderSettings({
      baseUrl: "https://first.invalid/v1",
      apiKey: "sk-first-provider",
      model: "first-model",
      dialect: "openai-compatible",
    });
    expect(config.loadEndpoint()).toEqual({
      baseUrl: "https://first.invalid/v1",
      apiKey: "sk-first-provider",
    });
    config.saveProviderSettings({
      baseUrl: "https://second.invalid/v1",
      apiKey: "sk-second-provider",
      model: "second-model",
      dialect: "openai-compatible",
      vision: true,
    });
    expect(config.loadEndpoint()).toEqual({
      baseUrl: "https://second.invalid/v1",
      apiKey: "sk-second-provider",
    });
    expect(config.loadModel()).toBe("second-model");
    expect(config.loadProviderDialect()).toBe("openai-compatible");
    expect(config.inspectEndpointSources()).toMatchObject({
      baseUrlSource: `config:${path}#baseUrl`,
      apiKeySource: `config:${path}#apiKey`,
      shadowedEnvApiKey: false,
    });
    expect(config.resolveBaseUrlEnv()).toBeUndefined();
    config.clearApiKey();
    expect(config.loadApiKey()).toBeUndefined();
    expect(config.readConfig()).toMatchObject({ setupCompleted: false, model: "second-model" });
    expect(config.readConfig()).not.toHaveProperty("apiKey");
    expect(process.env.DEEPSEEK_API_KEY).toBe("sk-dotenv-stale");
    const plaintext = decodeConfigEnvelope(readFileSync(path, "utf8"), dek);
    expect(plaintext).not.toContain("sk-second-provider");
  });

  const searchCredentials = [
    ["metasoApiKey", "loadMetasoApiKey", "METASO_API_KEY"],
    ["baiduApiKey", "loadBaiduApiKey", "BAIDU_API_KEY"],
    ["baiduApiKey", "loadBaiduApiKey", "QIANFAN_API_KEY"],
    ["tavilyApiKey", "loadTavilyApiKey", "TAVILY_API_KEY"],
    ["perplexityApiKey", "loadPerplexityApiKey", "PERPLEXITY_API_KEY"],
    ["exaApiKey", "loadExaApiKey", "EXA_API_KEY"],
    ["ollamaApiKey", "loadOllamaApiKey", "OLLAMA_API_KEY"],
    ["ollamaApiKey", "loadOllamaApiKey", "ollamaApiKey"],
    ["braveApiKey", "loadBraveApiKey", "BRAVE_SEARCH_API_KEY"],
    ["braveApiKey", "loadBraveApiKey", "BRAVE_API_KEY"],
    ["deepseekSearchApiKey", "loadDeepSeekSearchApiKey", "DEEPSEEK_SEARCH_API_KEY"],
  ] as const;

  it.each(searchCredentials)("keeps %s encrypted and ignores %s env (%s)", (field, loader, env) => {
    vi.stubEnv(env, "sk-env-search-secret");
    expect(config[loader]()).toBeUndefined();
    config.writeConfig({ [field]: "sk-config-search-secret" });
    expect(config[loader]()).toBe("sk-config-search-secret");
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("sk-config-search-secret");
    expect(JSON.parse(decodeConfigEnvelope(raw, dek))[field]).toBe("sk-config-search-secret");
    config.saveApiKey("sk-main-provider");
    expect(config[loader]()).toBe("sk-config-search-secret");
    expect(config.resolveDeepSeekSearchCredential().apiKey).not.toBe("sk-env-search-secret");
  });

  it("encrypts embeddings and preserves search secrets through unrelated saves", () => {
    config.writeConfig({ tavilyApiKey: "sk-search-preserved", promptHistory: ["private-prompt"] });
    config.saveSemanticEmbeddingConfig({
      provider: "openai-compat",
      openaiCompat: {
        baseUrl: "https://embeddings.invalid/v1",
        apiKey: "sk-embed-secret",
        model: "embed-model",
      },
    });
    config.saveLanguage("zh-CN");
    expect(config.resolveSemanticEmbeddingConfig()).toMatchObject({
      apiKey: "sk-embed-secret",
      baseUrl: "https://embeddings.invalid/v1",
      model: "embed-model",
    });
    expect(config.loadTavilyApiKey()).toBe("sk-search-preserved");
    const raw = readFileSync(path, "utf8");
    for (const secret of [
      "sk-search-preserved",
      "sk-embed-secret",
      "private-prompt",
      "embed-model",
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(JSON.parse(decodeConfigEnvelope(raw, dek))).toMatchObject({ lang: "zh-CN" });
  });

  it("does not allow bot credential env overrides either", () => {
    for (const name of [
      "QQ_APPID",
      "QQ_SECRET",
      "FEISHU_APP_ID",
      "FEISHU_APP_SECRET",
      "DINGTALK_CLIENT_ID",
      "DINGTALK_APP_KEY",
      "DINGTALK_CLIENT_SECRET",
      "DINGTALK_APP_SECRET",
      "TELEGRAM_BOT_TOKEN",
    ]) {
      vi.stubEnv(name, "env-bot-secret");
    }
    expect(config.loadQQConfig().appSecret).toBeUndefined();
    expect(config.loadFeishuConfig().appSecret).toBeUndefined();
    expect(config.loadDingTalkConfig().clientSecret).toBeUndefined();
    expect(config.loadTelegramConfig().botToken).toBeUndefined();
    config.writeConfig({
      qq: { appId: "qq-id", appSecret: "qq-secret" },
      feishu: { appId: "feishu-id", appSecret: "feishu-secret" },
      dingtalk: { clientId: "ding-id", clientSecret: "ding-secret" },
      telegram: { botToken: "telegram-secret" },
    });
    expect(config.loadQQConfig()).toMatchObject({ appId: "qq-id", appSecret: "qq-secret" });
    expect(config.loadFeishuConfig()).toMatchObject({
      appId: "feishu-id",
      appSecret: "feishu-secret",
    });
    expect(config.loadDingTalkConfig()).toMatchObject({
      clientId: "ding-id",
      clientSecret: "ding-secret",
    });
    expect(config.loadTelegramConfig().botToken).toBe("telegram-secret");
  });

  it("authenticates even after a prior successful read with the same mtime", () => {
    config.saveApiKey("sk-valid-before-tamper");
    const timestamp = statSync(path).mtime;
    expect(config.loadApiKey()).toBe("sk-valid-before-tamper");
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    envelope.tag = Buffer.alloc(16).toString("base64");
    const raw = JSON.stringify(envelope);
    writeFileSync(path, raw);
    utimesSync(path, timestamp, timestamp);
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-env-cannot-bypass-auth");
    vi.stubEnv("DEEPSEEK_BASE_URL", "https://env.invalid/v1");
    vi.stubEnv("TAVILY_API_KEY", "sk-env-cannot-bypass-auth");
    expect(() => config.loadApiKey()).toThrow("Android config authentication failed");
    expect(() => config.loadTavilyApiKey()).toThrow("Android config authentication failed");
    expect(() => config.saveLanguage("EN")).toThrow("Android config authentication failed");
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("never exposes a mutable cached config object", () => {
    config.saveApiKey("sk-unchanged-on-disk");
    config.readConfig().apiKey = "sk-mutated-only-in-memory";
    expect(config.loadApiKey()).toBe("sk-unchanged-on-disk");
  });

  it("redacts serialization errors and leaves the previous config intact", () => {
    config.saveApiKey("sk-valid-before-invalid-write");
    const before = readFileSync(path, "utf8");
    const circular: Record<string, unknown> = {};
    circular["sk-sensitive-property-name"] = circular;
    expect(() => config.writeConfig(circular)).toThrow("Invalid Android config JSON");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  it("only encrypts the managed path, including its normalized aliases", () => {
    const other = join(dir, "desktop.json");
    config.writeConfig({ lang: "EN" }, other);
    expect(JSON.parse(readFileSync(other, "utf8"))).toEqual({ lang: "EN" });
    expect(config.readConfig(other)).toEqual({ lang: "EN" });
    const alias = `${dir}/unused/../config.json`;
    // The alias is normalized for ownership; use an existing intermediate dir for filesystem access.
    mkdirSync(join(dir, "unused"));
    config.writeConfig({ apiKey: "sk-managed-alias" }, alias);
    expect(config.loadApiKey()).toBe("sk-managed-alias");
    expect(decodeConfigEnvelope(readFileSync(path, "utf8"), dek)).toContain("sk-managed-alias");
  });

  it("uses the existing synchronous atomic writer with ciphertext only", async () => {
    const atomic = await import("../src/core/atomic-write.js");
    const spy = vi.spyOn(atomic, "atomicWriteSync");
    config.saveApiKey("sk-atomic-only");
    expect(spy).toHaveBeenCalledTimes(1);
    const [target, body, temporary] = spy.mock.calls[0]!;
    expect(target).toBe(path);
    expect(temporary).toMatch(/config\.json\.[0-9a-f]+\.tmp$/);
    expect(body).not.toContain("sk-atomic-only");
    expect(JSON.parse(decodeConfigEnvelope(body, dek)).apiKey).toBe("sk-atomic-only");
    const before = readFileSync(path, "utf8");
    spy.mockImplementationOnce(() => {
      throw new Error("test disk unavailable");
    });
    expect(() => config.saveLanguage("EN")).toThrow("test disk unavailable");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(config.loadApiKey()).toBe("sk-atomic-only");
  });

  it.each([
    "wrong key",
    "tampered tag",
    "plaintext",
    "malformed",
    "future version",
    "empty",
    "array",
  ])("rejects %s on read and write without overwriting evidence", (kind) => {
    let raw = encodeConfigEnvelope('{"apiKey":"sk-do-not-leak"}', dek);
    if (kind === "wrong key")
      raw = encodeConfigEnvelope('{"apiKey":"sk-do-not-leak"}', randomBytes(32));
    if (kind === "tampered tag") {
      const envelope = JSON.parse(raw);
      envelope.tag = Buffer.alloc(16).toString("base64");
      raw = JSON.stringify(envelope);
    }
    if (kind === "plaintext") raw = '{"apiKey":"sk-do-not-leak"}';
    if (kind === "malformed") raw = '{"apiKey":"sk-do-not-leak';
    if (kind === "future version") raw = JSON.stringify({ ...JSON.parse(raw), version: 999 });
    if (kind === "empty") raw = "";
    if (kind === "array") raw = "[]";
    writeFileSync(path, raw);
    const readError =
      kind === "wrong key" || kind === "tampered tag"
        ? "Android config authentication failed"
        : kind === "future version"
          ? "Unsupported Android config envelope version"
          : "Invalid Android config envelope";
    expect(() => config.readConfig(path)).toThrow(readError);
    expect(() => config.saveApiKey("sk-replacement", path)).toThrow(readError);
    expect(() => config.writeConfig({ apiKey: "sk-replacement" }, path)).toThrow(readError);
    try {
      config.readConfig(path);
    } catch (error) {
      expect(String(error)).not.toContain("sk-do-not-leak");
      expect(String(error)).not.toContain(path);
      expect((error as Error).cause).toBeUndefined();
    }
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  it("does not treat a read I/O failure as a missing config", () => {
    mkdirSync(path);
    expect(() => config.readConfig(path)).toThrow("Android config read failed");
    expect(() => config.writeConfig({}, path)).toThrow("Android config read failed");
  });
});

describe("one-shot trusted Android runtime", { retry: 0 }, () => {
  async function fresh() {
    vi.resetModules();
    return import("../src/mobile/runtime-context.js");
  }

  it("does not self-activate from env or URL-shaped input", async () => {
    vi.stubEnv("JUPITER_ANDROID", "1");
    vi.stubEnv("JUPITER_ANDROID_ROLE", "host");
    vi.stubEnv("JUPITER_ANDROID_DEK", dek.toString("base64"));
    vi.stubEnv("JUPITER_CONFIG_PATH", path);
    const other = await fresh();
    const desktop = await import("../src/config.js");
    expect(other.getAndroidRuntimeContext()).toBeUndefined();
    expect(other.isAndroidManagedConfigPath(path)).toBe(false);
    expect(desktop.defaultConfigPath()).not.toBe(path);
    expect(() => other.withAndroidConfigKey(path, () => {})).toThrow("unavailable");
    expect(() =>
      other.initializeAndroidRuntimeContext({
        role: "host",
        runId: randomUUID(),
        configPath: "https://example.invalid/config",
        dek,
      }),
    ).toThrow("absolute path");
  });

  it.each(["host", "interactive", "scheduled"] as const)(
    "accepts validated %s metadata once",
    async (role) => {
      const other = await fresh();
      const runId = randomUUID();
      const input = { role, runId, configPath: path, dek };
      const metadata = other.initializeAndroidRuntimeContext(input);
      expect(metadata).toEqual({ role, runId, configPath: path });
      expect(Object.isFrozen(metadata)).toBe(true);
      expect(JSON.stringify(metadata)).not.toContain("dek");
      expect(inspect(metadata)).not.toContain(dek.toString("hex"));
      expect(() => other.initializeAndroidRuntimeContext(input)).toThrow("already initialized");
    },
  );

  it.each([
    { role: "desktop" },
    { runId: "not-a-uuid" },
    { runId: "12345678-1234-1234-1234-123456789abc" },
    { configPath: "relative/config.json" },
    { configPath: "/config\0secret" },
    { dek: new Uint8Array(31) },
    { dek: new Uint8Array(33) },
    { dek: "do-not-leak-key" },
  ])("rejects invalid bootstrap fields without consuming initialization (%j)", async (patch) => {
    const other = await fresh();
    const valid = { role: "host" as const, runId: randomUUID(), configPath: path, dek };
    expect(() =>
      other.initializeAndroidRuntimeContext({ ...valid, ...patch } as Parameters<
        Runtime["initializeAndroidRuntimeContext"]
      >[0]),
    ).toThrow(/Android runtime/);
    expect(other.getAndroidRuntimeContext()).toBeUndefined();
    expect(other.initializeAndroidRuntimeContext(valid).configPath).toBe(path);
  });

  it("copies the input DEK and erases callback copies on success and failure", () => {
    const original = Buffer.from(dek);
    dek.fill(0);
    let temporary: Uint8Array | undefined;
    runtime.withAndroidConfigKey(path, (key) => {
      expect(Buffer.from(key)).toEqual(original);
      temporary = key;
      key.fill(1);
    });
    expect(temporary).toEqual(new Uint8Array(32));
    expect(() =>
      runtime.withAndroidConfigKey(path, (key) => {
        expect(Buffer.from(key)).toEqual(original);
        temporary = key;
        throw new Error("callback failed");
      }),
    ).toThrow("callback failed");
    expect(temporary).toEqual(new Uint8Array(32));
    expect(() => runtime.withAndroidConfigKey(join(dir, "unmanaged.json"), () => {})).toThrow(
      "unavailable",
    );
  });

  it("hands metadata and a temporary DEK to a child without exporting env", () => {
    const env = { ...process.env };
    let temporary: Uint8Array | undefined;
    const runId = randomUUID();
    runtime.withAndroidChildBootstrap("scheduled", runId, (metadata, key) => {
      expect(metadata).toEqual({ role: "scheduled", runId, configPath: path });
      expect(Buffer.from(key)).toEqual(dek);
      expect(metadata).not.toHaveProperty("dek");
      temporary = key;
    });
    expect(temporary).toEqual(new Uint8Array(32));
    expect(process.env).toEqual(env);
    expect(() => runtime.withAndroidChildBootstrap("interactive", "bad-id", () => {})).toThrow(
      "UUID",
    );
  });

  it.each([
    ["host", "interactive", true],
    ["host", "scheduled", true],
    ["interactive", "scheduled", true],
    ["interactive", "interactive", false],
    ["scheduled", "interactive", false],
    ["scheduled", "scheduled", false],
  ] as const)(
    "enforces %s -> %s child handoff permission (%s)",
    async (role, childRole, allowed) => {
      const other = await fresh();
      other.initializeAndroidRuntimeContext({ role, runId: randomUUID(), configPath: path, dek });
      const deliver = vi.fn();
      const handoff = () => other.withAndroidChildBootstrap(childRole, randomUUID(), deliver);
      if (allowed) {
        expect(handoff).not.toThrow();
        expect(deliver).toHaveBeenCalledTimes(1);
      } else {
        expect(handoff).toThrow("cannot bootstrap this child");
        expect(deliver).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps uninitialized Desktop plaintext, env precedence, BOM, save and clear behavior", async () => {
    await fresh();
    const desktop = await import("../src/config.js");
    vi.stubEnv("DEEPSEEK_BASE_URL", "");
    vi.stubEnv("DEEPSEEK_API_BASE_URL", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-desktop-env");
    desktop.saveApiKey("sk-desktop-saved", path);
    expect(process.env.DEEPSEEK_API_KEY).toBe("sk-desktop-saved");
    expect(JSON.parse(readFileSync(path, "utf8")).apiKey).toBe("sk-desktop-saved");
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-env-wins");
    expect(desktop.loadApiKey(path)).toBe("sk-env-wins");
    desktop.clearApiKey(path);
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(desktop.loadApiKey(path)).toBeUndefined();
    const bom = join(dir, "bom.json");
    writeFileSync(bom, '\uFEFF{"lang":"en"}');
    expect(desktop.readConfig(bom)).toEqual({ lang: "en" });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "invalid JSON");
    expect(desktop.readConfig(bad)).toEqual({});
    expect(existsSync(path)).toBe(true);
  });
});
