import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHelpService, prepareHelpContext, readHelp } from "../src/help/index.js";
import type { McpClient } from "../src/mcp/client.js";
import { bridgeMcpTools } from "../src/mcp/registry.js";
import { countTokensBounded } from "../src/tokenizer.js";
import { ToolRegistry } from "../src/tools.js";
import { registerHelpTool } from "../src/tools/help.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bundled host help", () => {
  it("loads only beside the actual installed bundle and binds version plus content", () => {
    const root = mkdtempSync(join(tmpdir(), "jupiter-help-"));
    dirs.push(root);
    cpSync(new URL("../resources/manual", import.meta.url), join(root, "dist/manual"), {
      recursive: true,
    });
    const manifestPath = join(root, "dist/manual/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "9.8.7" }));
    const service = createHelpService({
      moduleUrl: pathToFileURL(join(root, "dist/cli/index.js")).href,
    });
    const before = service.readHelp({ topic: "identity" });
    expect(before.version).toBe("9.8.7");
    writeFileSync(join(root, "dist/manual/identity.md"), "foreign replacement");
    expect(service.readHelp({ topic: "identity" })).toEqual(before);
    expect(
      createHelpService({ moduleUrl: pathToFileURL(join(root, "other/index.js")).href }).readHelp({
        topic: "identity",
      }).content,
    ).toMatch(/unavailable/i);
    expect(
      createHelpService({ moduleUrl: pathToFileURL(join(root, "dist/index.js")).href }).readHelp({
        topic: "identity",
      }).content,
    ).toContain("foreign replacement");
  });

  it("selects at most two chapters, no path traversal, and uses runtime facts", () => {
    const help = readHelp(
      { query: "Jupiter模型第三方API与Computer Use" },
      {
        surface: "cli",
        model: "test-vision",
        computerUseEnabled: true,
        computerUseStatus: { available: true, vision: true, driver: true, authorized: true },
      },
    );
    expect(help.topics.length).toBeLessThanOrEqual(2);
    expect(help.content).toContain("test-vision");
    expect(help.content).toContain("Desktop-only");
    expect(help.content).toContain("unavailable on cli");
    expect(help.content.length).toBeLessThan(6000);
    expect(countTokensBounded(help.content)).toBeLessThanOrEqual(1500);
    expect(readHelp({ topic: "../../config.json" }).topics).toEqual([]);
  });

  it("shows independent OS permission evidence and allows task verification of unknown permissions", () => {
    const help = readHelp(
      { topic: "computer-use" },
      {
        surface: "desktop",
        computerUseEnabled: true,
        computerUseStatus: {
          state: "idle",
          available: true,
          vision: true,
          driver: true,
          permissions: { screen: "unknown", input: "denied" },
        },
      },
    );
    expect(help.content).toContain("state=idle");
    expect(help.content).toContain("screen=unknown; input=denied");
    expect(help.content).toContain("attempt verification");
    expect(help.content).not.toContain("readiness=unavailable");
  });

  it("routes host questions and tiny follow-ups without importing history", () => {
    expect(prepareHelpContext("你能做什么？").isHelp).toBe(true);
    expect(prepareHelpContext("你是什么模型？").topic).toBe("identity");
    expect(prepareHelpContext("那浏览器怎么用？", { recentTopic: "computer-use" }).topic).toBe(
      "browser",
    );
    const result = prepareHelpContext("Jupiter怎么使用浏览器？", { surface: "desktop" });
    expect(result.topic).toBe("browser");
    expect(result.content).toContain("open_url");
    expect(prepareHelpContext("那怎么开？", { recentTopic: "computer-use" }).topic).toBe(
      "computer-use",
    );
    expect(prepareHelpContext("那怎么开？", {}).content).toBe("");
    expect(
      prepareHelpContext("Jupiter怎么使用浏览器？", { injectedTopics: ["browser"] }).content,
    ).toBe("");
    expect(prepareHelpContext("帮我打开浏览器访问网页", {}).content).toBe("");
    const refreshed = readHelp(
      { topic: "computer-use" },
      {
        surface: "desktop",
        injectedTopics: ["computer-use"],
        computerUseStatus: { state: "fault", reason: "driver disconnected" },
      },
    );
    expect(refreshed.content).toContain("state=fault");
    expect(refreshed.content).toContain("driver disconnected");
    expect(refreshed.content).not.toContain("# Computer Use");
    expect(
      prepareHelpContext("现在能 computer use 了吗？打开系统设置给我看看", { surface: "desktop" })
        .topics,
    ).toContain("computer-use");
  });

  it("is readonly, consults live state, and a rejected MCP cannot own or remove it", async () => {
    const registry = new ToolRegistry();
    let model = "first";
    registerHelpTool(registry, { getRuntimeState: () => ({ surface: "desktop", model }) });
    registry.setPlanMode(true);
    expect(await registry.dispatch("jupiter_help", '{"topic":"identity"}')).toContain("first");
    model = "second";
    expect(await registry.dispatch("jupiter_help", '{"topic":"identity"}')).toContain("second");
    const client = {
      listAllTools: vi.fn(async () => [{ name: "jupiter_help", inputSchema: { type: "object" } }]),
      callTool: vi.fn(),
    };
    const bridged = await bridgeMcpTools(client as unknown as McpClient, { registry });
    expect(bridged.registeredNames).toEqual([]);
    expect(bridged.skipped).toEqual([{ name: "jupiter_help", reason: "reserved host tool name" }]);
    for (const name of bridged.registeredNames) registry.unregister(name);
    expect(registry.has("jupiter_help")).toBe(true);
    expect(client.callTool).not.toHaveBeenCalled();
    client.listAllTools.mockResolvedValue([{ name: "help", inputSchema: { type: "object" } }]);
    const prefixed = await bridgeMcpTools(client as unknown as McpClient, {
      registry,
      namePrefix: "jupiter_",
    });
    expect(prefixed.registeredNames).toEqual([]);
    expect(await registry.dispatch("jupiter_help", '{"topic":"identity"}')).toContain("second");
  });
});
