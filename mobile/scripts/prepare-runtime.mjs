import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { detachHardlinks, runtimeFingerprint, treeBytes } from "./runtime-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.env.JUPITER_ANDROID_OUTPUT ?? join(root, "output/android-local-20261101"));
const cache = join(output, "downloads");
const staging = join(output, "runtime");
const lock = JSON.parse(await readFile(join(root, "mobile/runtime-lock.json"), "utf8"));
await mkdir(cache, { recursive: true });
await mkdir(staging, { recursive: true });
const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

for (const input of lock.inputs) {
  const path = join(cache, input.name);
  if (existsSync(path) && await digest(path) === input.sha256) continue;
  const partial = `${path}.part`;
  let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      console.log(`Downloading ${input.name} (${attempt + 1}/3)`);
      const urls = [...(input.mirrors ?? []), input.url];
      const response = await fetch(urls[attempt % urls.length], { signal: AbortSignal.timeout(600_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      if (await digest(partial) !== input.sha256) throw new Error(`Checksum mismatch: ${input.name}`);
      await rename(partial, path);
      failure = null;
      break;
    } catch (error) {
      failure = error;
      await rm(partial, { force: true });
    }
  }
  if (failure) throw failure;
}

const rootfs = join(staging, "rootfs");
const fingerprint = runtimeFingerprint(lock);
const baseArchive = lock.toolset ? join(output, "toolset", lock.toolset.name) : join(cache, lock.inputs[0].name);
if (lock.toolset && await digest(baseArchive) !== lock.toolset.sha256)
  throw new Error("Linux toolset checksum mismatch; finish the locked toolset build first");
if (!existsSync(join(rootfs, ".jupiter-inputs")) ||
    (await readFile(join(rootfs, ".jupiter-inputs"), "utf8")) !== fingerprint) {
  await rm(rootfs, { recursive: true, force: true });
  await mkdir(rootfs, { recursive: true });
  execFileSync("tar", ["-xzf", baseArchive, "--no-same-owner", "-C", rootfs]);
  execFileSync("tar", ["-xJf", join(cache, lock.inputs[1].name), "--no-same-owner", "--strip-components=1", "-C", join(rootfs, "usr/local")]);
  await writeFile(join(rootfs, ".jupiter-inputs"), fingerprint);
}
const detachedHardlinks = await detachHardlinks(rootfs);

const libraries = join(staging, "jniLibs/arm64-v8a");
await rm(libraries, { recursive: true, force: true });
await mkdir(libraries, { recursive: true });
const find = async (base, name) => {
  for (const entry of await readdir(base, { withFileTypes: true })) {
    const path = join(base, entry.name);
    if (entry.name === name) return path;
    if (entry.isDirectory()) {
      const nested = await find(path, name);
      if (nested) return nested;
    }
  }
};
for (const input of lock.inputs.slice(2)) {
  const unpack = join(staging, input.name);
  await mkdir(unpack, { recursive: true });
  execFileSync("tar", ["-xf", join(cache, input.name), "-C", unpack]);
  const data = (await readdir(unpack)).find((name) => name.startsWith("data.tar"));
  if (!data) throw new Error(`Missing Debian data: ${input.name}`);
  execFileSync("tar", ["-xf", join(unpack, data), "-C", unpack]);
  const targets = input.name.startsWith("proot_")
    ? [["proot", "libproot.so"], ["loader", "libproot-loader.so"]]
    : input.name.startsWith("libtalloc")
      ? [["libtalloc.so.2.5.0", "libtalloc.so"]]
      : [["libandroid-shmem.so", "libandroid-shmem.so"]];
  for (const [source, destination] of targets) {
    const path = await find(unpack, source);
    if (!path) throw new Error(`Missing native library ${source}`);
    await cp(path, join(libraries, destination), { dereference: true });
  }
}
const assets = join(staging, "assets");
await mkdir(assets, { recursive: true });
const patches = [];
// Android only extracts lib*.so names. Preserve all ELF offsets while shortening this dynstr entry.
for (const name of ["libproot.so", "libtalloc.so"]) {
  const path = join(libraries, name);
  const bytes = await readFile(path);
  const needle = Buffer.from("libtalloc.so.2\0");
  const offset = bytes.indexOf(needle);
  if (bytes.readUInt32LE(0) !== 0x464c457f || bytes[4] !== 2 || bytes[5] !== 1 ||
      offset < 0 || bytes.indexOf(needle, offset + 1) >= 0) throw new Error(`Unexpected ELF dynstr layout: ${name}`);
  const originalSha256 = await digest(path);
  bytes.fill(0, offset, offset + needle.length);
  Buffer.from("libtalloc.so\0").copy(bytes, offset);
  await writeFile(path, bytes);
  patches.push({ name, originalSha256, patch: "libtalloc.so.2 -> libtalloc.so in fixed-length ELF dynstr" });
}
for (const name of await readdir(libraries)) await chmod(join(libraries, name), 0o755);
execFileSync("tar", ["-czf", join(assets, "rootfs.tar.gz.part"), "-C", rootfs, "."]);
await rename(join(assets, "rootfs.tar.gz.part"), join(assets, "rootfs.tar.gz"));
const manifest = { ...lock, fingerprint, detachedHardlinks, patches, libraries: [], rootfs: { sha256: await digest(join(assets, "rootfs.tar.gz")), bytes: (await stat(join(assets, "rootfs.tar.gz"))).size, unpackedBytes: await treeBytes(rootfs) } };
for (const name of await readdir(libraries)) manifest.libraries.push({ name, sha256: await digest(join(libraries, name)) });
await writeFile(join(assets, "runtime-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ output, rootfs, libraries, manifest }, null, 2));
