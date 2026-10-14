import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Usage } from "../src/client.js";
import { SessionStats } from "../src/telemetry/stats.js";
import { appendUsage, readUsageLog } from "../src/telemetry/usage.js";

describe("prediction auxiliary accounting", { retry: 0 }, () => {
  it("uses the request's captured price without adding turns or replacing context tokens", () => {
    const stats = new SessionStats();
    stats.record(1, "deepseek-flash", new Usage(1000, 10, 1010));
    const before = stats.summary();
    const costBefore = stats.totalCost;
    stats.recordExternal(
      "deepseek-flash",
      new Usage(200, 20, 220, 0, 200),
      "deepseek-official",
      0.123,
    );
    expect(stats.totalCost).toBeCloseTo(costBefore + 0.123, 10);
    expect(stats.summary().turns).toBe(before.turns);
  });

  it("preserves explicit unknown-cost auxiliary records without prompt content", () => {
    const path = join(mkdtempSync(join(tmpdir(), "jupiter-prediction-usage-")), "usage.jsonl");
    appendUsage({
      path,
      session: "source",
      model: "custom",
      usage: new Usage(),
      kind: "auxiliary",
      costUsdOverride: 0,
      costKnown: false,
      auxiliary: { provider: "custom", operation: "prompt_prediction", requestId: "completion" },
    });
    expect(readUsageLog(path)[0]).toMatchObject({
      costKnown: false,
      kind: "auxiliary",
      session: "source",
    });
  });
});
