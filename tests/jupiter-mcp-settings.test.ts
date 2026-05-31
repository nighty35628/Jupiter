import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig, writeConfig } from "../src/config.js";
import {
  addMcpSpecSetting,
  removeMcpSpecSetting,
  setMcpSpecDisabled,
} from "../src/config/mcp-settings.js";

describe("Jupiter MCP settings helpers", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jupiter-mcp-settings-"));
    configPath = join(dir, "config.json");
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("adds a trimmed legacy spec and avoids duplicate server names", () => {
    const added = addMcpSpecSetting("  fs=npx -y @modelcontextprotocol/server-filesystem /tmp  ", {
      configPath,
    });
    expect(added).toMatchObject({ added: true, name: "fs" });
    expect(readConfig(configPath).mcp).toEqual([
      "fs=npx -y @modelcontextprotocol/server-filesystem /tmp",
    ]);

    const duplicate = addMcpSpecSetting("fs=node ./other.js", { configPath });
    expect(duplicate).toMatchObject({ added: false, alreadyPresent: true, name: "fs" });
    expect(readConfig(configPath).mcp).toEqual([
      "fs=npx -y @modelcontextprotocol/server-filesystem /tmp",
    ]);
  });

  it("toggles disabled state for legacy and canonical MCP entries", () => {
    writeConfig(
      {
        mcp: ["legacy=npx legacy-server"],
        mcpServers: {
          github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        },
      },
      configPath,
    );

    expect(setMcpSpecDisabled("legacy", true, { configPath })).toMatchObject({ changed: true });
    expect(readConfig(configPath).mcpDisabled).toEqual(["legacy"]);

    expect(setMcpSpecDisabled("github", true, { configPath })).toMatchObject({ changed: true });
    expect(readConfig(configPath).mcpServers?.github?.disabled).toBe(true);

    expect(setMcpSpecDisabled("legacy", false, { configPath })).toMatchObject({ changed: true });
    expect(readConfig(configPath).mcpDisabled).toBeUndefined();
  });

  it("removes legacy specs by raw string and canonical specs by name", () => {
    writeConfig(
      {
        mcp: ["fs=npx fs-server"],
        mcpDisabled: ["fs", "github"],
        mcpServers: {
          github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        },
      },
      configPath,
    );

    expect(removeMcpSpecSetting("fs=npx fs-server", { configPath })).toMatchObject({
      removed: true,
      name: "fs",
    });
    expect(readConfig(configPath).mcp).toBeUndefined();
    expect(readConfig(configPath).mcpDisabled).toEqual(["github"]);

    expect(removeMcpSpecSetting("github", { configPath })).toMatchObject({
      removed: true,
      name: "github",
    });
    expect(readConfig(configPath).mcpServers).toBeUndefined();
    expect(readConfig(configPath).mcpDisabled).toBeUndefined();
  });
});
