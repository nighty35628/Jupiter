import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildLoadedMessages } from "../src/cli/commands/desktop.js";
import { isHistoryReadCommand } from "../src/web/history-read.js";

describe("paged history identity", () => {
  const source = readFileSync(new URL("../src/cli/commands/desktop.ts", import.meta.url), "utf8");
  function branch(condition: string, start = 0): string {
    const file = ts.createSourceFile("desktop.ts", source, ts.ScriptTarget.Latest, true);
    let found = "";
    function visit(node: ts.Node) {
      if (
        !found &&
        node.pos >= start &&
        ts.isIfStatement(node) &&
        node.expression.getText(file) === condition
      )
        found = node.thenStatement.getText(file);
      ts.forEachChild(node, visit);
    }
    visit(file);
    expect(found).not.toBe("");
    return ts.transpileModule(found, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
      .outputText;
  }

  it("rebuilds a fresh runtime after a session load writer conflict before announcing ready", () => {
    const body = branch(
      "isSessionWriterConflict(err)",
      source.indexOf('if (msg.cmd === "session_load")'),
    );
    const tab = { runtime: null as null | object };
    const events: { type: string }[] = [];
    const run = new Function(
      "tab",
      "rotateTabToFreshSession",
      "replaceRuntimeFor",
      "bridgeTabMcp",
      "emit",
      "emitBalance",
      "emitCtxBreakdown",
      "msg",
      "desktopRuntimeUnavailableMessage",
      body,
    );
    run(
      tab,
      () => "previous",
      () => {
        tab.runtime = {};
      },
      () => {},
      (event: { type: string }) => events.push(event),
      () => {},
      () => {},
      { name: "locked" },
      () => "unavailable",
    );
    expect(tab.runtime).not.toBeNull();
    expect(events.some((event) => event.type === "$ready")).toBe(true);
  });

  it("expands a bounded original turn without applying the preview budget again", async () => {
    const body = branch('msg.cmd === "session_turn_load"');
    const records = [
      { role: "user" as const, content: "question" },
      { role: "assistant" as const, content: "x".repeat(200_000) },
    ];
    const events: any[] = [];
    const run = new Function(
      "tab",
      "msg",
      "emit",
      "readSessionHistoryTurn",
      "emitCurrentSessionLoaded",
      "buildLoadedMessages",
      `return (async () => ${body})()`,
    );
    await run(
      { currentSession: "s", bindingId: 1, sessionId: "sid" },
      { name: "s", turn: 1 },
      (event: unknown) => events.push(event),
      async () => ({ records, startTurn: 0, generation: "g1" }),
      () => {},
      buildLoadedMessages,
    );
    expect(events[0].messages[1].segments[0].text).toHaveLength(200_000);
    expect(events[0].messages[1].displayTruncated).not.toBe(true);
  });

  it.each(["before", "during"])(
    "refuses rollback when a turn is running %s history validation",
    async (when) => {
      const body = branch('msg.cmd === "rollback_to_turn"');
      let rollbacks = 0;
      const tab = {
        runtime: {
          loop: {
            rollbackToTurn: () => {
              rollbacks++;
              return true;
            },
          },
        },
        turnAdmission: { running: when === "before" },
        bindingId: 1,
        currentSession: "s",
      };
      const run = new Function(
        "tab",
        "msg",
        "emit",
        "getSessionHistoryGeneration",
        "emitCurrentSessionLoaded",
        "emitCtxBreakdown",
        `return (async () => ${body})()`,
      );
      await run(
        tab,
        { turn: 2, role: "user", historyGeneration: "g1" },
        () => {},
        async () => {
          tab.turnAdmission.running = true;
          return "g1";
        },
        () => {},
        () => {},
      );
      expect(rollbacks).toBe(0);
    },
  );

  it("uses absolute turns and rollback references instead of page positions", () => {
    const messages = buildLoadedMessages(
      [
        { role: "user", content: "question 81" },
        { role: "assistant", content: "answer 81" },
        { role: "user", content: "question 82" },
      ],
      { startTurn: 80 },
    );
    expect(messages.map((m) => m.turn)).toEqual([81, 81, 82]);
    expect(messages[0]).toMatchObject({
      messageId: "u-81",
      rollbackRef: { turn: 81, role: "user" },
    });
    expect(messages[1]).toMatchObject({
      messageId: "a-81",
      rollbackRef: { turn: 81, role: "assistant" },
    });
  });

  it("never grants a write command read-only transport privileges", () => {
    const identity = {
      name: "history",
      sessionId: "session-id",
      bindingId: 2,
      requestId: "read-1",
    };
    expect(isHistoryReadCommand({ ...identity, cmd: "session_history_page" })).toBe(true);
    expect(isHistoryReadCommand({ ...identity, cmd: "session_turn_load", turn: 2 })).toBe(true);
    for (const cmd of [
      "session_load",
      "rollback_to_turn",
      "user_input",
      "session_delete",
      "settings_save",
    ])
      expect(isHistoryReadCommand({ ...identity, cmd })).toBe(false);
    expect(isHistoryReadCommand({ cmd: "session_history_page", name: "history" })).toBe(false);
    expect(isHistoryReadCommand({ ...identity, cmd: "session_turn_load", turn: -1 })).toBe(false);
  });
});
