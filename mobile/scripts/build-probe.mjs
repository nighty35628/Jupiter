import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeFingerprint } from "./runtime-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk");
const java = process.env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home";
const tools = join(sdk, "build-tools/36.0.0");
const jar = join(sdk, "platforms/android-36/android.jar");
const output = resolve(process.env.JUPITER_ANDROID_OUTPUT ?? join(root, "output/android-local-20261101"));
const build = join(output, "probe-build");
const run = (program, args, cwd = root, env = process.env) => execFileSync(program, args, { cwd, env: { ...env, JAVA_HOME: java }, stdio: "inherit" });
await rm(build, { recursive: true, force: true });
for (const name of ["classes", "dex", "assets", "zip/lib/arm64-v8a"]) await mkdir(join(build, name), { recursive: true });
await cp(join(output, "runtime/assets"), join(build, "assets"), { recursive: true });
const manifest = JSON.parse(await readFile(join(build, "assets/runtime-manifest.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "mobile/runtime-lock.json"), "utf8"));
if (manifest.fingerprint !== runtimeFingerprint(lock)) throw new Error("Prepared runtime is stale for the current lock");
if (createHash("sha256").update(await readFile(join(build, "assets/rootfs.tar.gz"))).digest("hex") !== manifest.rootfs.sha256)
  throw new Error("Runtime asset does not match the completed manifest; prepare-runtime must finish before building");
await cp(join(root, "mobile/runtime-probe.cjs"), join(build, "assets/runtime-probe.cjs"));
for (const library of manifest.libraries) {
  const source = join(output, "runtime/jniLibs/arm64-v8a", library.name);
  if (createHash("sha256").update(await readFile(source)).digest("hex") !== library.sha256)
    throw new Error(`Native library checksum mismatch: ${library.name}`);
  await cp(source, join(build, "zip/lib/arm64-v8a", library.name));
}
run(join(java, "bin/javac"), ["-source", "8", "-target", "8", "-bootclasspath", `${jar}:${join(tools, "core-lambda-stubs.jar")}`, "-d", join(build, "classes"), join(root, "mobile/android/shared/dev/jupiter/mobile/runtime/BoundedLines.java"), join(root, "mobile/android/probe/RuntimeProbeActivity.java")]);
const classFiles = [];
async function collect(path) { for (const item of await readdir(path, { withFileTypes: true })) { const full = join(path, item.name); if (item.isDirectory()) await collect(full); else if (item.name.endsWith(".class")) classFiles.push(full); } }
await collect(join(build, "classes"));
run(join(tools, "d8"), ["--lib", jar, "--min-api", "29", "--output", join(build, "dex"), ...classFiles]);
const unsigned = join(build, "unsigned.apk");
const resources = join(build, "resources.zip");
run(join(tools, "aapt2"), ["compile", "--dir", join(root, "mobile/android/probe/res"), "-o", resources]);
run(join(tools, "aapt2"), ["link", "-I", jar, "--manifest", join(root, "mobile/android/probe/AndroidManifest.xml"), "-A", join(build, "assets"), "-o", unsigned, resources]);
await cp(join(build, "dex/classes.dex"), join(build, "zip/classes.dex"));
const libraries = manifest.libraries.map(({ name }) => `lib/arm64-v8a/${name}`);
run("zip", ["-q", "-u", unsigned, "classes.dex", ...libraries], join(build, "zip"));
const aligned = join(build, "aligned.apk");
run(join(tools, "zipalign"), ["-P", "16", "-f", "4", unsigned, aligned]);
const signing = join(homedir(), ".local/share/jupiter-android");
await mkdir(signing, { recursive: true, mode: 0o700 });
const passwordPath = join(signing, "qa-signing.password");
const keystore = join(signing, "qa-signing.p12");
if (!existsSync(passwordPath)) await writeFile(passwordPath, randomBytes(32).toString("hex"), { mode: 0o600 });
const password = (await readFile(passwordPath, "utf8")).trim();
if (!existsSync(keystore)) run(join(java, "bin/keytool"), ["-genkeypair", "-keystore", keystore, "-storetype", "PKCS12", "-alias", "jupiter-qa", "-storepass:env", "JUPITER_QA_SIGNING", "-keyalg", "RSA", "-keysize", "3072", "-validity", "3650", "-dname", "CN=Jupiter QA"], root, { ...process.env, JUPITER_QA_SIGNING: password });
await chmod(keystore, 0o600);
const apk = join(output, "jupiter-local-probe.apk");
run(join(tools, "apksigner"), ["sign", "--ks", keystore, "--ks-key-alias", "jupiter-qa", "--ks-pass", `file:${passwordPath}`, "--out", apk, aligned]);
run(join(tools, "apksigner"), ["verify", "--verbose", apk]);
await rm(build, { recursive: true, force: true });
console.log(apk);
