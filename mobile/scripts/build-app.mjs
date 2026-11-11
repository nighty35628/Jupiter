import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, existsSync } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeFingerprint } from "./runtime-files.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const android = join(repo, "mobile/android");
const gradleSha256 = "b266d5ff6b90eada6dc3b20cb090e3731302e553a27c5d3e4df1f0d76beaff06";
const help = `Usage: node mobile/scripts/build-app.mjs [--gradle /absolute/bin/gradle] [--output PATH] [--offline]
       node mobile/scripts/build-app.mjs --help | --self-test

Requires JAVA_HOME (JDK 17), ANDROID_HOME or ANDROID_SDK_ROOT (SDK 36,
build-tools 36.0.0), npm dependencies, and a prepared locked runtime + PTY.
Uses a complete pinned bundled wrapper when present; otherwise requires
--gradle or GRADLE_HOME. Never generates a wrapper, key, or runtime.
Builds a production engine and QA-signed release APK; never installs, invokes
adb, runs device tests, starts the app, makes model calls, or cleans the checkout.
--offline applies to Gradle dependency resolution only.
--self-test uses in-memory fake steps; no subprocesses or filesystem writes.
`;

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--help", "--self-test", "--offline"].includes(arg)) options[arg.slice(2)] = true;
    else if (["--gradle", "--output"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

// Resolve only after process close, not after spawn, so failed/unfinished stages cannot race.
export function runCommand({
  label,
  file,
  args = [],
  cwd = repo,
  env = process.env,
  capture = false,
}) {
  console.log(`[build-app] ${label}`);
  return new Promise((done, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    });
    const chunks = [];
    let bytes = 0;
    if (capture) {
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) child.kill();
          else if (stream === child.stdout || capture === "combined") chunks.push(chunk);
        });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal || bytes > 16 * 1024 * 1024) {
        reject(new Error(`${label} failed (${signal ?? code}); no later stage was started`));
      } else done(Buffer.concat(chunks));
    });
  });
}

export async function runSteps(steps, run = runCommand) {
  for (const step of steps) await run(step);
}

export function buildSteps(gradle, javaHome, apks, env, offline = false) {
  const gradleArgs = [
    "--no-daemon",
    "--console=plain",
    `-Dorg.gradle.java.home=${javaHome}`,
    ...(offline ? ["--offline"] : []),
  ];
  return [
    {
      label: "npm production build (dashboard, engine, and copied runtime dependencies)",
      file: "npm",
      args: ["run", "build"],
    },
    {
      label: "package application engine without diagnostic fixtures",
      file: process.execPath,
      args: [join(repo, "mobile/scripts/package-engine.mjs"), "--production"],
    },
    ...[":app:assembleRelease", ":app:testReleaseUnitTest", ":app:lintRelease"].map((task) => ({
      label: task,
      file: gradle,
      args: [...gradleArgs, task],
      cwd: android,
    })),
    {
      label: "verify APK rootfs/engine bytes against manifests",
      file: process.execPath,
      args: [join(repo, "mobile/scripts/verify-apk-assets.mjs"), apks],
    },
  ].map((step) => ({ ...step, env }));
}

async function fileRequired(path) {
  if (!(await stat(path)).isFile()) throw new Error(`Required file missing: ${path}`);
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function checkedFile(path, sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? "") || (await hashFile(path)) !== sha256) {
    throw new Error(`SHA-256 mismatch: ${path}`);
  }
}

export function validateWrapper(properties) {
  const values = Object.fromEntries(
    properties
      .split(/\r?\n/)
      .filter((line) => /^[a-zA-Z][a-zA-Z0-9]*=/.test(line))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1).replaceAll("\\:", ":")];
      }),
  );
  if (
    values.distributionUrl !== "https://services.gradle.org/distributions/gradle-9.3.1-bin.zip" ||
    values.distributionSha256Sum !== gradleSha256
  ) {
    throw new Error(
      "Bundled wrapper must pin Gradle 9.3.1 bin and its official distributionSha256Sum",
    );
  }
}

async function selectGradle(options, env) {
  if (options.gradle) {
    if (!isAbsolute(options.gradle))
      throw new Error("--gradle must name an absolute executable path, not shell arguments");
    await access(options.gradle, constants.X_OK);
    return options.gradle;
  }
  const wrapper = join(android, "gradlew");
  const wrapperDir = join(android, "gradle/wrapper");
  if (existsSync(wrapper)) {
    await fileRequired(join(wrapperDir, "gradle-wrapper.jar"));
    validateWrapper(await readFile(join(wrapperDir, "gradle-wrapper.properties"), "utf8"));
    await access(wrapper, constants.X_OK);
    return wrapper;
  }
  if (!env.GRADLE_HOME)
    throw new Error(
      "No bundled wrapper: set GRADLE_HOME to Gradle 9.3.1 or pass --gradle /absolute/bin/gradle. No Gradle was invoked and no wrapper was generated.",
    );
  const executable = join(resolve(env.GRADLE_HOME), "bin/gradle");
  await access(executable, constants.X_OK);
  return executable;
}

