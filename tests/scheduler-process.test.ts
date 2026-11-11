import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { ScheduledTaskStore } from "../src/scheduler/store.js";

it(
  "claims one due occurrence across real independent runtime processes",
  { retry: 0, timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "jupiter-scheduler-owners-"));
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    try {
      const now = Date.now();
      const path = join(root, "tasks.json");
      const store = new ScheduledTaskStore(path, () => now);
      store.save(
        {
          title: "QA",
          prompt: "synthetic",
          mode: "ask",
          model: "synthetic",
          editMode: "review",
          enabled: true,
          timeoutMinutes: 1,
          schedule: { kind: "once", at: new Date(now + 1000).toISOString() },
        },
        root,
      );
      const args = [
        "--import",
        "tsx",
        resolve("tests/fixtures/scheduler-owner.mjs"),
        path,
        join(root, "receipts"),
        String(now + 2000),
      ];
      await Promise.all([
        promisify(execFile)(process.execPath, args),
        promisify(execFile)(process.execPath, args),
      ]);
      expect(readFileSync(join(root, "receipts"), "utf8").trim().split("\n")).toHaveLength(1);
      expect(store.list()[0]!.runs).toHaveLength(1);
      expect(store.list()[0]!.runs[0]!.status).toBe("succeeded");
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
