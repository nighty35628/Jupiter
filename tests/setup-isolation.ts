import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Set HOME before product imports, so a missing per-test mock cannot reach user data.
const home = mkdtempSync(join(tmpdir(), "jupiter-vitest-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
