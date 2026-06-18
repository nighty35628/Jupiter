import type { WriteStream } from "node:fs";
import { stderr, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  bridgeEndpointEnv,
  defaultConfigPath,
  isPlausibleKey,
  loadApiKey,
  loadEndpoint,
  loadMaxIterPerTurn,
  loadToolRateLimit,
  normalizeMcpConfig,
  readConfig,
  saveApiKey,
} from "../../config.js";
import {
  redactEventJsonString,
  redactEventText,
  redactEventValue,
} from "../../core/event-redaction.js";
import { loadDotenv } from "../../env.js";
import { t } from "../../i18n/index.js";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../../index.js";
import type { LoopEvent } from "../../loop.js";
import { McpClient } from "../../mcp/client.js";
import { preflightStdioSpec } from "../../mcp/preflight.js";
import { bridgeMcpTools } from "../../mcp/registry.js";
import { buildTransportFromSpec } from "../../mcp/transport-from-spec.js";
import type { SessionSummary, TurnStats } from "../../telemetry/stats.js";
import { appendUsage } from "../../telemetry/usage.js";
import { ToolRegistry } from "../../tools.js";
import { openTranscriptFile, recordFromLoopEvent, writeRecord } from "../../transcript/log.js";
import { formatMcpLifecycleEvent } from "../ui/mcp-lifecycle.js";
import { formatMcpSlowToast } from "../ui/mcp-toast.js";

export type RunOutputFormat = "text" | "json";

export interface RunOptions {
  task: string;
  model: string;
  system: string;
  budgetUsd?: number;
  /** JSONL transcript path — lets `jupiter replay` / `diff` audit this run. */
  transcript?: string;
  /** Zero or more MCP server specs. Each: `"name=cmd args..."` or `"cmd args..."`. */
  mcp?: string[];
  /** Global prefix — only honored when a single anonymous server is given. */
  mcpPrefix?: string;
  format?: RunOutputFormat;
}

export type RunJsonEvent =
  | {
      type: "session_start";
      timestamp: string;
      model: string;
      task: string;
      prefixHash: string;
      transcript?: string;
    }
  | {
      type: "assistant_delta";
      timestamp: string;
      turn: number;
      content: string;
      reasoningDelta?: string;
    }
  | {
      type: "assistant_final";
      timestamp: string;
      turn: number;
      content: string;
      reasoningContent?: string;
      forcedSummary?: boolean;
    }
  | {
      type: "tool_start";
      timestamp: string;
      turn: number;
      callId?: string;
      name?: string;
      args?: string;
    }
  | {
      type: "tool_result";
      timestamp: string;
      turn: number;
      callId?: string;
      name?: string;
      output: string;
    }
  | {
      type: "tool_call_delta";
      timestamp: string;
      turn: number;
      callId?: string;
      name?: string;
      toolCallIndex?: number;
      argsChars?: number;
      readyCount?: number;
    }
  | {
      type: "usage";
      timestamp: string;
      turn: number;
      model: string;
      costUsd: number;
      cacheHitRatio: number;
      usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cacheHitTokens: number;
        cacheMissTokens: number;
      };
    }
  | {
      type: "status" | "warning" | "steer";
      timestamp: string;
      turn: number;
      content: string;
      severity?: "low" | "high";
    }
  | {
      type: "error";
      timestamp: string;
      turn: number;
      message: string;
      detail?: LoopEvent["errorDetail"];
    }
  | {
      type: "done";
      timestamp: string;
      summary: {
        turns: number;
        totalCostUsd: number;
        cacheHitRatio: number;
        lastPromptTokens: number;
        lastTurnCostUsd: number;
      };
      transcript?: string;
    };

function jsonTimestamp(): string {
  return new Date().toISOString();
}

function statsUsage(stats: TurnStats): Extract<RunJsonEvent, { type: "usage" }>["usage"] {
  return {
    promptTokens: stats.usage.promptTokens,
    completionTokens: stats.usage.completionTokens,
    totalTokens: stats.usage.totalTokens,
    cacheHitTokens: stats.usage.promptCacheHitTokens,
    cacheMissTokens: stats.usage.promptCacheMissTokens,
  };
}

