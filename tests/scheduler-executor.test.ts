import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createScheduledExecutor } from "../src/scheduler/executor.js";
import { scheduledExecutionKey } from "../src/scheduler/identity.js";
import type { ScheduledTask } from "../src/scheduler/types.js";

const execute = createScheduledExecutor(resolve("tests/fixtures/scheduled-rpc.mjs"));
const task = (prompt = "OK", mode: "ask" | "agent" = "ask"): ScheduledTask => ({
  id: "qa",
  title: "QA",
  prompt,
  workspaceDir: process.cwd(),
  model: "synthetic",
  mode,
  editMode: "review",
  enabled: false,
  timeoutMinutes: 1,
  schedule: { kind: "interval", minutes: 1 },
  revision: 1,
  createdAt: 0,
  nextRunAt: null,
  runs: [],
});
describe("isolated scheduled executor", { retry: 0 }, () => {
  it("restores the original paused session before submitting continuation work", async () => {
    const definition = task("continue work");
    const result = await execute(
      {
        ...definition,
        runs: [
          {
            id: "prior",
            startedAt: 1,
            ownerPid: 1,
            status: "paused",
            session: "original-run",
            executionKey: scheduledExecutionKey(definition),
            progress: {
              updatedAt: 1,
              currentStep: "Read",
              recentActions: [],
              checkpoints: [
                { at: 1, step: "Read", evidence: ["file read"], remaining: ["Review"] },
              ],
            },
          },
        ],
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "succeeded",
      session: "original-run",
      summary: "Resumed existing session",
    });
  });
  it.each(["nonvisual", "no-status"])(
    "blocks desktop input without validated Computer Use readiness (%s)",
    async (model) => {
      const result = await execute(
        { ...task("OK", "agent"), model, computerUse: true },
        new AbortController().signal,
      );
      expect(result.status).toBe("blocked");
    },
  );
  it("permits the explicit native desktop opt-in when the runtime reports ready", async () => {
    expect(
      await execute({ ...task("OK", "agent"), computerUse: true }, new AbortController().signal),
    ).toMatchObject({ status: "succeeded" });
  });
  it("fails rather than silently continuing after progress persistence fails", async () => {
    const definition = {
      ...task("create report", "agent"),
      goal: { objective: "Report", completionCriteria: ["Exists"], allowedScope: "Workspace" },
    };
    const result = await execute(definition, new AbortController().signal, undefined, () => {
      throw Error("disk full");
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("persist task progress");
  });
  it("audits each goal criterion before reporting verified completion", async () => {
    const checkpoints: unknown[] = [];
    const result = await execute(
      {
        ...task("create report", "agent"),
        goal: {
          objective: "Create report",
          completionCriteria: ["Report file exists"],
          allowedScope: "Test workspace",
        },
      },
      new AbortController().signal,
      undefined,
      (progress) => checkpoints.push(progress),
    );
    expect(result.status).toBe("succeeded");
    expect(result.goalVerified).toBe(true);
    expect(
      checkpoints.some((progress) =>
        JSON.stringify(progress).includes("Synthetic report file verified"),
      ),
    ).toBe(true);
  });
  it.each(["ask", "agent"] as const)(
    "reuses %s commands and captures the canonical renamed result session",
    async (mode) => {
      const result = await execute(task("OK", mode), new AbortController().signal);
      expect(result).toMatchObject({
        status: "succeeded",
        session: "synthetic-renamed",
        summary: `OK ${mode === "ask" ? "ask_light" : "user_input"}`,
      });
    },
  );
  it("stops on permission gates without approving them", async () => {
    expect(await execute(task("gate", "agent"), new AbortController().signal)).toMatchObject({
      status: "blocked",
      summary: expect.stringContaining("confirmation"),
    });
  });
  it("surfaces provider failures and cancellation instead of reporting success", async () => {
    expect(await execute(task("failure"), new AbortController().signal)).toMatchObject({
      status: "failed",
      summary: "synthetic offline",
    });
    expect(await execute(task("wait"), AbortSignal.timeout(100))).toMatchObject({
      status: "cancelled",
    });
  });
  it("does not launch on an already cancelled request, or accept a missing workspace", async () => {
    await expect(execute(task(), AbortSignal.abort())).rejects.toThrow();
    await expect(
      execute(
        { ...task(), workspaceDir: "/nonexistent-jupiter-schedule-test" },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
});
