// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type AssistantSegment, applyIncoming, reduce } from "./App";
import type { IncomingEvent } from "./protocol";
import { ToolCard } from "./ui/cards";

afterEach(cleanup);

type State = Parameters<typeof applyIncoming>[0];
const initial = () =>
  ({
    messages: [],
    sessionFiles: [],
    expandedTurns: [],
    usage: {},
    transientStatus: null,
  }) as unknown as State;
const base = { id: 1, ts: "2026-10-08T00:00:00Z", turn: 1 };
const event = (value: object) => ({ ...base, ...value }) as IncomingEvent;
const tools = (state: State) =>
  state.messages.flatMap((message) =>
    message.kind === "assistant"
      ? message.segments.filter(
          (segment): segment is AssistantSegment & { kind: "tool" } => segment.kind === "tool",
        )
      : [],
  );

describe("shared Desktop and Web tool preparation", { retry: 0 }, () => {
  it("updates a fragmented tool name without creating another card", () => {
    let state = applyIncoming(initial(), event({ type: "model.turn.started", model: "fake" }));
    state = applyIncoming(state, event({ type: "tool.preparing", callId: "name:0", name: "read_", toolCallArgsChars: 0 }));
    state = applyIncoming(state, event({ type: "tool.progress", callId: "name:0", name: "read_file", toolCallArgsChars: 0 }));
    expect(tools(state)).toMatchObject([{ name: "read_file", phase: "preparing" }]);
    state = applyIncoming(state, event({ type: "tool.intent", callId: "name:0", name: "read_file_final", args: "{}" }));
    expect(tools(state)).toMatchObject([{ name: "read_file_final", phase: "running" }]);
  });
  it("settles tool cards on core exit without claiming an unconfirmed execution succeeded", () => {
    let state = applyIncoming(initial(), event({ type: "model.turn.started", model: "fake" }));
    for (const callId of ["exit:preparing", "exit:running"])
      state = applyIncoming(state, event({ type: "tool.preparing", callId, name: "write_file" }));
    state = applyIncoming(state, event({ type: "tool.intent", callId: "exit:running", name: "write_file", args: "{}" }));
    state = reduce(state, { t: "rpc_exit", code: 1 });
    expect(tools(state)).toMatchObject([
      { terminalState: "dropped", ok: false, result: expect.any(String) },
      { terminalState: "failed", ok: false, result: expect.stringMatching(/unknown|未知/) },
    ]);
    expect(state.busy).toBe(false);
    const settled = state;
    state = applyIncoming(state, event({ type: "tool.progress", callId: "exit:running", name: "write_file", toolCallArgsChars: 10 }));
    expect(state).toBe(settled);
  });
  it("keeps per-call progress distinct and does not reopen terminal cards", () => {
    let state = applyIncoming(initial(), event({ type: "model.turn.started", model: "fake" }));
    for (const callId of ["request-a:0", "request-a:1"])
      state = applyIncoming(
        state,
        event({ type: "tool.preparing", callId, name: "read_file", toolCallArgsChars: 10 }),
      );
    state = applyIncoming(
      state,
      event({
        type: "tool.progress",
        callId: "request-a:1",
        name: "read_file",
        phase: "preparing",
        toolCallArgsChars: 150000,
      }),
    );
    expect(
      tools(state).map((tool) => (tool as unknown as { argsChars: number }).argsChars),
    ).toEqual([10, 150000]);
    state = applyIncoming(
      state,
      event({
        type: "tool.result",
        callId: "request-a:1",
        output: "cancelled",
        ok: false,
        terminalState: "cancelled",
        executed: false,
      }),
    );
    const settled = state;
    for (const type of ["tool.progress", "tool.preparing", "tool.intent"])
      state = applyIncoming(
        state,
        event({
          type,
          callId: "request-a:1",
          name: "read_file",
          args: "{}",
          toolCallArgsChars: 200000,
        }),
      );
    expect(state).toBe(settled);
    state = applyIncoming(
      state,
      event({
        type: "tool.intent",
        callId: "request-a:0",
        name: "read_file",
        args: '{"path":"a"}',
      }),
    );
    expect(tools(state)[0]).toMatchObject({ phase: "running", args: '{"path":"a"}' });
    expect(tools(state)[1]).toMatchObject({ terminalState: "cancelled" });
  });

  it("ignores old cumulative counters and closes unfinished cards when a turn stops", () => {
    let state = applyIncoming(initial(), event({ type: "model.turn.started", model: "fake" }));
    state = applyIncoming(
      state,
      event({
        type: "tool.preparing",
        callId: "request-b:0",
        name: "read_file",
        toolCallArgsChars: 40,
      }),
    );
    state = applyIncoming(
      state,
      event({
        type: "tool.progress",
        callId: "request-b:0",
        name: "read_file",
        phase: "preparing",
        toolCallArgsChars: 20,
      }),
    );
    expect(tools(state)[0]).toMatchObject({ argsChars: 40 });
    state = applyIncoming(state, event({ type: "$turn_complete" }));
    expect(tools(state)[0]).toMatchObject({
      result: expect.any(String),
      terminalState: "cancelled",
    });
  });

  it("shows preparation and numeric progress without partial arguments", () => {
    render(<ToolCard name="write_file" phase="preparing" argsChars={150000} defaultOpen />);
    expect(screen.getByText(/150,000/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Preparing" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("args{");
  });
});
