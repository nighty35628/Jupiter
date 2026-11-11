import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.env.JUPITER_ANDROID_OUTPUT ?? join(root, "output/android-local-20261101"));
const pins = [
  ["zig-aarch64-macos-0.17.0.tar.xz", "b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a"],
  ["node-v22.23.4-headers.tar.gz", "dc4028dc105e27e5295119dd9da076fca71d5216113e097813f0fb30f59241a5"],
];
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
for (const [name, expected] of pins) {
  if (await hash(join(output, "downloads", name)) !== expected) throw new Error(`Invalid toolchain input: ${name}`);
}
const toolchain = join(output, "pty-toolchain");
await rm(toolchain, { recursive: true, force: true });
await mkdir(toolchain, { recursive: true });
for (const [name] of pins) execFileSync("tar", ["-xf", join(output, "downloads", name), "-C", toolchain]);
const napi = join(root, "node_modules/node-addon-api");
const napiHash = createHash("sha256");
for (const name of (await readdir(napi)).sort()) {
  if (!/\.(h|gypi)$/.test(name) && name !== "package.json") continue;
  napiHash.update(name + "\0"); napiHash.update(await readFile(join(napi, name)));
}
const pkg = JSON.parse(await readFile(join(root, "node_modules/node-pty/package.json"), "utf8"));
if (pkg.version !== "1.1.0") throw new Error("Revalidate Android PTY recipe for new node-pty source");
const dest = join(output, "pty");
await mkdir(dest, { recursive: true });
const source = join(root, "node_modules/node-pty/src/unix/pty.cc");
const args = ["c++", "-target", "aarch64-linux-gnu.2.28", "-shared", "-fPIC", "-O2",
  "-DNAPI_CPP_EXCEPTIONS", "-DNODE_GYP_MODULE_NAME=pty", "-I", join(toolchain, "node-v22.23.4/include/node"),
  "-I", join(root, "node_modules/node-addon-api"), source, "-pthread", "-lutil", "-Wl,-z,max-page-size=16384",
  "-o", join(dest, "pty.node")];
execFileSync(join(toolchain, "zig-aarch64-macos-0.17.0/zig"), args, { stdio: "inherit" });
await writeFile(join(dest, "manifest.json"), JSON.stringify({ pins, nodePty: pkg.version,
  sourceSha256: await hash(source), nodeAddonApiSha256: napiHash.digest("hex"), sha256: await hash(join(dest, "pty.node")), args }, null, 2));
await rm(toolchain, { recursive: true, force: true });
