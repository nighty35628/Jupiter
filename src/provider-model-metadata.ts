import { createHash } from "node:crypto";
import type { ProviderDialect } from "./provider-capabilities.js";

export interface ProviderModelMetadataIdentity {
  readonly endpointIdentity: string;
  readonly dialect: ProviderDialect;
  readonly credentialHash: string;
  readonly generation?: string | number;
}

export interface ProviderModelMetadata {
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

/** Capture before awaiting /models so a late result cannot inherit a newer credential identity. */
export function createProviderModelMetadataIdentity(opts: {
  baseUrl: string;
  dialect: ProviderDialect;
  apiKey?: string;
  generation?: string | number;
}): ProviderModelMetadataIdentity {
  let endpoint = opts.baseUrl.trim();
  try {
    endpoint = new URL(endpoint).toString().replace(/\/+$/, "");
  } catch {
    // Metadata caching must not introduce new endpoint validation failures.
  }
  return {
    endpointIdentity: createHash("sha256").update(endpoint).digest("hex"),
    dialect: opts.dialect,
    credentialHash: createHash("sha256")
      .update(opts.apiKey ?? "")
      .digest("hex"),
    generation: opts.generation,
  };
}

function identityKey(identity: ProviderModelMetadataIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.endpointIdentity,
        identity.dialect,
        identity.credentialHash,
        identity.generation ?? null,
      ]),
    )
    .digest("hex");
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

interface MetadataSnapshot {
  readonly models: ReadonlyMap<string, ProviderModelMetadata>;
  readonly expiresAt: number;
}

/** Bounded process-local snapshots of explicit GET /models results. No I/O or discovery. */
export class ProviderModelMetadataCache {
  private readonly snapshots = new Map<string, MetadataSnapshot>();
  private readonly maxEndpoints: number;
  private readonly maxModelsPerEndpoint: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    opts: {
      maxEndpoints?: number;
      maxModelsPerEndpoint?: number;
      ttlMs?: number;
      now?: () => number;
    } = {},
  ) {
    this.maxEndpoints = positiveInteger(opts.maxEndpoints) ?? 16;
    this.maxModelsPerEndpoint = positiveInteger(opts.maxModelsPerEndpoint) ?? 128;
    this.ttlMs = positiveInteger(opts.ttlMs) ?? 30 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  /** Replace one successful list snapshot, retaining neither raw response nor credentials. */
  record(identity: ProviderModelMetadataIdentity, response: unknown): void {
    if (!response || typeof response !== "object") return;
    const data = (response as { data?: unknown }).data;
    if (!Array.isArray(data)) return;
    const models = new Map<string, ProviderModelMetadata>();
    for (const value of data) {
      if (!value || typeof value !== "object") continue;
      const row = value as Record<string, unknown>;
      if (typeof row.id !== "string" || !row.id.trim() || row.id.length > 512) continue;
      const contextWindowTokens = positiveInteger(row.context_window);
      const maxOutputTokens = positiveInteger(row.max_output_tokens);
      if (contextWindowTokens === undefined && maxOutputTokens === undefined) continue;
      if (!models.has(row.id) && models.size >= this.maxModelsPerEndpoint) break;
      models.set(row.id, {
        ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      });
    }
    const key = identityKey(identity);
    this.snapshots.delete(key);
    this.snapshots.set(key, { models, expiresAt: this.now() + this.ttlMs });
    while (this.snapshots.size > this.maxEndpoints) {
      this.snapshots.delete(this.snapshots.keys().next().value!);
    }
  }

  get(identity: ProviderModelMetadataIdentity, model: string): ProviderModelMetadata | undefined {
    const key = identityKey(identity);
    const snapshot = this.snapshots.get(key);
    if (!snapshot) return undefined;
    if (this.now() >= snapshot.expiresAt) {
      this.snapshots.delete(key);
      return undefined;
    }
    const metadata = snapshot.models.get(model);
    if (!metadata) return undefined;
    this.snapshots.delete(key);
    this.snapshots.set(key, snapshot);
    return { ...metadata };
  }
}

const modelMetadata = new ProviderModelMetadataCache();

export function recordProviderModelMetadata(
  identity: ProviderModelMetadataIdentity,
  response: unknown,
): void {
  modelMetadata.record(identity, response);
}

export function getProviderModelMetadata(
  identity: ProviderModelMetadataIdentity,
  model: string,
): ProviderModelMetadata | undefined {
  return modelMetadata.get(identity, model);
}
