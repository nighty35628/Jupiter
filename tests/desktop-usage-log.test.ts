import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Usage } from "../src/client.js";
import { appendDesktopAssistantFinalUsage } from "../src/desktop/usage-log.js";

describe("desktop usage logging", () => {
  it("appends assistant_final usage records for desktop main loop calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jupiter-desktop-usage-"));
    const path = join(dir, "usage.jsonl");

    const record = appendDesktopAssistantFinalUsage(
      {
        role: "assistant_final",
        stats: {
          turn: 1,
          model: "deepseek-v4-flash",
          usage: new Usage(15097, 50, 15147, 14000, 1097),
          cost: 0,
          cacheHitRatio: 14000 / 15097,
        },
      },
      "desktop-session",
      { path },
    );

    expect(record?.session).toBe("desktop-session");
    expect(record?.promptTokens).toBe(15097);
    const raw = await readFile(path, "utf8");
    expect(raw).toContain('"session":"desktop-session"');
    expect(raw).toContain('"promptTokens":15097');
  });

  it("ignores events without assistant_final usage", () => {
    const dir = mkdtempSync(join(tmpdir(), "jupiter-desktop-usage-"));
    const path = join(dir, "usage.jsonl");

    const record = appendDesktopAssistantFinalUsage(
      {
        role: "tool",
      },
      "desktop-session",
      { path },
    );

    expect(record).toBeNull();
  });
});
