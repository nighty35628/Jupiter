import { createHash } from "node:crypto";
import { DeepSeekClient } from "./client.js";
import {
  type ProviderDialectPreference,
  loadEndpoint,
  loadImageTransport,
  loadModel,
  loadProviderDialect,
  loadVisionModel,
} from "./config.js";
import type { SessionProviderBinding } from "./memory/session.js";
import {
  type ModelCapability,
  type ProviderDialect,
  isStrictOfficialDeepSeekEndpoint,
  resolveModelCapability,
  resolveProviderDialect,
} from "./provider-capabilities.js";
import { normalizeProviderBaseUrl } from "./provider-url.js";

export interface ResolvedProviderSnapshot {
  id: string;
  endpointIdentity: string;
  label: string;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  dialectPreference: ProviderDialectPreference;
  dialect: ProviderDialect;
  officialDeepSeek: boolean;
  capability: ModelCapability;
  imageTransport?: "auto" | "inline";
}

function identityFor(baseUrl: string, dialect: ProviderDialect): string {
  return createHash("sha256").update(`${dialect}\n${baseUrl}`).digest("hex").slice(0, 24);
}

export function resolveProviderSnapshot(
  opts: {
    configPath?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    dialect?: ProviderDialectPreference;
  } = {},
): ResolvedProviderSnapshot {
  const endpoint = loadEndpoint(opts.configPath);
  const baseUrl = normalizeProviderBaseUrl(opts.baseUrl ?? endpoint.baseUrl ?? "");
  const dialectPreference = opts.dialect ?? loadProviderDialect(opts.configPath);
  const dialect = resolveProviderDialect(baseUrl, dialectPreference);
  const model = opts.model?.trim() || loadModel(opts.configPath);
  const officialDeepSeek = isStrictOfficialDeepSeekEndpoint(baseUrl);
  const endpointIdentity = identityFor(baseUrl, dialect);
  const host = new URL(baseUrl).host;
  return {
    id: officialDeepSeek ? "deepseek-official" : `custom-${endpointIdentity.slice(0, 12)}`,
    endpointIdentity,
    label: officialDeepSeek ? "DeepSeek Official" : host,
    baseUrl,
    apiKey: opts.apiKey ?? endpoint.apiKey,
    model,
    dialectPreference,
    dialect,
    officialDeepSeek,
    capability: resolveModelCapability(
      baseUrl,
      model,
      dialectPreference,
      loadVisionModel(baseUrl, model, opts.configPath),
    ),
    imageTransport: loadImageTransport(opts.configPath),
  };
}

export function createProviderClient(snapshot: ResolvedProviderSnapshot): DeepSeekClient {
  return new DeepSeekClient({
    apiKey: snapshot.apiKey,
    baseUrl: snapshot.baseUrl,
    dialect: snapshot.dialect,
    providerId: snapshot.id,
    visionModels: snapshot.capability.supportsImages ? [snapshot.model] : [],
    imageTransport: snapshot.imageTransport,
    retry: snapshot.officialDeepSeek
      ? undefined
      : { retryableStatuses: [429], retryNetworkErrors: false },
  });
}

export function providerSessionBinding(snapshot: ResolvedProviderSnapshot): SessionProviderBinding {
  return {
    providerId: snapshot.id,
    endpointIdentity: snapshot.endpointIdentity,
    label: snapshot.label,
    dialect: snapshot.dialect,
    model: snapshot.model,
  };
}

export function sameProviderEndpoint(
  left: SessionProviderBinding,
  right: SessionProviderBinding,
): boolean {
  return left.endpointIdentity === right.endpointIdentity && left.dialect === right.dialect;
}
