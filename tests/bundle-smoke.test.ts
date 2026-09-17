/** Post-build smoke — confirm bundled `dist/{index,cli/index}.js` resolves the tokenizer data file at package-root. */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const LIB_BUNDLE = resolve("dist/index.js");
const CLI_BUNDLE = resolve("dist/cli/index.js");

describe("bundled dist — tokenizer path resolution", () => {
  const libExists = existsSync(LIB_BUNDLE);
  const cliExists = existsSync(CLI_BUNDLE);

  (libExists ? it : it.skip)(
    "dist/index.js resolves the tokenizer data file at package-root data/",
    () => {
      // truncateForModelByTokens internally calls countTokens when the
      // input exceeds the fast-path threshold, which forces the
      // tokenizer's lazy data-file load. If resolveDataPath() lands on
      // a non-existent path (the 0.5.4 regression) this crashes with
      // ENOENT and the spawned process exits non-zero.
      // ESM dynamic imports on Windows require `file://` URLs, not bare
      // absolute paths (which Node's ESM loader rejects as an unknown
      // protocol). pathToFileURL handles the cross-platform form.
      const libUrl = pathToFileURL(LIB_BUNDLE).href;
      const result = spawnSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { truncateForModelByTokens } from "${libUrl}";
           const s = "hello world ".repeat(500);
           const out = truncateForModelByTokens(s, 100);
           console.log(JSON.stringify({ ok: true, len: out.length }));`,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).not.toMatch(/deepseek-tokenizer\.json\.gz/);
      expect(result.stderr).not.toMatch(/ENOENT/);
      expect(result.stdout).toMatch(/"ok":true/);
    },
  );

  (cliExists ? it : it.skip)(
    "dist/cli/* inlines runtime deps so the desktop sidecar can run without node_modules",
    async () => {
      const { readdirSync, readFileSync } = await import("node:fs");
      const distDir = resolve("dist/cli");
      const jsFiles = readdirSync(distDir).filter((f) => f.endsWith(".js"));
      const leakedImports = jsFiles.flatMap((f) => {
        const body = readFileSync(resolve(distDir, f), "utf8");
        const hits: string[] = [];
        for (const pkg of ["commander", "ink", "undici", "@larksuiteoapi/node-sdk"]) {
          if (new RegExp(`from\\s*["']${pkg}["']`).test(body)) hits.push(`${f}:${pkg}`);
        }
        return hits;
      });
      expect(
        leakedImports,
        `dist/cli/*.js still imports runtime deps from node_modules: ${leakedImports.join(", ")}`,
      ).toEqual([]);
    },
  );

  (cliExists ? it : it.skip)(
    "dist/cli/desktop chunk imports without CommonJS globals",
    async () => {
      const { readdirSync } = await import("node:fs");
      const distDir = resolve("dist/cli");
      const desktopChunk = readdirSync(distDir).find((f) => /^desktop-.*\.js$/.test(f));
      expect(desktopChunk).toBeTruthy();
      const desktopUrl = pathToFileURL(resolve(distDir, desktopChunk ?? "")).href;
      const result = spawnSync(
        "node",
        ["--input-type=module", "-e", `await import("${desktopUrl}"); console.log("desktop-ok");`],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toMatch(/__dirname is not defined/);
      expect(result.stdout).toContain("desktop-ok");
    },
  );

  (cliExists ? it : it.skip)("dist/cli/web chunk loads the native PTY dependency", async () => {
    const { readdirSync } = await import("node:fs");
    const distDir = resolve("dist/cli");
    const webChunk = readdirSync(distDir).find((f) => /^web-.*\.js$/.test(f));
    expect(webChunk).toBeTruthy();
    const webUrl = pathToFileURL(resolve(distDir, webChunk ?? "")).href;
    const result = spawnSync(
      "node",
      ["--input-type=module", "-e", `await import("${webUrl}"); console.log("web-ok");`],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("web-ok");
  });

  (cliExists ? it : it.skip)("dist/cli exposes all Web access modes in help", () => {
    const result = spawnSync("node", [CLI_BUNDLE, "web", "--help"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("run Jupiter Web Beta");
    expect(result.stdout).toContain("access mode: local, lan, or public");
    expect(result.stdout).not.toContain("run the local Jupiter Web Beta");
  });

  (cliExists ? it : it.skip)(
    "packaged image worker runs outside the checkout with only shipped WASM dependencies",
    async () => {
      const { cp, mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { PhotonImage } = await import("@silvia-odwyer/photon-node");
      const directory = await mkdtemp(join(tmpdir(), "jupiter-packaged-image-"));
      const fixture = new PhotonImage(new Uint8Array([230, 56, 74, 255, 48, 172, 214, 255]), 2, 1);
      try {
        const bytes = Buffer.from(fixture.get_bytes()).toString("base64");
        await cp(resolve("dist/image-worker.cjs"), join(directory, "image-worker.cjs"));
        for (const dependency of ["@silvia-odwyer/photon-node", "image-size"]) {
          await cp(
            resolve("dist/node_modules", dependency),
            join(directory, "node_modules", dependency),
            { recursive: true },
          );
        }
        const result = spawnSync(
          "node",
          [
            "--input-type=module",
            "-e",
            `
        import { Worker } from 'node:worker_threads';
        const worker = new Worker(${JSON.stringify(join(directory, "image-worker.cjs"))}, {
          workerData: { bytes: new Uint8Array(Buffer.from(${JSON.stringify(bytes)}, 'base64')), mode: 'canonical' }, execArgv: []
        });
        worker.once('error', (error) => { console.error(error); process.exitCode = 1; });
        worker.once('message', (result) => {
          if (!result.ok || result.value.image.width !== 2 || !result.value.thumbnail.data.length) process.exitCode = 1;
          else console.log('packaged-image-ok');
        });
      `,
          ],
          { cwd: directory, encoding: "utf8", timeout: 30_000 },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("packaged-image-ok");
      } finally {
        fixture.free();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  (cliExists ? it : it.skip)("dist/cli/index.js loads tokenizer before the first API fetch", () => {
    // Spawn the CLI pointed at a bogus local address that fails fetch
    // fast. In step(), preflight's estimateRequestTokens runs BEFORE
    // client.chat — so if the bundled layout can't find the
    // tokenizer data, we see ENOENT in stderr even though the fetch
    // never happens. If tokenizer loads fine, we see a connection
    // error instead (and that's OK — we're not testing the network
    // path, only that the tokenizer path resolution works from
    // dist/cli/).
    const result = spawnSync("node", [CLI_BUNDLE, "run", "--no-config", "hi"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "sk-smoke-test-bogus",
        // Fail-fast fetch target: the :1 port is almost never open,
        // so we get connection-refused within ~1ms instead of the
        // client's 120s timeout waiting on api.deepseek.com.
        DEEPSEEK_BASE_URL: "http://127.0.0.1:1",
      },
    });
    const combined = `${result.stdout}\n${result.stderr}`;
    // The crucial assertion: bundle must not crash on the tokenizer
    // path. Connection errors to 127.0.0.1:1 are expected and fine.
    expect(combined).not.toMatch(/deepseek-tokenizer\.json\.gz/);
    // Also not a missing-module style ENOENT (network errors are
    // ECONNREFUSED or fetch failure, never ENOENT).
    expect(combined).not.toMatch(/ENOENT.*tokenizer/i);
  });
});
