/** `jupiter setup` — re-mount the first-run wizard. */

import { render } from "ink";
import React from "react";
import {
  type ProviderDialectPreference,
  defaultConfigPath,
  inspectEndpointSources,
  loadApiKey,
  readConfig,
  saveProviderSettings,
} from "../../config.js";
import { loadDotenv } from "../../env.js";
import { type ResolvedProviderSnapshot, resolveProviderSnapshot } from "../../provider-runtime.js";
import { Wizard } from "../ui/Wizard.js";

export interface SetupOptions {
  /** Test-only — skip the API-key step. */
  skipKeyStep?: boolean;
  /** Show the API-key step even when a saved/env key already exists. */
  forceKeyStep?: boolean;
  providerUrl?: string;
  providerProtocol?: string;
  providerModel?: string;
  providerKey?: string;
}

function parseProviderProtocol(value: string | undefined): ProviderDialectPreference | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "deepseek" || value === "openai-compatible") return value;
  throw new Error("Provider protocol must be auto, deepseek, or openai-compatible.");
}

export function configureProviderFromSetupOptions(
  opts: SetupOptions,
  configPath: string = defaultConfigPath(),
): ResolvedProviderSnapshot | null {
  const requested =
    opts.providerUrl !== undefined ||
    opts.providerProtocol !== undefined ||
    opts.providerModel !== undefined ||
    opts.providerKey !== undefined;
  if (!requested) return null;

  const sources = inspectEndpointSources(configPath);
  if (sources.baseUrlSource.startsWith("env:")) {
    throw new Error(
      `Provider settings are managed by ${sources.baseUrlSource}; remove that environment variable first.`,
    );
  }
  const current = resolveProviderSnapshot({ configPath });
  const protocol = parseProviderProtocol(opts.providerProtocol) ?? current.dialectPreference;
  const targetWithoutKey = resolveProviderSnapshot({
    configPath,
    baseUrl: opts.providerUrl ?? current.baseUrl,
    model: opts.providerModel ?? current.model,
    dialect: protocol,
  });
  const enteredKey = opts.providerKey?.trim();
  const apiKey =
    enteredKey ||
    (targetWithoutKey.endpointIdentity === current.endpointIdentity ? current.apiKey : undefined);
  if (!apiKey) throw new Error("A new provider endpoint requires --provider-key.");
  if (
    targetWithoutKey.officialDeepSeek &&
    sources.apiKeySource.startsWith("env:") &&
    enteredKey &&
    enteredKey !== current.apiKey
  ) {
    throw new Error(`${sources.apiKeySource} overrides --provider-key for the official endpoint.`);
  }

  saveProviderSettings(
    {
      baseUrl: targetWithoutKey.baseUrl,
      apiKey,
      model: targetWithoutKey.model,
      dialect: targetWithoutKey.dialectPreference,
    },
    configPath,
  );
  return resolveProviderSnapshot({ configPath });
}

export async function setupCommand(opts: SetupOptions = {}): Promise<void> {
  loadDotenv();
  const configured = configureProviderFromSetupOptions(opts);
  if (configured) {
    process.stdout.write(
      `Provider saved: ${configured.label} · ${configured.dialect} · ${configured.model}\n`,
    );
    return;
  }
  const existingKey = loadApiKey();
  const existing = readConfig();

  const { waitUntilExit, unmount } = render(
    <Wizard
      existingApiKey={existingKey}
      initial={{ mcp: existing.mcp, theme: existing.theme }}
      forceApiKeyStep={opts.forceKeyStep}
      onComplete={() => undefined}
      onCancel={() => {
        unmount();
      }}
    />,
    { exitOnCtrlC: true, patchConsole: false },
  );
  await waitUntilExit();
}
