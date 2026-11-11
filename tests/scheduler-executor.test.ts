import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createScheduledExecutor } from "../src/scheduler/executor.js";
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
