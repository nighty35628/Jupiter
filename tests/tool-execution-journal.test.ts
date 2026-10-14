import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { loadSessionMessages } from "../src/memory/session.js";
import {
  ToolExecutionJournal,
  readToolExecutionJournal,
  toolExecutionJournalPath,
  toolExecutionOutcomeFromResult,
} from "../src/memory/tool-execution-journal.js";
import { ToolRegistry } from "../src/tools.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function journalPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "jupiter-tool-journal-"));
  dirs.push(dir);
  return join(dir, "session.tool-executions.v2.journal");
}

function journal(path: string, runId: string, ids: string[]): ToolExecutionJournal {
  let index = 0;
  return new ToolExecutionJournal({
    path,
    sessionId: "session-1",
    runId,
    randomId: () => ids[index++] ?? `generated-${index}`,
    now: () => new Date("2026-08-14T00:00:00.000Z"),
  });
}

describe("ToolExecutionJournal", () => {
  it.each(["returned", "unknown_after_restart"] as const)(
    "recovers a loop's provider-linked transcript after a lost tool result (%s)",
    { retry: 0 },
    async (outcome) => {
      const home = mkdtempSync(join(tmpdir(), "jupiter-loop-journal-"));
      dirs.push(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      vi.spyOn(require("node:os"), "homedir").mockReturnValue(home);
      const fn = vi.fn(() => "mock side effect completed");
      const tools = new ToolRegistry().register({ name: "mutate", description: "mock only", fn });
      const client = new DeepSeekClient({
        apiKey: "unit-test-only",
        baseUrl: "https://gateway.example/v1",
        fetch: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: "",
                      tool_calls: [
                        {
                          id: "provider-1",
                          type: "function",
                          function: { name: "mutate", arguments: "{}" },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
              }),
              { headers: { "Content-Type": "application/json" } },
            ),
        ),
      });
      const makeLoop = () =>
        new CacheFirstLoop({
          client,
          tools,
          model: "test",
          stream: false,
          session: "identity-recovery",
          prefix: new ImmutablePrefix({ system: "test", toolSpecs: tools.specs() }),
        });
      let loop: CacheFirstLoop | undefined;
      let restored: CacheFirstLoop | undefined;
      try {
        loop = makeLoop();
        const append = loop.appendAndPersist.bind(loop);
        vi.spyOn(loop, "appendAndPersist").mockImplementation((message) => {
          if (message.role === "tool") throw new Error("mock transcript write failed");
          return append(message);
        });
        if (outcome === "unknown_after_restart") {
          vi.spyOn(ToolExecutionJournal.prototype, "recordResult").mockImplementationOnce(() => {
            throw new Error("mock journal result write failed");
          });
        }
        let localCallId: string | undefined;
        await expect(
          (async () => {
            for await (const event of loop!.step("mock mutation")) {
              if (event.role === "tool_start") localCallId = event.callId;
            }
          })(),
        ).rejects.toThrow("mock transcript write failed");
        expect(localCallId).toMatch(/^request-.+:tool:0$/);
        expect(
          readToolExecutionJournal(toolExecutionJournalPath("identity-recovery"))[0]?.callId,
        ).toBe("provider-1");
        loop.dispose();
        restored = makeLoop();
        const messages = restored.log.toFullHistory();
        expect(messages.find((message) => message.role === "assistant")?.tool_calls?.[0]?.id).toBe(
          "provider-1",
        );
        expect(messages.find((message) => message.role === "tool")).toMatchObject({
          tool_call_id: "provider-1",
          content: expect.stringContaining(outcome),
        });
        expect(loadSessionMessages("identity-recovery")).toEqual(messages);
        expect(fn).toHaveBeenCalledTimes(1);
      } finally {
        loop?.dispose();
        restored?.dispose();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    },
  );

  it("recognizes transport uncertainty without treating it as a successful return", () => {
    expect(
      toolExecutionOutcomeFromResult(
        JSON.stringify({
          error: "transport lost",
          executionOutcome: "unknown_after_transport",
        }),
      ),
    ).toBe("unknown_after_transport");
    expect(
      toolExecutionOutcomeFromResult(JSON.stringify({ executionOutcome: "unknown_after_cancel" })),
    ).toBe("unknown_after_cancel");
    expect(toolExecutionOutcomeFromResult("plain tool output")).toBeUndefined();
  });

  it("recovers a started execution as unknown exactly once without retaining raw arguments", () => {
    const path = journalPath();
    const firstRun = journal(path, "run-1", ["execution-1"]);
    const executionId = firstRun.recordIntent({
      turn: 3,
      callId: "call-1",
      toolName: "run_command",
      args: JSON.stringify({ command: "deploy", api_key: "secret-value" }),
    });
    firstRun.recordExecutionStarted(executionId);

    const secondRun = journal(path, "run-2", []);
    expect(secondRun.recoverIncompleteExecutions()).toEqual([
      {
        executionId: "execution-1",
        sessionId: "session-1",
        turn: 3,
        callId: "call-1",
        toolName: "run_command",
        outcome: "unknown_after_restart",
      },
    ]);
    expect(secondRun.recoverIncompleteExecutions()).toEqual([]);

    const records = readToolExecutionJournal(path);
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3]);
    expect(records.map((record) => record.state)).toEqual([
      "intent",
      "execution_started",
      "result",
    ]);
    expect(records[2]).toMatchObject({ outcome: "unknown_after_restart", runId: "run-2" });
    expect(readFileSync(path, "utf8")).not.toContain("secret-value");
  });

  it("marks intent-only work as not started and repairs a dangling transcript", () => {
    const path = journalPath();
    const firstRun = journal(path, "run-1", ["execution-1"]);
    firstRun.recordIntent({
      turn: 1,
      callId: "call-1",
      toolName: "write_file",
      args: "{}",
    });

    const secondRun = journal(path, "run-2", []);
    expect(secondRun.recoverIncompleteExecutions()[0]?.outcome).toBe(
      "interrupted_before_execution",
    );
    const repaired = secondRun.repairDanglingToolCalls([
      { role: "user", content: "write it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "write_file", arguments: "{}" },
          },
        ],
      },
    ]);

    expect(repaired.repairedCount).toBe(1);
    expect(repaired.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call-1",
      name: "write_file",
    });
    expect(String(repaired.messages[2]?.content)).toContain("interrupted_before_execution");
  });

  it("records parallel completions in settlement order while keeping each invocation terminal", () => {
    const path = journalPath();
    const active = journal(path, "run-1", ["execution-a", "execution-b"]);
    const a = active.recordIntent({ turn: 2, callId: "call-a", toolName: "read_file", args: "{}" });
    const b = active.recordIntent({ turn: 2, callId: "call-b", toolName: "read_file", args: "{}" });
    active.recordExecutionStarted(a);
    active.recordExecutionStarted(b);
    active.recordResult(b, "returned", "b-result");
    active.recordResult(a, "returned", "a-result");

    const records = readToolExecutionJournal(path);
    expect(records.slice(-2).map((record) => record.executionId)).toEqual([
      "execution-b",
      "execution-a",
    ]);
    expect(journal(path, "run-2", []).recoverIncompleteExecutions()).toEqual([]);
  });

  it("ignores a partial crash tail and continues with a monotonic sequence", () => {
    const path = journalPath();
    const firstRun = journal(path, "run-1", ["execution-1"]);
    firstRun.recordIntent({ turn: 1, callId: "call-1", toolName: "read_file", args: "{}" });
    appendFileSync(path, '{"version":2,"partial"');

    const secondRun = journal(path, "run-2", ["execution-2"]);
    secondRun.recordIntent({ turn: 2, callId: "call-2", toolName: "read_file", args: "{}" });
    expect(readToolExecutionJournal(path).at(-1)?.seq).toBe(2);
  });
});

describe("ToolRegistry execution boundary", () => {
  it("does not enter the tool implementation when the durable start record fails", async () => {
    const fn = vi.fn(() => "should not run");
    const registry = new ToolRegistry().register({ name: "mutate", fn });

    const result = await registry.dispatch(
      "mutate",
      {},
      {
        onExecutionStarted: () => {
          throw new Error("journal disk full");
        },
      },
    );

    expect(fn).not.toHaveBeenCalled();
    expect(JSON.parse(result)).toEqual({ error: "Error: journal disk full" });
  });
});
