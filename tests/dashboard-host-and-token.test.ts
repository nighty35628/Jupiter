/** `startDashboardServer({ host, token })` — loopback-only binding + stable token. */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DashboardServerHandle, startDashboardServer } from "../src/server/index.js";

const TOKEN = "stable-pinned-token-1234567890";

function ctx(dir: string) {
  return {
    mode: "standalone" as const,
    configPath: join(dir, "config.json"),
    usageLogPath: join(dir, "usage.jsonl"),
  };
}

describe("startDashboardServer host + token", () => {
  let dir: string;
  let handle: DashboardServerHandle | undefined;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jupiter-dashhost-"));
    writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    writeSpy.mockRestore();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to 127.0.0.1 when no host is given and emits no LAN warning", async () => {
    handle = await startDashboardServer(ctx(dir), { token: TOKEN });
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    const warnings = writeSpy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("▲"));
    expect(warnings).toEqual([]);
  });

  it("reuses opts.token verbatim instead of minting a fresh one", async () => {
    handle = await startDashboardServer(ctx(dir), { token: TOKEN });
    expect(handle.token).toBe(TOKEN);
    expect(handle.url).toContain(`token=${TOKEN}`);
  });

  it.each(["0.0.0.0", "::", "192.168.1.50"])(
    "rejects non-loopback host %s before binding",
    async (host) => {
      await expect(startDashboardServer(ctx(dir), { token: TOKEN, host })).rejects.toThrow(
        `Legacy Dashboard only supports loopback hosts (127.0.0.1, ::1, or localhost); received ${JSON.stringify(host)}. Remote access is disabled because URL-token authentication is not safe for LAN or public exposure.`,
      );
      expect(writeSpy).not.toHaveBeenCalled();
    },
  );

  it("does not warn for ::1 or localhost (still loopback)", async () => {
    handle = await startDashboardServer(ctx(dir), { token: TOKEN, host: "localhost" });
    const warnings = writeSpy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("▲"));
    expect(warnings).toEqual([]);
  });
});
