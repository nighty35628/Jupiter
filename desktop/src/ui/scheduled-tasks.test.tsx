// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ScheduledCommand,
  ScheduledTask,
  ScheduledTasksEvent,
} from "../../../src/scheduler/types";
import { setLang } from "../i18n";
import { PageScheduledTasks, type ScheduledTasksProps } from "./scheduled-tasks";

beforeEach(() => setLang("en"));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function fixture(overrides: Partial<ScheduledTasksProps> = {}) {
  const send = vi.fn(async (_command: ScheduledCommand) => {});
  const props: ScheduledTasksProps = {
    workspaceDir: "/qa",
    model: "synthetic",
    active: true,
    writable: true,
    send,
    onOpenSession: vi.fn(),
    result: { type: "$scheduled_tasks", workspaceDir: "/qa", requestId: "list", tasks: [] },
    ...overrides,
  };
  const view = render(<PageScheduledTasks {...props} />);
  return { ...view, props, send };
}
function draft() {
  fireEvent.click(screen.getByRole("button", { name: "New task" }));
  fireEvent.change(screen.getByLabelText("Name", { exact: true }), {
    target: { value: "Daily review" },
  });
  fireEvent.change(screen.getByLabelText("Task prompt"), {
    target: { value: "Review synthetic changes" },
  });
}

describe("scheduled task settings", { retry: 0 }, () => {
  it("saves goal criteria, scope, effort and explicit desktop permission", () => {
    const f = fixture();
    draft();
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "agent" } });
    fireEvent.change(screen.getByLabelText("Reasoning effort"), { target: { value: "max" } });
    fireEvent.click(screen.getByLabelText(/Goal task/));
    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "Finish report" } });
    fireEvent.change(screen.getByLabelText(/Completion criteria/), {
      target: { value: "File exists\nChecks pass" },
    });
    fireEvent.change(screen.getByLabelText("Allowed scope"), {
      target: { value: "Workspace only" },
    });
    fireEvent.click(screen.getByLabelText(/Allow Computer Use/));
    fireEvent.submit(screen.getByRole("form", { name: "Edit task" }));
    const command = f.send.mock.calls
      .map(([item]) => item)
      .find((item) => item.cmd === "scheduled_save");
    expect(command?.cmd === "scheduled_save" && command.task).toMatchObject({
      reasoningEffort: "max",
      computerUse: true,
      goal: {
        objective: "Finish report",
        completionCriteria: ["File exists", "Checks pass"],
        allowedScope: "Workspace only",
      },
    });
  });

  it("shows live progress with pause, cancellation and schedule editing while running", () => {
    const task: ScheduledTask = {
      id: "qa",
      revision: 2,
      title: "QA",
      prompt: "Report",
      mode: "agent",
      model: "synthetic",
      editMode: "review",
      timeoutMinutes: 30,
      workspaceDir: "/qa",
      createdAt: 1,
      schedule: { kind: "daily", time: "09:00", timezone: "Asia/Shanghai" },
      enabled: true,
      nextRunAt: Date.now(),
      runs: [
        {
          id: "run",
          status: "running",
          startedAt: Date.now() - 10000,
          ownerPid: 1,
          progress: {
            updatedAt: Date.now(),
            currentStep: "Verify report",
            recentActions: [{ at: Date.now(), text: "read_file" }],
            checkpoints: [],
          },
        },
      ],
    };
    const f = fixture({
      result: { type: "$scheduled_tasks", workspaceDir: "/qa", requestId: "list", tasks: [task] },
    });
    expect(screen.getByRole("status").textContent).toContain("Verify report");
    expect(screen.getByRole("button", { name: "Pause: QA" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop run: QA" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit task: QA" }));
    fireEvent.change(screen.getByLabelText("Time", { exact: true }), {
      target: { value: "11:00" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Edit task" }));
    const command = f.send.mock.calls
      .map(([item]) => item)
      .find((item) => item.cmd === "scheduled_save");
    expect(command?.cmd === "scheduled_save" && command.task.schedule).toMatchObject({
      time: "11:00",
    });
  });
  it("creates a default Ask task, prevents double submit, and keeps edits until correlated acknowledgment", async () => {
    const f = fixture();
    draft();
    fireEvent.submit(screen.getByRole("form", { name: "Edit task" }));
    fireEvent.submit(screen.getByRole("form", { name: "Edit task" }));
    expect(f.send.mock.calls.filter(([c]) => c.cmd === "scheduled_save")).toHaveLength(1);
    const command = f.send.mock.calls.find(([c]) => c.cmd === "scheduled_save")![0] as Extract<
      ScheduledCommand,
      { cmd: "scheduled_save" }
    >;
    expect(command.task).toMatchObject({
      mode: "ask",
      editMode: "review",
      title: "Daily review",
      schedule: { kind: "daily" },
    });
    expect(command.task).not.toHaveProperty("workspaceDir");
    const response: ScheduledTasksEvent = {
      type: "$scheduled_tasks",
      workspaceDir: "/qa",
      requestId: command.requestId,
      tasks: [],
      error: "synthetic save error",
    };
    f.rerender(
      <PageScheduledTasks
        {...f.props}
        result={f.props.result}
        results={{ [response.requestId]: response }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("synthetic save error");
    expect((screen.getByLabelText("Name", { exact: true }) as HTMLInputElement).value).toBe(
      "Daily review",
    );
    await act(async () => {});
  });

  it("changes frequency and Agent permissions without carrying a hidden Ask budget", () => {
    fixture();
    draft();
    fireEvent.change(screen.getByLabelText("Schedule", { exact: true }), {
      target: { value: "weekly" },
    });
    expect(screen.getByLabelText("Weekday")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "agent" } });
    fireEvent.change(screen.getByLabelText("Permissions"), { target: { value: "yolo" } });
    expect(screen.getByText(/without confirmation/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Budget per run/), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "ask" } });
    expect(screen.queryByLabelText(/Budget per run/)).toBeNull();
  });

  it("keeps task management disabled on read-only Web without hiding results", () => {
    const task = {
      id: "qa",
      title: "QA",
      prompt: "hello",
      mode: "ask",
      model: "synthetic",
      schedule: { kind: "daily", time: "09:00", timezone: "Asia/Hong_Kong" },
      enabled: true,
      nextRunAt: Date.now(),
      runs: [
        {
          id: "run",
          status: "succeeded",
          startedAt: Date.now(),
          session: "qa-session",
          summary: "done",
        },
      ],
    } as ScheduledTask;
    const f = fixture({
      writable: false,
      result: { type: "$scheduled_tasks", workspaceDir: "/qa", requestId: "list", tasks: [task] },
    });
    expect((screen.getByRole("button", { name: "New task" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByText(/Run history/));
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(f.props.onOpenSession).toHaveBeenCalledWith("qa-session");
    expect(screen.getByText("done")).toBeTruthy();
  });

  it("stops polling when inactive and clears uncertain mutations after a bounded wait", async () => {
    vi.useFakeTimers();
    const f = fixture();
    draft();
    fireEvent.submit(screen.getByRole("form", { name: "Edit task" }));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByRole("alert").textContent).toMatch(/No confirmation/);
    f.rerender(<PageScheduledTasks {...f.props} active={false} />);
    const calls = f.send.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(f.send).toHaveBeenCalledTimes(calls);
  });
});
