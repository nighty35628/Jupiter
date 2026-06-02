import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCodeToolset } from "../src/code/setup.js";
import { ToolRegistry } from "../src/tools.js";
import { buildOpenUrlCommand, registerOpenUrlTool } from "../src/tools/open-url.js";

describe("open_url tool", () => {
  it("builds a macOS Google Chrome opener command", () => {
    expect(buildOpenUrlCommand("https://example.com", "chrome", "darwin")).toEqual({
      command: "open",
      args: ["-a", "Google Chrome", "https://example.com"],
    });
  });

  it("builds a macOS default-browser opener command", () => {
    expect(buildOpenUrlCommand("https://example.com", "default", "darwin")).toEqual({
      command: "open",
      args: ["https://example.com"],
    });
  });

  it("rejects non-web URLs before spawning anything", () => {
    expect(() => buildOpenUrlCommand("file:///etc/passwd", "default", "darwin")).toThrow(
      /only supports http:\/\/ or https:\/\//i,
    );
    expect(() => buildOpenUrlCommand("javascript:alert(1)", "chrome", "darwin")).toThrow(
      /only supports http:\/\/ or https:\/\//i,
    );
  });

  it("dispatches through an injected opener without using run_command", async () => {
    const calls: Array<{ url: string; browser: "default" | "chrome" }> = [];
    const registry = new ToolRegistry();
    registerOpenUrlTool(registry, {
      open: async (url, browser) => {
        calls.push({ url, browser });
      },
    });

    const out = await registry.dispatch("open_url", {
      url: " https://example.com ",
      browser: "chrome",
    });

    expect(out).toBe("opened https://example.com in Google Chrome");
    expect(calls).toEqual([{ url: "https://example.com", browser: "chrome" }]);
  });

  it("is mutating so plan mode blocks browser launches", async () => {
    const registry = new ToolRegistry();
    registry.setPlanMode(true);
    registerOpenUrlTool(registry, {
      open: async () => {
        throw new Error("should not run");
      },
    });

    const out = await registry.dispatch("open_url", {
      url: "https://example.com",
      browser: "default",
    });

    expect(JSON.parse(out).rejectedReason).toBe("plan-mode");
  });
});

describe("buildCodeToolset open_url registration", () => {
  let tmpRoot: string;
  let cfgPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "jupiter-open-url-"));
    cfgPath = join(tmpRoot, "config.json");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("registers open_url in code mode", async () => {
    const toolset = await buildCodeToolset({ rootDir: tmpRoot, configPath: cfgPath });
    expect(toolset.tools.get("open_url")).toBeDefined();
    expect(toolset.tools.get("open_url")?.readOnly).not.toBe(true);
    await toolset.jobs.shutdown();
  });

  it("blocks open_url when editMode=plan is active", async () => {
    writeFileSync(cfgPath, JSON.stringify({ editMode: "plan" }), "utf8");
    const toolset = await buildCodeToolset({ rootDir: tmpRoot, configPath: cfgPath });
    const out = await toolset.tools.dispatch("open_url", {
      url: "https://example.com",
      browser: "default",
    });
    expect(JSON.parse(out).rejectedReason).toBe("plan-mode");
    await toolset.jobs.shutdown();
  });
});
