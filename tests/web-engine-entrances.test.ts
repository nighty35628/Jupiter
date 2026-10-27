import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ path: "" }));
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...actual,
    readConfig: () => actual.readConfig(state.path),
    writeConfig: (cfg: Parameters<typeof actual.writeConfig>[0]) =>
      actual.writeConfig(cfg, state.path),
    webSearchEngine: () => actual.webSearchEngine(state.path),
    webFetchEngine: () => actual.webFetchEngine(state.path),
    webSearchEndpoint: () => actual.webSearchEndpoint(state.path),
    resolveDeepSeekSearchCredential: () => actual.resolveDeepSeekSearchCredential(state.path),
  };
});
import { handlers } from "../src/cli/ui/slash/handlers/web-search-engine.js";
import { readConfig, writeConfig } from "../src/config.js";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "jupiter-engine-entrances-"));
  state.path = join(directory, "config.json");
  writeConfig({
    deepseekSearchApiKey: "dedicated-key",
    webSearchEngine: "bing",
    webFetchEngine: "http",
  });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function command(args: string[]) {
  return handlers["search-engine"]!(args, {} as never, {} as never);
}

describe("web engine owned entrances", () => {
  it("selects direct search without changing explicit HTTP fetch", async () => {
    await command(["deepseek"]);
    expect(readConfig()).toMatchObject({ webSearchEngine: "deepseek", webFetchEngine: "http" });
  });
  it.each(["legacy", "http", "ollama", "deepseek"])(
    "persists fetch mode %s independently",
    async (mode) => {
      await command(["fetch", mode]);
      expect(readConfig()).toMatchObject({ webSearchEngine: "bing", webFetchEngine: mode });
    },
  );
  it("rejects inline credentials and unknown fetch modes without saving", async () => {
    await command(["deepseek", "do-not-persist"]);
    await command(["fetch", "gateway"]);
    expect(readConfig()).toMatchObject({
      deepseekSearchApiKey: "dedicated-key",
      webSearchEngine: "bing",
      webFetchEngine: "http",
    });
  });
  it("keeps the legacy native engine selectable", async () => {
    await command(["deepseek-native"]);
    expect(readConfig().webSearchEngine).toBe("deepseek-native");
  });
  it("includes direct and fetch modes in CLI help", async () => {
    const output = await command([]);
    expect(output?.info).toContain("/search-engine deepseek");
    expect(output?.info).toContain("/search-engine fetch legacy|http|ollama|deepseek");
  });
  it("offers independent choices and dedicated key entry in shared desktop settings", () => {
    const source = readFileSync("desktop/src/ui/settings.tsx", "utf8");
    expect(source).toContain('value={settings.webFetchEngine ?? "legacy"}');
    expect(source).toContain("webSearchEngine: e.target.value as WebSearchEngine");
    expect(source).toContain("webFetchEngine: e.target.value as WebFetchEngine");
    expect(source).toContain('engineOverride="deepseek"');
  });
});
