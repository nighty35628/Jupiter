import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { treeBytes } from "./runtime-files.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.env.JUPITER_ANDROID_OUTPUT ?? join(repo, "output/android-local-20261101"));
const engine = join(output, "engine");
await rm(engine, { recursive: true, force: true });
await mkdir(engine, { recursive: true });
await cp(join(repo, "dist"), join(engine, "dist"), { recursive: true, filter: path => !path.endsWith(".map") });
await mkdir(join(engine, "dashboard"), { recursive: true });
await cp(join(repo, "dashboard/index.html"), join(engine, "dashboard/index.html"));
await cp(join(repo, "dashboard/dist"), join(engine, "dashboard/dist"), { recursive: true });
await cp(join(repo, "package.json"), join(engine, "package.json"));
await cp(join(repo, "node_modules/web-tree-sitter"), join(engine, "node_modules/web-tree-sitter"), { recursive: true });
await mkdir(join(engine, "data"), { recursive: true });
await cp(join(repo, "data/deepseek-tokenizer.json.gz"), join(engine, "data/deepseek-tokenizer.json.gz"));
const pty = join(engine, "node_modules/node-pty");
await mkdir(join(pty, "build/Release"), { recursive: true });
await cp(join(repo, "node_modules/node-pty/lib"), join(pty, "lib"), { recursive: true, filter: path => !/\.(map|test\.js)$/.test(path) });
await cp(join(repo, "node_modules/node-pty/package.json"), join(pty, "package.json"));
await cp(join(repo, "node_modules/node-pty/LICENSE"), join(pty, "LICENSE"));
const ptyManifest = JSON.parse(await readFile(join(output, "pty/manifest.json"), "utf8"));
const binary = await readFile(join(output, "pty/pty.node"));
if (createHash("sha256").update(binary).digest("hex") !== ptyManifest.sha256) throw new Error("Incomplete PTY build");
await writeFile(join(pty, "build/Release/pty.node"), binary);
const diagnostic = !process.argv.includes("--production");
if (diagnostic) {
await cp(join(repo, "mobile/engine-probe.cjs"), join(engine, "engine-probe.cjs"));
const require = createRequire(import.meta.url);
const { PhotonImage } = require("@silvia-odwyer/photon-node");
const image = new PhotonImage(new Uint8Array(12 * 8 * 4).fill(255), 12, 8);
try { await writeFile(join(engine, "probe.png"), image.get_bytes()); }
finally { image.free(); }
// Synthetic, per-build TLS identity belongs only to this diagnostic QA engine.
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost",
  "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", join(engine, "probe-key.pem"), "-out", join(engine, "probe-cert.pem")], { stdio: "ignore" });
}
const icons = join(output, "runtime/android-res/mipmap-xxxhdpi");
await mkdir(icons, { recursive: true });
await cp(join(repo, "desktop/src-tauri/icons/icon.png"), join(icons, "ic_launcher.png"));
const assets = join(output, "runtime/assets");
const archive = join(assets, "engine.tar.gz");
execFileSync("tar", ["-czf", archive, "-C", engine, "."]);
await writeFile(join(assets, "engine-manifest.json"), JSON.stringify({
  kind: diagnostic ? "diagnostic" : "application",
  sha256: createHash("sha256").update(await readFile(archive)).digest("hex"),
  bytes: (await stat(archive)).size, pty: ptyManifest,
  unpackedBytes: await treeBytes(engine),
}, null, 2));
console.log(archive);
