#!/usr/bin/env node
// No-op when run from the published tarball (no dashboard/package.json shipped) —
// only the git checkout has workspace deps to install.
import { execSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

if (process.platform !== "win32") {
  for (const helper of [
    join("node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join("node_modules", "node-pty", "build", "Release", "spawn-helper"),
  ]) {
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

if (!existsSync("dashboard/package.json")) process.exit(0);

execSync("npm --prefix dashboard ci --ignore-scripts", { stdio: "inherit" });
execSync("npm --prefix desktop ci --ignore-scripts", { stdio: "inherit" });
