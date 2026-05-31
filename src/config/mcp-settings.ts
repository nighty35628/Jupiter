import {
  type JupiterConfig,
  type McpServerConfig,
  normalizeMcpConfig,
  readConfig,
  writeConfig,
} from "../config.js";
import { parseMcpSpec, specToRaw } from "../mcp/spec.js";

export interface McpSettingsOptions {
  configPath?: string;
}

export interface McpSpecMutationResult {
  added?: boolean;
  removed?: boolean;
  changed?: boolean;
  alreadyPresent?: boolean;
  name: string | null;
  spec?: string;
}

function configPath(opts: McpSettingsOptions): string | undefined {
  return opts.configPath;
}

function normalizeServerName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(trimmed)) return trimmed;
  return parseMcpSpec(trimmed).name;
}

function cleanupEmptyMcpFields(cfg: JupiterConfig): void {
  if (cfg.mcp && cfg.mcp.length === 0) cfg.mcp = undefined;
  if (cfg.mcpDisabled && cfg.mcpDisabled.length === 0) cfg.mcpDisabled = undefined;
  if (cfg.mcpServers && Object.keys(cfg.mcpServers).length === 0) cfg.mcpServers = undefined;
}

function removeDisabledName(cfg: JupiterConfig, name: string | null): void {
  if (!name || !cfg.mcpDisabled) return;
  cfg.mcpDisabled = cfg.mcpDisabled.filter((entry) => entry !== name);
  cleanupEmptyMcpFields(cfg);
}

function hasServerName(cfg: JupiterConfig, name: string | null): boolean {
  if (!name) return false;
  return normalizeMcpConfig(cfg).some((spec) => spec.name === name);
}

export function addMcpSpecSetting(
  rawSpec: string,
  opts: McpSettingsOptions = {},
): McpSpecMutationResult {
  const spec = rawSpec.trim();
  const parsed = parseMcpSpec(spec);
  const cfg = readConfig(configPath(opts));
  const currentSpecs = normalizeMcpConfig(cfg).map(specToRaw);
  if (currentSpecs.includes(spec) || hasServerName(cfg, parsed.name)) {
    return { added: false, alreadyPresent: true, name: parsed.name, spec };
  }
  cfg.mcp = [...(cfg.mcp ?? []), spec];
  writeConfig(cfg, configPath(opts));
  return { added: true, name: parsed.name, spec };
}

export function removeMcpSpecSetting(
  rawTarget: string,
  opts: McpSettingsOptions = {},
): McpSpecMutationResult {
  const target = rawTarget.trim();
  const cfg = readConfig(configPath(opts));
  const targetName = normalizeServerName(target);
  let removed = false;
  let removedName: string | null = targetName;

  if (cfg.mcp?.includes(target)) {
    const parsed = parseMcpSpec(target);
    cfg.mcp = cfg.mcp.filter((spec) => spec !== target);
    removed = true;
    removedName = parsed.name;
  } else if (targetName && cfg.mcp) {
    const next: string[] = [];
    for (const spec of cfg.mcp) {
      const parsed = parseMcpSpec(spec);
      if (parsed.name === targetName) {
        removed = true;
        removedName = targetName;
      } else {
        next.push(spec);
      }
    }
    cfg.mcp = next;
  }

  if (targetName && cfg.mcpServers?.[targetName]) {
    const nextServers: Record<string, McpServerConfig> = { ...cfg.mcpServers };
    delete nextServers[targetName];
    cfg.mcpServers = nextServers;
    removed = true;
    removedName = targetName;
  }

  if (removed) removeDisabledName(cfg, removedName);
  cleanupEmptyMcpFields(cfg);
  if (removed) writeConfig(cfg, configPath(opts));
  return { removed, name: removedName };
}

export function setMcpSpecDisabled(
  rawName: string,
  disabled: boolean,
  opts: McpSettingsOptions = {},
): McpSpecMutationResult {
  const name = normalizeServerName(rawName);
  if (!name) return { changed: false, name: null };

  const cfg = readConfig(configPath(opts));
  let changed = false;

  if (cfg.mcpServers?.[name]) {
    const server = cfg.mcpServers[name]!;
    const nextDisabled = disabled ? true : undefined;
    if (server.disabled !== nextDisabled) {
      cfg.mcpServers = {
        ...cfg.mcpServers,
        [name]: { ...server, disabled: nextDisabled },
      };
      changed = true;
    }
  } else if ((cfg.mcp ?? []).some((spec) => parseMcpSpec(spec).name === name)) {
    const disabledSet = new Set(cfg.mcpDisabled ?? []);
    const had = disabledSet.has(name);
    if (disabled) disabledSet.add(name);
    else disabledSet.delete(name);
    changed = disabled ? !had : had;
    cfg.mcpDisabled = [...disabledSet];
  }

  cleanupEmptyMcpFields(cfg);
  if (changed) writeConfig(cfg, configPath(opts));
  return { changed, name };
}
