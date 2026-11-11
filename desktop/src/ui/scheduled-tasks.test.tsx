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
