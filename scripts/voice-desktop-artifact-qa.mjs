import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

// Inspect only the locally built bundle. Never launch, install, or record audio.
const app = resolve("desktop/src-tauri/target/speech-review-v2/release/bundle/macos/Jupiter.app");
const binary = join(app, "Contents/MacOS/Jupiter");
const resources = join(app, "Contents/Resources");
execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" });
const parsePlist = input => JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input, encoding: "utf8" }));
const info = parsePlist(await readFile(join(app, "Contents/Info.plist")));
assert.equal(typeof info.NSMicrophoneUsageDescription, "string");
assert(info.NSMicrophoneUsageDescription.trim());
const entitlements = parsePlist(execFileSync("codesign", ["-d", "--entitlements", ":-", app], { stdio: ["ignore", "pipe", "pipe"] }));
assert.equal(entitlements["com.apple.security.device.audio-input"], true);
const imports = execFileSync("xcrun", ["dyld_info", "-imports", binary], { encoding: "utf8" });
assert(!/\$(?:NEWLAPACK|ILP64)/u.test(imports), "New Accelerate ABI symbols in packaged binary");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const licenses = {};
for (const name of await readdir(resolve("desktop/src-tauri/licenses/speech"))) {
  const source = await readFile(resolve("desktop/src-tauri/licenses/speech", name));
  const bundled = await readFile(join(resources, "licenses/speech", name));
  assert.equal(sha(bundled), sha(source), "License content mismatch: " + name);
  licenses[name] = sha(bundled);
}
const members = await readdir(resources, { recursive: true });
assert(!members.some(name => /(?:^|\/)ggml-[^/]+\.bin$/u.test(name)), "Model weights bundled in app");
const report = {
  app, binarySha256: sha(await readFile(binary)), version: info.CFBundleShortVersionString,
  microphoneUsageDescription: info.NSMicrophoneUsageDescription,
  microphoneEntitlement: true, codeSignatureVerified: true, newAccelerateAbiImports: false,
  licenses, modelWeightsBundled: false, launched: false, installed: false, microphoneTested: false,
};
await writeFile(resolve("output/voice-input-20261106/desktop-artifact.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