async function preparedRuntime(output, lock) {
  const assets = join(output, "runtime/assets");
  const manifest = JSON.parse(await readFile(join(assets, "runtime-manifest.json"), "utf8"));
  if (
    lock.abi !== "arm64-v8a" ||
    manifest.abi !== lock.abi ||
    manifest.fingerprint !== runtimeFingerprint(lock)
  ) {
    throw new Error(
      "Prepared runtime does not match mobile/runtime-lock.json; prepare it separately before building",
    );
  }
  await checkedFile(join(assets, "rootfs.tar.gz"), manifest.rootfs?.sha256);
  if ((await stat(join(assets, "rootfs.tar.gz"))).size !== manifest.rootfs.bytes)
    throw new Error("Rootfs size mismatch");
  const libraries = manifest.libraries ?? [];
  for (const name of ["libproot.so", "libproot-loader.so", "libtalloc.so", "libandroid-shmem.so"]) {
    if (!libraries.some((library) => library.name === name))
      throw new Error(`Runtime manifest is missing ${name}`);
  }
  for (const library of libraries) {
    if (basename(library.name) !== library.name) throw new Error("Invalid runtime library name");
    await checkedFile(join(output, "runtime/jniLibs/arm64-v8a", library.name), library.sha256);
  }
  const pty = JSON.parse(await readFile(join(output, "pty/manifest.json"), "utf8"));
  await checkedFile(join(output, "pty/pty.node"), pty.sha256);
  return {
    manifest,
    runtimeManifestSha256: await hashFile(join(assets, "runtime-manifest.json")),
    ptyManifestSha256: await hashFile(join(output, "pty/manifest.json")),
  };
}

export function verifyIdentity(badging, certificates, expectedSigner) {
  assert.match(
    badging,
    /^package: name='dev\.jupiter\.mobile\.qa'/m,
    "Unexpected APK application ID",
  );
  assert.match(badging, /^targetSdkVersion:'36'$/m, "Unexpected target SDK");
  assert.doesNotMatch(badging, /^application-debuggable/m, "Release APK must not be debuggable");
  assert.match(badging, /^native-code: 'arm64-v8a'\s*$/m, "Unexpected APK ABI matrix");
  const signers = [
    ...certificates.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f0-9:]+)\s*$/gim),
  ];
  assert.equal(signers.length, 1, "Expected exactly one APK signer");
  assert.equal(
    signers[0][1].replaceAll(":", "").toLowerCase(),
    expectedSigner,
    "APK signer differs from the existing external QA key",
  );
}