export function runJsonEventsFromLoopEvent(
  ev: LoopEvent,
  now: () => string = jsonTimestamp,
): RunJsonEvent[] {
  const timestamp = now();
  switch (ev.role) {
    case "assistant_delta":
      if (!ev.content && !ev.reasoningDelta) return [];
      return [
        {
          type: "assistant_delta",
          timestamp,
          turn: ev.turn,
          content: redactEventText(ev.content),
          ...(ev.reasoningDelta ? { reasoningDelta: redactEventText(ev.reasoningDelta) } : {}),
        },
      ];
    case "assistant_final": {
      const events: RunJsonEvent[] = [
        {
          type: "assistant_final",
          timestamp,
          turn: ev.turn,
          content: redactEventText(ev.content),
          ...(ev.reasoningContent
            ? { reasoningContent: redactEventText(ev.reasoningContent) }
            : {}),
          ...(ev.forcedSummary ? { forcedSummary: true } : {}),
        },
      ];
      if (ev.stats) {
        events.push({
          type: "usage",
          timestamp,
          turn: ev.turn,
          model: ev.stats.model,
          costUsd: ev.stats.cost,
          cacheHitRatio: ev.stats.cacheHitRatio,
          usage: statsUsage(ev.stats),
        });
      }
      return events;
    }
    case "tool_start":
      return [
        {
          type: "tool_start",
          timestamp,
          turn: ev.turn,
          ...(ev.callId ? { callId: ev.callId } : {}),
          ...(ev.toolName ? { name: ev.toolName } : {}),
          ...(ev.toolArgs ? { args: redactEventJsonString(ev.toolArgs) } : {}),
        },
      ];
    case "tool":
      return [
        {
          type: "tool_result",
          timestamp,
          turn: ev.turn,
          ...(ev.callId ? { callId: ev.callId } : {}),
          ...(ev.toolName ? { name: ev.toolName } : {}),
          output: redactEventText(ev.content),
        },
      ];
    case "tool_call_delta":
      return [
        {
          type: "tool_call_delta",
          timestamp,
          turn: ev.turn,
          ...(ev.callId ? { callId: ev.callId } : {}),
          ...(ev.toolName ? { name: ev.toolName } : {}),
          ...(ev.toolCallIndex !== undefined ? { toolCallIndex: ev.toolCallIndex } : {}),
          ...(ev.toolCallArgsChars !== undefined ? { argsChars: ev.toolCallArgsChars } : {}),
          ...(ev.toolCallReadyCount !== undefined ? { readyCount: ev.toolCallReadyCount } : {}),
        },
      ];
    case "error":
      return [
        {
          type: "error",
          timestamp,
          turn: ev.turn,
          message: redactEventText(ev.error ?? ev.content),
          ...(ev.errorDetail ? { detail: redactEventValue(ev.errorDetail) } : {}),
        },
      ];
    case "status":
    case "warning":
    case "steer":
      return [
        {
          type: ev.role,
          timestamp,
          turn: ev.turn,
          content: redactEventText(ev.content),
          ...(ev.severity ? { severity: ev.severity } : {}),
        },
      ];
    case "done":
      return [];
  }
}

export function runDoneJsonEvent(
  summary: SessionSummary,
  transcript?: string,
  now: () => string = jsonTimestamp,
): RunJsonEvent {
  return {
    type: "done",
    timestamp: now(),
    summary: {
      turns: summary.turns,
      totalCostUsd: summary.totalCostUsd,
      cacheHitRatio: summary.cacheHitRatio,
      lastPromptTokens: summary.lastPromptTokens,
      lastTurnCostUsd: summary.lastTurnCostUsd,
    },
    ...(transcript ? { transcript } : {}),
  };
}

export function formatRunJsonEvent(event: RunJsonEvent): string {
  return JSON.stringify(event);
}

function writeRunJsonEvent(event: RunJsonEvent): void {
  process.stdout.write(`${formatRunJsonEvent(event)}\n`);
}

async function ensureApiKey(opts: { structuredStdout?: boolean } = {}): Promise<string> {
  const existing = loadApiKey();
  if (existing) return existing;

  if (!stdin.isTTY) {
    process.stderr.write(t("run.missingApiKey"));
    process.exit(1);
  }

  const promptOutput = opts.structuredStdout ? stderr : stdout;
  promptOutput.write(
    "DeepSeek API key not configured.\nGet one at https://platform.deepseek.com/api_keys\n",
  );
  const rl = createInterface({ input: stdin, output: promptOutput });
  try {
    while (true) {
      const answer = (await rl.question("API key › ")).trim();
      if (!answer) continue;
      if (!isPlausibleKey(answer)) {
        promptOutput.write("Key looks too short. Paste the full token (16+ chars, no spaces).\n");
        continue;
      }
      saveApiKey(answer);
      promptOutput.write(`Saved to ${defaultConfigPath()}\n\n`);
      return answer;
    }
  } finally {
    rl.close();
  }
}

