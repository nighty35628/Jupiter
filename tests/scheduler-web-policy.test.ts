import { describe, expect, it } from "vitest";
import { isHistoryReadCommand } from "../src/web/history-read.js";
import { authorizeDesktopCommand } from "../src/web/policy.js";
import type { WorkspaceRegistry } from "../src/web/workspaces.js";

describe("scheduled task Web policy", { retry: 0 }, () => {
  it("allows observers to list but not mutate scheduled tasks", () => {
    const requestId = "a0000000-0000-4000-8000-000000000000";
    expect(isHistoryReadCommand({ cmd: "scheduled_list", requestId })).toBe(true);
    expect(isHistoryReadCommand({ cmd: "scheduled_list", requestId, task: {} })).toBe(false);
    expect(isHistoryReadCommand({ cmd: "scheduled_action", requestId })).toBe(false);
  });
  const workspaces = {} as WorkspaceRegistry;
  it.each([false, true])(
    "keeps public scheduling read-only even with high-risk=%s",
    async (highRiskEnabled) => {
      const opts = { mode: "public" as const, highRiskEnabled, workspaces };
      await expect(
        authorizeDesktopCommand({ cmd: "scheduled_list", requestId: "qa" }, opts),
      ).resolves.toMatchObject({ risk: "read" });
      for (const cmd of ["scheduled_save", "scheduled_action"])
        await expect(authorizeDesktopCommand({ cmd }, opts)).rejects.toThrow(/disabled/);
    },
  );
  it("requires explicit high-risk access for LAN task changes", async () => {
    const opts = { mode: "lan" as const, workspaces };
    await expect(authorizeDesktopCommand({ cmd: "scheduled_action" }, opts)).rejects.toThrow(
      /high-risk/,
    );
    await expect(
      authorizeDesktopCommand({ cmd: "scheduled_action" }, { ...opts, highRiskEnabled: true }),
    ).resolves.toMatchObject({ risk: "host-control" });
    await expect(
      authorizeDesktopCommand({ cmd: "scheduled_save" }, { mode: "local", workspaces }),
    ).resolves.toMatchObject({ risk: "host-control" });
  });
});
