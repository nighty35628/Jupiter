import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("write-cli-package-marker", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "jupiter-copy-vendor-"));
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "jupiter", version: "9.8.7" }));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes package metadata for the bundled CLI", () => {
    const script = resolve("scripts/write-cli-package-marker.mjs");
    const run = spawnSync(process.execPath, [script], { cwd: tmp, encoding: "utf8" });

    expect(run.status).toBe(0);
    const marker = JSON.parse(readFileSync(join(tmp, "dist/cli/package.json"), "utf8"));
    expect(marker).toEqual({
      name: "jupiter",
      version: "9.8.7",
      type: "module",
    });
  });
});
