import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Build script is intentionally standalone JavaScript.
import { copyManual } from "../scripts/copy-manual.mjs";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("manual installation contract", () => {
  it("copies the sole source with package version and loads real ESM bundles away from cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "jupiter-help-install-"));
    dirs.push(root);
    cpSync(new URL("../resources/manual", import.meta.url), join(root, "resources/manual"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "jupiter", version: "7.6.5", type: "module" }),
    );
    copyManual({ packageRoot: root });
    mkdirSync(join(root, "data"));
    cpSync(
      new URL("../data/deepseek-tokenizer.json.gz", import.meta.url),
      join(root, "data/deepseek-tokenizer.json.gz"),
    );
    expect(JSON.parse(readFileSync(join(root, "dist/manual/manifest.json"), "utf8")).version).toBe(
      "7.6.5",
    );
    const cwd = join(root, "unrelated");
    mkdirSync(cwd);
    for (const relative of ["dist/index.js", "dist/cli/index.js"]) {
      copyManual({ packageRoot: root });
      const outfile = join(root, relative);
      await build({
        entryPoints: [fileURLToPath(new URL("../src/help/index.ts", import.meta.url))],
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        logLevel: "silent",
      });
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const {readHelp}=await import(${JSON.stringify(pathToFileURL(outfile).href)});const fs=await import('node:fs');const manifestPath=${JSON.stringify(join(root, "dist/manual/manifest.json"))};const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));manifest.version='replacement';fs.writeFileSync(manifestPath,JSON.stringify(manifest));fs.writeFileSync(${JSON.stringify(join(root, "dist/manual/computer-use.md"))},'replacement');const r=readHelp({topic:'computer-use'},{surface:'cli'});console.log(JSON.stringify(r));`,
        ],
        { cwd, encoding: "utf8" },
      );
      const result = JSON.parse(output);
      expect(result.version).toBe("7.6.5");
      expect(result.content).toContain("Desktop-only");
      expect(result.content).toContain("unavailable on cli");
    }
  });
  it("ships the copied manual through the npm dist files contract", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.files).toContain("dist");
    expect(pkg.scripts.build).toContain("node scripts/copy-manual.mjs");
  });
});