export async function runCommand(opts: RunOptions): Promise<void> {
  loadDotenv();
  const format = opts.format ?? "text";
  await ensureApiKey({ structuredStdout: format === "json" });
  bridgeEndpointEnv();

  // Optional MCP setup — mirrors chat's flow. Must happen before loop
  // construction so the tools make it into the prefix.
  const cfg = readConfig();
  const normalizedSpecs = normalizeMcpConfig(
    cfg,
    opts.mcp && opts.mcp.length > 0 ? opts.mcp : undefined,
  );
  const clients: McpClient[] = [];
  let tools: ToolRegistry | undefined;
  let successCount = 0;
  const workspaceDir = process.cwd();
  if (normalizedSpecs.length > 0) {
    tools = new ToolRegistry({ rateLimit: loadToolRateLimit() });
    for (const spec of normalizedSpecs) {
      let label = "anon";
      let mcp: McpClient | undefined;
      try {
        label = spec.name ?? "anon";
        if (spec.disabled) {
          process.stderr.write(`${formatMcpLifecycleEvent({ state: "disabled", name: label })}\n`);
          continue;
        }
        process.stderr.write(`${formatMcpLifecycleEvent({ state: "handshake", name: label })}\n`);
        const t0 = Date.now();
        const prefix = spec.name
          ? `${spec.name}_`
          : normalizedSpecs.length === 1 && opts.mcpPrefix
            ? opts.mcpPrefix
            : "";
        if (spec.transport === "stdio") preflightStdioSpec(spec);
        const transport = buildTransportFromSpec(spec, { cwd: workspaceDir });
        mcp = new McpClient({ transport, workspaceDir, requestTimeoutMs: spec.requestTimeoutMs });
        await mcp.initialize();
        const bridge = await bridgeMcpTools(mcp, {
          registry: tools,
          namePrefix: prefix,
          serverName: label,
          onSlow: (info) =>
            process.stderr.write(
              `${formatMcpSlowToast({ name: info.serverName, p95Ms: info.p95Ms, sampleSize: info.sampleSize })}\n`,
            ),
        });
        process.stderr.write(
          `${formatMcpLifecycleEvent({
            state: "connected",
            name: label,
            tools: bridge.registeredNames.length,
            ms: Date.now() - t0,
          })}\n`,
        );
        clients.push(mcp);
        successCount++;
      } catch (err) {
        // Non-fatal — skip and continue, same as `jupiter chat`. A
        // one-shot `run` invocation with a broken MCP server otherwise
        // fails the whole run over a side-concern tool the task might
        // not even touch.
        await mcp?.close().catch(() => undefined);
        process.stderr.write(
          `${formatMcpLifecycleEvent({ state: "failed", name: label, reason: (err as Error).message })}\n  ${t("mcpLifecycle.failedSetupConfigHint")}\n`,
        );
      }
    }
    if (successCount === 0) tools = undefined;
  }

  const ep = loadEndpoint();
  const client = new DeepSeekClient({ apiKey: ep.apiKey, baseUrl: ep.baseUrl });
  const prefix = new ImmutablePrefix({
    system: opts.system,
    toolSpecs: tools?.specs(),
  });
  const loop = new CacheFirstLoop({
    client,
    prefix,
    tools,
    model: opts.model,
    budgetUsd: opts.budgetUsd,
    maxIterPerTurn: loadMaxIterPerTurn(),
  });
  const prefixHash = prefix.fingerprint;
  if (format === "json") {
    writeRunJsonEvent({
      type: "session_start",
      timestamp: jsonTimestamp(),
      model: opts.model,
      task: redactEventText(opts.task),
      prefixHash,
      ...(opts.transcript ? { transcript: opts.transcript } : {}),
    });
  }

  let transcriptStream: WriteStream | null = null;
  if (opts.transcript) {
    transcriptStream = openTranscriptFile(opts.transcript, {
      version: 1,
      source: "jupiter run",
      model: opts.model,
      startedAt: new Date().toISOString(),
    });
    // Also persist the user turn itself (the loop's event stream starts with
    // assistant output, not the prompt we're about to send).
    writeRecord(transcriptStream, {
      ts: new Date().toISOString(),
      turn: 1,
      role: "user",
      content: redactEventText(opts.task),
    });
  }

  try {
    for await (const ev of loop.step(opts.task)) {
      if (format === "json") {
        for (const event of runJsonEventsFromLoopEvent(ev)) writeRunJsonEvent(event);
      } else {
        if (ev.role === "assistant_delta" && ev.content) process.stdout.write(ev.content);
        if (ev.role === "tool") process.stdout.write(`\n[tool ${ev.toolName}] ${ev.content}\n`);
        if (ev.role === "error") process.stderr.write(`\n[error] ${ev.error}\n`);
        if (ev.role === "done") process.stdout.write("\n");
      }
      if (ev.role === "assistant_final" && ev.stats?.usage) {
        // `jupiter run` is often used in CI / scripting — we want
        // those turns to show up in `jupiter stats` too so the
        // dashboard reflects all DeepSeek spend, not just TUI sessions.
        appendUsage({ session: null, model: ev.stats.model, usage: ev.stats.usage });
      }
      // Persist every non-streaming event — deltas would flood the file and
      // aren't useful for replay (replay renders final content, not keystrokes).
      if (transcriptStream && ev.role !== "assistant_delta") {
        writeRecord(transcriptStream, recordFromLoopEvent(ev, { model: opts.model, prefixHash }));
      }
    }
  } finally {
    transcriptStream?.end();
  }

  const s = loop.stats.summary();
  if (format === "json") {
    writeRunJsonEvent(runDoneJsonEvent(s, opts.transcript));
  } else {
    process.stdout.write(
      `\n— turns:${s.turns} cache:${(s.cacheHitRatio * 100).toFixed(1)}% ` +
        `cost:$${s.totalCostUsd.toFixed(6)} save-vs-claude:${s.savingsVsClaudePct.toFixed(1)}%\n`,
    );
    if (opts.transcript) {
      process.stdout.write(`\ntranscript: ${opts.transcript}\n`);
      process.stdout.write(`  → npx jupiter replay ${opts.transcript}\n`);
    }
  }

  for (const c of clients) await c.close();
}
