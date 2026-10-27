import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderDashboard, renderHistory } from "../src/cli/commands/stats.js";
import { handleUsage } from "../src/server/api/usage.js";
import type { DashboardContext } from "../src/server/context.js";
import {
  aggregateUsage,
  aggregateUsageHistory,
  appendServiceCall,
  readUsageLog,
} from "../src/telemetry/usage.js";
import type { ServiceCallReport } from "../src/tools.js";

const report: ServiceCallReport = {
  kind: "service-call",
  provider: "deepseek",
  operation: "web_search",
  requestId: "synthetic-request",
  costKnown: false,
  usageKnown: false,
  status: "succeeded",
  requestMayHaveReachedService: true,
  hasResults: true,
  httpStatus: 200,
};
let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("non-model service rows in the existing usage ledger", () => {
  it("keeps daily API series consistent with aggregate non-model counts and unknown charges", async () => {
    directory = mkdtempSync(join(tmpdir(), "jupiter-service-usage-"));
    const path = join(directory, "usage.jsonl");
    appendServiceCall({ session: "session", report, path, now: Date.UTC(2026, 9, 26) });
    const response = await handleUsage("GET", ["series"], "", {
      usageLogPath: path,
    } as DashboardContext);
    expect(response.body).toMatchObject({
      days: [
        { day: "2026-10-26", turns: 0, costKnown: false, serviceCalls: 1, unknownCostCalls: 1 },
      ],
    });
  });
  it.each(["succeeded", "failed", "cancelled"] as const)(
    "preserves unknown charges for %s requests",
    (status) => {
      directory = mkdtempSync(join(tmpdir(), "jupiter-service-usage-"));
      const path = join(directory, "usage.jsonl");
      const now = Date.UTC(2026, 9, 26);
      const row = appendServiceCall({
        session: "session",
        report: { ...report, status },
        path,
        now,
      });
      expect(row).toMatchObject({
        kind: "auxiliary",
        model: "",
        usageKnown: false,
        costKnown: false,
        providerId: "service:deepseek",
        auxiliary: { service: { status, requestMayHaveReachedService: true } },
      });
      expect(row.promptTokens + row.completionTokens).toBe(0);
      const read = readUsageLog(path);
      expect(read).toEqual([row]);
      const aggregate = aggregateUsage(read, { now });
      expect(aggregate.byModel).toEqual([]);
      expect(aggregate.bySession).toEqual([]);
      expect(aggregate.buckets[0]).toMatchObject({
        turns: 0,
        costKnown: false,
        unknownCostCalls: 1,
        serviceCalls: 1,
      });
      const history = aggregateUsageHistory(read, { now });
      expect(history.months[0]?.total).toMatchObject({
        turns: 0,
        costKnown: false,
        unknownCostCalls: 1,
        serviceCalls: 1,
      });
      expect(history.months[0]?.days[0]).toMatchObject({ costKnown: false, unknownCostCalls: 1 });
      for (const rendered of [renderDashboard(aggregate, path), renderHistory(history, path)]) {
        expect(rendered).toContain("unknown");
        expect(rendered).not.toContain("(no usage in the selected history window)");
        expect(rendered).not.toContain("$0.000000");
      }
    },
  );
});
