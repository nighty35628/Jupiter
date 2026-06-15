import { COMPACTION_SUMMARY_MARKER } from "@jupiter/core-utils";
import { describe, expect, it } from "vitest";
import { Usage } from "../src/client.js";
import { computeContextDiagnostics } from "../src/telemetry/context-diagnostics.js";
import type { ChatMessage, ToolSpec } from "../src/types.js";

describe("context diagnostics", () => {
  it("counts prompt categories, cache stats, and top tool result hot spots", () => {
    const toolSpecs: ToolSpec[] = [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read files",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "run_command",
          description: "Run commands",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "I will inspect it",
        tool_calls: [{ type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", name: "read_file", content: "large file output ".repeat(200) },
      {
        role: "assistant",
        content: `${COMPACTION_SUMMARY_MARKER}summary text`,
      },
    ];
    const diagnostics = computeContextDiagnostics({
      systemPrompt: [
        "# User memory",
        "prefers concise answers",
        "# Project memory",
        "Jupiter repo",
        "---",
        "normal system text",
      ].join("\n"),
      toolSpecs,
      messages,
      model: "deepseek-v4-flash",
      summary: {
        turns: 1,
        totalCostUsd: 0.001,
        cacheHitRatio: 0.9,
        lastPromptTokens: 15000,
      },
      lastUsage: new Usage(15000, 50, 15050, 14000, 1000),
    });

    expect(diagnostics.systemTokens).toBeGreaterThan(0);
    expect(diagnostics.toolsTokens).toBeGreaterThan(0);
    expect(diagnostics.logTokens).toBeGreaterThan(0);
    expect(diagnostics.memoryTokens).toBeGreaterThan(0);
    expect(diagnostics.summaryTokens).toBeGreaterThan(0);
    expect(diagnostics.topTools[0]?.name).toBe("read_file");
    expect(diagnostics.lastPromptTokens).toBe(15000);
    expect(diagnostics.lastCacheHitTokens).toBe(14000);
    expect(diagnostics.lastCacheMissTokens).toBe(1000);
    expect(diagnostics.sessionCacheHitRatio).toBe(0.9);
    expect(diagnostics.totalCostUsd).toBe(0.001);
    expect(diagnostics.turns).toBe(1);
  });
});
