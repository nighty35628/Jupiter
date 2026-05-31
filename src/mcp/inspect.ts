/** Unsupported list methods surface as `{supported:false}` instead of throwing — minimal servers still get a clean report. */

import type { McpClient } from "./client.js";
import type { McpPrompt, McpResource, McpTool } from "./types.js";

export interface InspectionReport {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
  instructions?: string;
  tools: SectionResult<McpTool>;
  resources: SectionResult<McpResource>;
  prompts: SectionResult<McpPrompt>;
  /** Wall-clock for the three list calls combined; surfaced as the server's "p95-ish" latency in the browser. */
  elapsedMs: number;
}

export type SectionResult<T> =
  | { supported: true; items: T[] }
  | { supported: false; reason: string };

/** Caller owns initialize() / close() — keeps this pure so tests can feed a FakeMcpTransport. */
export async function inspectMcpServer(client: McpClient): Promise<InspectionReport> {
  const t0 = Date.now();
  // Always try all three listings — some servers omit capability flags but still serve the methods.
  const tools = await trySection<McpTool>(() => client.listTools().then((r) => r.tools));
  const resources = await trySection<McpResource>(() =>
    client.listResources().then((r) => r.resources),
  );
  const prompts = await trySection<McpPrompt>(() => client.listPrompts().then((r) => r.prompts));

  return {
    protocolVersion: client.protocolVersion || "(unknown)",
    serverInfo: client.serverInfo,
    capabilities: client.serverCapabilities ?? {},
    instructions: client.serverInstructions,
    tools,
    resources,
    prompts,
    elapsedMs: Date.now() - t0,
  };
}

async function trySection<T>(load: () => Promise<T[]>): Promise<SectionResult<T>> {
  try {
    const items = await load();
    return { supported: true, items };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // -32601 is JSON-RPC "method not found" — the canonical response
    // from a server that doesn't implement this family. Treat it as
    // "not supported" rather than a hard error, so the CLI can render
    // a clean summary instead of aborting on the first missing method.
    if (/-32601/.test(msg) || /method not found/i.test(msg)) {
      return { supported: false, reason: "method not found (-32601)" };
    }
    return { supported: false, reason: msg };
  }
}
