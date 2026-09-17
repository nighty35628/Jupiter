import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureProviderFromSetupOptions } from "../src/cli/commands/setup.js";
import { saveProviderSettings } from "../src/config.js";

const dirs: string[] = [];
const previousApiKey = process.env.DEEPSEEK_API_KEY;

function configPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "jupiter-setup-provider-"));
  dirs.push(dir);
  return join(dir, "config.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // biome-ignore lint/performance/noDelete: process.env coerces undefined to the string "undefined".
  if (previousApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = previousApiKey;
});

describe("setup provider options", () => {
  it("configures a third-party endpoint without entering the interactive wizard", () => {
    const snapshot = configureProviderFromSetupOptions(
      {
        providerUrl: "https://relay.example/v1",
        providerProtocol: "openai-compatible",
        providerModel: "relay-model",
        providerKey: "relay-key",
      },
      configPath(),
    );
    expect(snapshot).toMatchObject({
      label: "relay.example",
      dialect: "openai-compatible",
      model: "relay-model",
      apiKey: "relay-key",
    });
  });

  it("requires a distinct key when changing endpoint identity", () => {
    const path = configPath();
    saveProviderSettings(
      {
        baseUrl: "https://first.example/v1",
        apiKey: "first-key",
        model: "first-model",
        dialect: "openai-compatible",
      },
      path,
    );
    expect(() =>
      configureProviderFromSetupOptions({ providerUrl: "https://second.example/v1" }, path),
    ).toThrow(/requires --provider-key/);
  });

  it("rejects an official key that would be shadowed by the environment", () => {
    process.env.DEEPSEEK_API_KEY = "environment-key";
    expect(() =>
      configureProviderFromSetupOptions({ providerKey: "replacement-key" }, configPath()),
    ).toThrow(/DEEPSEEK_API_KEY overrides --provider-key/);
  });
});
