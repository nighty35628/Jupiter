import { describe, expect, it } from "vitest";
import {
  formatRunJsonEvent,
  runDoneJsonEvent,
  runJsonEventsFromLoopEvent,
} from "../src/cli/commands/run.js";
import { Usage } from "../src/client.js";
import type { LoopEvent } from "../src/loop.js";

const now = () => "2026-06-18T01:00:00.000Z";

const ev = (partial: Partial<LoopEvent>): LoopEvent =>
  ({ turn: 1, role: "status", content: "", ...partial }) as LoopEvent;

describe("run JSONL events", () => {
  it("maps assistant deltas with reasoning", () => {
    expect(
      runJsonEventsFromLoopEvent(
        ev({ role: "assistant_delta", content: "hello", reasoningDelta: "thinking" }),
        now,
      ),
    ).toEqual([
      {
        type: "assistant_delta",
        timestamp: "2026-06-18T01:00:00.000Z",
        turn: 1,
        content: "hello",
        reasoningDelta: "thinking",
      },
    ]);
  });

  it("maps final answer and usage as separate stable records", () => {
    const usage = new Usage(100, 20, 120, 80, 20);
    const records = runJsonEventsFromLoopEvent(
      ev({
        role: "assistant_final",
        content: "done",
        stats: {
          turn: 1,
          model: "deepseek-v4-flash",
          usage,
          cost: 0.001,
          cacheHitRatio: 0.8,
        },
      }),
      now,
    );

    expect(records[0]).toMatchObject({
      type: "assistant_final",
      turn: 1,
      content: "done",
    });
    expect(records[1]).toEqual({
      type: "usage",
      timestamp: "2026-06-18T01:00:00.000Z",
      turn: 1,
      model: "deepseek-v4-flash",
      costUsd: 0.001,
      cacheHitRatio: 0.8,
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cacheHitTokens: 80,
        cacheMissTokens: 20,
      },
    });
  });

  it("maps tool start and result records", () => {
    expect(
      runJsonEventsFromLoopEvent(
        ev({
          role: "tool_start",
          callId: "tool-1",
          toolName: "run_command",
          toolArgs: '{"cmd":"ls"}',
        }),
        now,
      ),
    ).toEqual([
      {
        type: "tool_start",
        timestamp: "2026-06-18T01:00:00.000Z",
        turn: 1,
        callId: "tool-1",
        name: "run_command",
        args: '{"cmd":"ls"}',
      },
    ]);

    expect(
      runJsonEventsFromLoopEvent(
        ev({ role: "tool", callId: "tool-1", toolName: "run_command", content: "ok" }),
        now,
      ),
    ).toEqual([
      {
        type: "tool_result",
        timestamp: "2026-06-18T01:00:00.000Z",
        turn: 1,
        callId: "tool-1",
        name: "run_command",
        output: "ok",
      },
    ]);
  });

  it("redacts sensitive tool args and tool output fields", () => {
    const start = runJsonEventsFromLoopEvent(
      ev({
        role: "tool_start",
        callId: "tool-1",
        toolName: "web_fetch",
        toolArgs:
          '{"url":"https://example.com","apiKey":"sk-secret","headers":{"Authorization":"Bearer abc123"}}',
      }),
      now,
    )[0]!;
    expect(start).toMatchObject({
      type: "tool_start",
      args: '{"url":"https://example.com","apiKey":"[redacted]","headers":{"Authorization":"[redacted]"}}',
    });

    const result = runJsonEventsFromLoopEvent(
      ev({
        role: "tool",
        callId: "tool-1",
        toolName: "web_fetch",
        content: "Authorization: Bearer abc123\npassword=hunter2\nok",
      }),
      now,
    )[0]!;
    expect(result).toMatchObject({
      type: "tool_result",
      output: "Authorization: [redacted]\npassword=[redacted]\nok",
    });
  });

  it("formats final done summary as JSON", () => {
    const done = runDoneJsonEvent(
      {
        turns: 1,
        totalCostUsd: 0.001,
        totalInputCostUsd: 0.0005,
        totalOutputCostUsd: 0.0005,
        claudeEquivalentUsd: 0.01,
        savingsVsClaudePct: 90,
        cacheHitRatio: 0.8,
        lastPromptTokens: 100,
        lastTurnCostUsd: 0.001,
      },
      "run.jsonl",
      now,
    );

    const parsed = JSON.parse(formatRunJsonEvent(done));
    expect(parsed).toEqual({
      type: "done",
      timestamp: "2026-06-18T01:00:00.000Z",
      summary: {
        turns: 1,
        totalCostUsd: 0.001,
        cacheHitRatio: 0.8,
        lastPromptTokens: 100,
        lastTurnCostUsd: 0.001,
      },
      transcript: "run.jsonl",
    });
  });
});