async function buildApplication(options) {
  if (process.platform === "win32")
    throw new Error("This orchestrator currently requires a POSIX host (macOS/Linux)");
  const pins = JSON.parse(await readFile(join(repo, "mobile/build-environment-lock.json"), "utf8"));
  assert.deepEqual(
    [pins.gradle, pins.jdk, pins.compileSdk, pins.buildTools, pins.androidGradlePlugin],
    ["9.3.1", 17, 36, "36.0.0", "9.1.1"],
    "Revalidate this orchestrator before changing the environment lock",
  );
  assert.ok(Number(process.versions.node.split(".")[0]) >= 22, "Host Node.js >=22 is required");
  const output = resolve(
    options.output ??
      process.env.JUPITER_ANDROID_OUTPUT ??
      join(repo, "output/android-local-20261101"),
  );
  const javaHome = process.env.JAVA_HOME;
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!javaHome || !sdk)
    throw new Error("Set JAVA_HOME (JDK 17) and ANDROID_HOME or ANDROID_SDK_ROOT (SDK 36)");
  if (
    process.env.ANDROID_HOME &&
    process.env.ANDROID_SDK_ROOT &&
    resolve(process.env.ANDROID_HOME) !== resolve(process.env.ANDROID_SDK_ROOT)
  )
    throw new Error("ANDROID_HOME and ANDROID_SDK_ROOT disagree");
  const env = {
    ...process.env,
    JAVA_HOME: resolve(javaHome),
    ANDROID_HOME: resolve(sdk),
    ANDROID_SDK_ROOT: resolve(sdk),
    JUPITER_ANDROID_OUTPUT: output,
  };
  const gradle = await selectGradle(options, env);
  const java = join(env.JAVA_HOME, "bin/java");
  const keytool = join(env.JAVA_HOME, "bin/keytool");
  const tools = join(env.ANDROID_HOME, "build-tools/36.0.0");
  for (const executable of [java, keytool, join(tools, "apksigner"), join(tools, "aapt")])
    await access(executable, constants.X_OK);
  await fileRequired(join(env.ANDROID_HOME, "platforms/android-36/android.jar"));
  assert.match(
    await readFile(join(env.ANDROID_HOME, "platforms/android-36/source.properties"), "utf8"),
    /^AndroidVersion\.ApiLevel\s*=\s*36\s*$/m,
  );
  assert.match(
    await readFile(join(tools, "source.properties"), "utf8"),
    /^Pkg\.Revision\s*=\s*36\.0\.0\s*$/m,
  );
  await fileRequired(join(repo, "package-lock.json"));
  await fileRequired(join(repo, "node_modules/typescript/package.json"));
  const lock = JSON.parse(await readFile(join(repo, "mobile/runtime-lock.json"), "utf8"));
  const prepared = await preparedRuntime(output, lock);
  const signing = join(homedir(), ".local/share/jupiter-android");
  const keystore = join(signing, "qa-signing.p12");
  const password = join(signing, "qa-signing.password");
  for (const file of [keystore, password]) await fileRequired(file);
  const inputHashes = {};
  for (const name of [
    "package.json",
    "package-lock.json",
    "dashboard/package-lock.json",
    "desktop/package-lock.json",
    "mobile/runtime-lock.json",
    "mobile/build-environment-lock.json",
    "mobile/android/build.gradle.kts",
    "mobile/android/settings.gradle.kts",
    "mobile/android/gradle.properties",
    "mobile/android/app/build.gradle.kts",
    "mobile/scripts/build-app.mjs",
    "mobile/scripts/package-engine.mjs",
    "mobile/scripts/verify-apk-assets.mjs",
  ])
    inputHashes[name] = await hashFile(join(repo, name));
  const capture = (label, file, args, combined = false) =>
    runCommand({ label, file, args, env, capture: combined ? "combined" : true });
  const javaVersion = (await capture("check JDK version", java, ["-version"], true)).toString();
  assert.match(javaVersion, /version "17(?:[.\"])/, "JAVA_HOME must select JDK 17");
  const gradleVersion = (
    await capture("check Gradle version", gradle, [
      "--no-daemon",
      `-Dorg.gradle.java.home=${env.JAVA_HOME}`,
      "--version",
    ])
  ).toString();
  assert.match(gradleVersion, /^Gradle 9\.3\.1\s*$/m, "Gradle 9.3.1 is required");
  assert.match(gradleVersion, /^Launcher JVM:\s+17(?:[.\s])/m, "Gradle launcher must use JDK 17");
  const npmVersion = (await capture("record npm version", "npm", ["--version"])).toString().trim();
  // Only a public DER certificate is captured. Password contents never enter argv or receipts.
  const certificate = await capture("read existing QA public certificate", keytool, [
    "-exportcert",
    "-keystore",
    keystore,
    "-storetype",
    "PKCS12",
    "-alias",
    "jupiter-qa",
    "-storepass:file",
    password,
  ]);
  const signerSha256 = createHash("sha256").update(certificate).digest("hex");
  const startedAt = new Date().toISOString();
  const apk = join(android, "app/build/outputs/apk/release/app-release.apk");
  const steps = buildSteps(gradle, env.JAVA_HOME, apk, env, options.offline);
  await runSteps(steps.slice(0, -1));
  const apkBeforeChecks = await hashFile(apk);
  await runSteps(steps.slice(-1));
  const assets = join(output, "runtime/assets");
  const engine = JSON.parse(await readFile(join(assets, "engine-manifest.json"), "utf8"));
  assert.equal(engine.kind, "application", "Diagnostic engine cannot be used for this APK");
  await checkedFile(join(assets, "engine.tar.gz"), engine.sha256);
  const members = (
    await capture("check production engine members", "tar", ["-tzf", join(assets, "engine.tar.gz")])
  )
    .toString()
    .split("\n")
    .map((name) => name.replace(/^\.\//, ""));
  assert.ok(members.includes("dist/cli/android.js"), "Production Android CLI entry is missing");
  for (const name of ["engine-probe.cjs", "probe.png", "probe-key.pem", "probe-cert.pem"])
    assert.ok(!members.includes(name), `Diagnostic fixture included: ${name}`);
  const after = await preparedRuntime(output, lock);
  assert.equal(
    after.runtimeManifestSha256,
    prepared.runtimeManifestSha256,
    "Runtime changed during build",
  );
  assert.equal(after.ptyManifestSha256, prepared.ptyManifestSha256, "PTY changed during build");
  for (const [name, expected] of [
    ...prepared.manifest.libraries.map((library) => [
      `lib/arm64-v8a/${library.name}`,
      library.sha256,
    ]),
    ...["runtime-manifest.json", "engine-manifest.json"].map((name) => [`assets/${name}`, null]),
  ]) {
    const bytes = await capture(`verify packaged ${name}`, "unzip", ["-p", apk, name]);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected ?? (await hashFile(join(assets, basename(name)))),
      `APK changed ${name}`,
    );
  }
  const signature = (
    await capture("verify APK signature", join(tools, "apksigner"), [
      "verify",
      "--verbose",
      "--print-certs",
      apk,
    ])
  ).toString();
  const badging = (
    await capture("verify QA application identity", join(tools, "aapt"), ["dump", "badging", apk])
  ).toString();
  verifyIdentity(badging, signature, signerSha256);
  const sha256 = await hashFile(apk);
  assert.equal(sha256, apkBeforeChecks, "APK changed during verification");
  const report = join(output, `build-app-${startedAt.replaceAll(":", "-")}-${randomUUID()}.json`);
  for (const [name, expected] of Object.entries(inputHashes))
    await checkedFile(join(repo, name), expected);
  await writeFile(
    report,
    `${JSON.stringify(
      {
        status: "verified-build",
        startedAt,
        finishedAt: new Date().toISOString(),
        apk,
        sha256,
        bytes: (await stat(apk)).size,
        signerSha256,
        pins,
        hostNode: process.version,
        npmVersion,
        javaVersion,
        gradleVersion,
        inputHashes,
        runtimeManifestSha256: after.runtimeManifestSha256,
        engineManifestSha256: await hashFile(join(assets, "engine-manifest.json")),
        steps: steps.map(({ label }) => label),
        signature,
        installed: false,
        deviceTestsRun: false,
        modelCallsMade: false,
        legalReleaseApproved: false,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  console.log(
    `APK: ${apk}\nSHA-256: ${sha256}\nQA certificate SHA-256: ${signerSha256}\nBuild receipt: ${report}`,
  );
}

async function selfTest() {
  const plan = buildSteps("/fake/gradle", "/fake/jdk17", "/fake/app.apk", {});
  const events = [];
  await runSteps(plan, async (step) => {
    events.push(`start:${step.label}`);
    await new Promise((done) => setImmediate(done));
    events.push(`end:${step.label}`);
  });
  assert.deepEqual(
    events,
    plan.flatMap(({ label }) => [`start:${label}`, `end:${label}`]),
  );
  for (let failure = 0; failure < plan.length; failure++) {
    let count = 0;
    await assert.rejects(
      runSteps(plan, async () => {
        if (count++ === failure) throw new Error("fake failure");
      }),
      /fake failure/,
    );
    assert.equal(count, failure + 1);
  }
  assert.deepEqual(plan[0].args, ["run", "build"]);
  assert.ok(plan[1].args.includes("--production"));
  assert.deepEqual(
    plan.slice(2, 5).map((step) => step.args.at(-1)),
    [":app:assembleRelease", ":app:testReleaseUnitTest", ":app:lintRelease"],
  );
  assert.throws(() => parseArgs(["--install"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--gradle"]), /Missing value/);
  validateWrapper(
    `distributionUrl=https\\://services.gradle.org/distributions/gradle-9.3.1-bin.zip\ndistributionSha256Sum=${gradleSha256}`,
  );
  assert.throws(() => validateWrapper("distributionUrl=https://example.invalid/gradle.zip"));
  const badging =
    "package: name='dev.jupiter.mobile.qa'\ntargetSdkVersion:'36'\nnative-code: 'arm64-v8a'\n";
  const cert = "1".repeat(64);
  verifyIdentity(badging, `Signer #1 certificate SHA-256 digest: ${cert}`, cert);
  assert.throws(() =>
    verifyIdentity(
      `${badging}application-debuggable\n`,
      `Signer #1 certificate SHA-256 digest: ${cert}`,
      cert,
    ),
  );
  assert.throws(() =>
    verifyIdentity(badging, `Signer #1 certificate SHA-256 digest: ${cert}`, "2".repeat(64)),
  );
  console.log(
    "Self-test passed: sequential awaits, fail-fast stages, production tasks, wrapper pin, identity/signature gates. No subprocesses or writes.",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(help);
    else if (options["self-test"]) await selfTest();
    else await buildApplication(options);
  } catch (error) {
    console.error(`[build-app] ${error.message}`);
    process.exitCode = 1;
  }
}
