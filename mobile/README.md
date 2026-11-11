# Jupiter Android QA App

This is an on-device Android host for the Jupiter workbench, not a remote UI
that requires Jupiter to remain running on a desktop. The APK contains the
WebView UI, Node engine, Ubuntu userspace/toolset, PRoot and an ARM64 PTY addon.
After installation and first extraction, local files, projects and tool execution
live on the phone. Provider/model requests still require the configured remote
service, network access and credentials; phone independence does not mean offline
model inference or free API usage.

## Identity and Secrets

- Stable QA application ID: `dev.jupiter.mobile.qa`; label: `Jupiter QA`.
- `release` is non-debuggable but QA-signed, not a store-approved/public release.
- The current Gradle configuration reads the existing PKCS12 key at
  `~/.local/share/jupiter-android/qa-signing.p12`, password file
  `qa-signing.password`, alias `jupiter-qa`. Keep both files outside the repository
  and restrict their permissions. Back them up through the owner's secure process.
- Preserve the application ID and certificate for in-place QA updates. Do not
  replace the key to bypass a signing error; this build entry never generates keys.
  The receipt contains only the public certificate fingerprint, never key material
  or password contents. Certificate equality here is against the provided existing
  QA key; independently retain its trusted fingerprint to detect key replacement.
- Provider config uses an Android Keystore-wrapped data-encryption key. An APK
  signature does not back up that key. Uninstall/data clearing, key loss or corruption
  can make saved credentials unavailable. No automatic reset should be inferred.

## Build Prerequisites

Use an isolated checkout and do not run this alongside another build or edit of
the same checkout/runtime output. The script does not coordinate with an owner's
separate Gradle invocation. It does not change Gradle configuration or prepare the
runtime on your behalf.

| Input | Required value or preparation |
| --- | --- |
| Host | POSIX macOS/Linux, Node.js >=22, npm, `tar`, `unzip` |
| JS dependencies | Install from the repository lockfile beforehand; no implicit install |
| Java | `JAVA_HOME` pointing to JDK 17, including `java` and `keytool` |
| Gradle | 9.3.1; pinned complete wrapper, `GRADLE_HOME`, or `--gradle /absolute/bin/gradle` |
| Android SDK | `ANDROID_HOME` or `ANDROID_SDK_ROOT`; platform `android-36` and build-tools `36.0.0` |
| Android plugin | 9.1.1, as recorded in `build-environment-lock.json` and current Gradle files |
| Prepared runtime | `runtime/assets/rootfs.tar.gz`, `runtime-manifest.json`, matching `runtime/jniLibs/arm64-v8a/*` |
| Prepared PTY | `pty/pty.node` and `pty/manifest.json` |
| Signing | Existing external QA key/password files described above |

Runtime inputs and hashes are in `runtime-lock.json`. The Ubuntu toolset uses
snapshot `20261030T000000Z` and includes Git, ripgrep, Python and CA certificates,
plus the base distribution and transitive packages. `build-toolset.mjs`,
`build-pty.mjs` and `prepare-runtime.mjs` are separate preparation stages owned by
the runtime maintainer. They have their own platform/toolchain requirements and
may download or replace generated trees; they are not called by `build-app.mjs`.
The environment lock's NDK is relevant to native preparation, not an implicit
native rebuild in this orchestrator.

## Production Packaging

The following command **executes a build**; run it only when ready to use the
checkout, output directory and Gradle. Substitute your actual absolute paths:

```sh
JAVA_HOME=/path/to/jdk-17 \
ANDROID_HOME=/path/to/android-sdk \
GRADLE_HOME=/path/to/gradle-9.3.1 \
node mobile/scripts/build-app.mjs --output /path/to/prepared-android-output
```

`--output` takes precedence over `JUPITER_ANDROID_OUTPUT`; the fallback is
`output/android-local-20261101` under the repository. The chosen directory must
already contain the prepared runtime and PTY. `--gradle /absolute/bin/gradle`
overrides wrapper/home selection. Otherwise a complete bundled wrapper is preferred;
without one, `GRADLE_HOME` is mandatory. There is no unversioned PATH fallback.

No wrapper is currently bundled. The script does not generate one or invoke a
system Gradle to create it. A future owner-provided wrapper must contain `gradlew`,
`gradle/wrapper/gradle-wrapper.jar` and properties pinning the HTTPS 9.3.1 bin URL
and its [official SHA-256](https://services.gradle.org/distributions/gradle-9.3.1-bin.zip.sha256).
The wrapper JAR/scripts also need trusted provenance; checking the distribution
checksum alone is not a review of executable wrapper code.

After environment, prepared-input hashes and the existing signing key are checked,
the orchestrator waits for each command's successful process exit, in this order:

1. `npm run build` in the repository, including the complete dashboard/engine build
   and image-runtime copying. It is not launched in the background.
2. `node mobile/scripts/package-engine.mjs --production`.
3. Gradle `:app:assembleRelease`.
4. Gradle `:app:testReleaseUnitTest`.
5. Gradle `:app:lintRelease`.
6. `node mobile/scripts/verify-apk-assets.mjs <release-apk>`.
7. Check the application engine kind/entry and absence of diagnostic fixtures,
   unchanged prepared inputs, packaged manifest/JNI hashes, SDK build-tools
   `apksigner verify --verbose --print-certs`, QA signer equality and APK identity
   (`dev.jupiter.mobile.qa`, target 36, ARM64-only, non-debuggable).
8. Hash the final APK and write a unique `build-app-*.json` success receipt in the
   selected output directory. Receipt includes tool versions, selected input hashes,
   asset-manifest hashes and public signature details.

Gradle runs with JDK 17, `--no-daemon` and plain console output. `--offline` adds
Gradle's offline dependency-resolution flag; missing cached dependencies fail.
Without it, Gradle/wrapper may fetch public build dependencies. This flag does not
turn npm scripts into a network sandbox.

The default artifact is `mobile/android/app/build/outputs/apk/release/app-release.apk`.
There is no `clean` task, `adb`, install, device instrumentation, engine startup,
chat request or paid model call in this orchestrator. Existing Gradle reports stay
under `mobile/android/app/build/reports/`. Production packaging **does replace**
the selected output's generated `engine/` tree and engine archive through the
existing packager; it is not a read-only command. Do not point it at irreplaceable data.

Safe script-only checks, without Gradle or build subprocesses:

```sh
node --check mobile/scripts/build-app.mjs
node mobile/scripts/build-app.mjs --self-test
node mobile/scripts/build-app.mjs --help
```

The self-test covers asynchronous ordering, stopping at every failed stage,
production task selection, wrapper pinning and APK identity/signer gates using
in-memory fakes. It is not a successful APK build or a device test.

This is a pinned-input, auditable recipe, **not a claim of byte-identical APK
reproducibility**. Preserve the actual source checkout, npm installation/lockfiles,
prepared inputs, SDK/Gradle/JDK distributions and external signing identity. Tar
timestamps, toolchain patches, dependency caches and signing can affect output bytes.
Receipt `inputHashes` covers only the explicitly listed build recipes, configuration,
package metadata and lockfiles. It does not cover all application/business source
files or identify a complete source snapshot; matching it does not prove that later
TypeScript, React or Kotlin changes are included in an APK.
An asset hash validates integrity relative to a manifest, not source availability,
upstream provenance, app functionality or license compliance.

## Runtime Boundaries

The user-started `specialUse` foreground service exposes an explicit Stop action
and uses `START_NOT_STICKY`; the manifest declares no boot-start receiver. A service
and notification are not a guarantee of unattended execution. Android background
start restrictions, system/OEM process termination, force-stop, resource pressure
and power management still apply. Scheduled tasks require a living runtime; do
not promise execution after stop, reboot or process death. See Android's
[background-start restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
and [special-use service requirements](https://developer.android.com/develop/background-work/services/fgs/service-types#special-use).
The manifest declaration is not Google Play acceptance.

PRoot translates userspace paths/syscalls; `-0` presents a simulated root identity.
It does not grant Android root, replace the kernel or form a security sandbox for
untrusted tools. Processes remain under the app's ordinary UID and Android/SELinux
constraints. Treat shell commands, downloaded scripts and model tool execution as
able to affect app-accessible projects/data, not as isolated by PRoot.

## Verification Matrix

| Runtime environment | Evidence boundary |
| --- | --- |
| `arm64-v8a`, Android API 36, 4096-byte pages, emulator | Existing node/engine probes and recorded Native/Workbench instrumentation below; not acceptance of all subsequent source changes |
| NX733J ARM64 physical phone, API 36, 4096-byte pages, WebView 156 | Keystore/lifecycle and workbench configuration/chat/recreation passed; project workflow acceptance tracked separately below; not a claim about other OEMs |
| ARM64 16 KB pages | User-deferred runtime matrix; ELF alignment is not actual 16 KB execution evidence |
| API 29-35 (including API 29/34) or other API levels | API 29/34 matrix explicitly deferred by the user; `minSdk=29` remains a build declaration, not runtime validation |
| `x86`, `x86_64`, `armeabi-v7a` | Not packaged; no compatibility claim |

Existing records are under `output/android-local-20261101/`:
`node-probe-evidence.json` records API/ABI/page size and explicitly says Node-only;
`engine-probe-evidence.json` records PTY/chat/file/image/cancel/recovery checks on
an emulator and explicitly says `realDevice: false`, `fullPhaseZero: false`.
Those records concern earlier APK hashes, not every future production build.

The orchestrator has now completed a recorded production build. The existing
`build-app-validation.log` and
`build-app-2026-11-01T04-50-34.563Z-7f19d79c-a8c0-4c24-99e4-f75c2dbeaa42.json`
record successful build/unit-test/lint, APK asset and signature verification,
finishing at `2026-11-01T04:51:44.420Z`, with APK SHA-256
`be7bc2d1bfd47f05367dc00c93bdf0b5a77a1b219a80afb0cfcd98ed27283bcf`.
Separate instrumentation logs record `bridge-keystore-final.log`: `OK (12 tests)`
and `workbench-final.log`: `OK (1 test)`. The orchestrator receipt's
`installed: false` / `deviceTestsRun: false` describe that build invocation, not
these separately recorded instrumentation runs. The instrumentation summaries do
not themselves bind their results to an APK hash or a complete source snapshot.

These historical records are retained, not substituted for later builds. The latest
recorded production build is `build-app-2026-11-01T07-02-25.301Z-7d47b64e-c2a6-4b4d-8850-8fbc275f444c.json`,
APK SHA-256 `958115dd58280ca804be2be55f5ccb2b3031f95eec3ea4caf726a8eeca58dc59`.
It includes the bottom-panel placement and outer focus-scroll fixes. It has not
been installed because the user paused phone testing. The last installed build
on both devices was `13ba3c15c8851dbc4bfa93249f243cf3c1d6c1c7e58e9d5bf41b4b2775bc002c`,
whose installed APK hashes were checked separately.
Final source tests record 537 files / 6273 passing / 9 existing skips, with retries
disabled. Device workflow tests and their individual outcomes, manual SAF selection,
remaining acceptance items and deferred compatibility checks are recorded in the
[acceptance report](../docs/upstream/android-local-acceptance-2026-11-01.md).
Do not infer full-stage completion from these counts. See also the independent
[2026-11-01 review](../docs/upstream/android-local-final-review-2026-11-01.md).

## Redistribution Status

Read [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before sharing an APK.
This documentation is an inventory and a specific list of outstanding notice/source
work, not a complete legal clearance or an accompanying corresponding-source bundle.
The build receipt intentionally records `legalReleaseApproved: false`. The script
does not package these Markdown files into the APK or close the listed obligations.
