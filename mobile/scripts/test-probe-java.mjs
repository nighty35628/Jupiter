import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const java = process.env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home";
const temporary = await mkdtemp(join(tmpdir(), "jupiter-java-probe-"));
try {
  await mkdir(join(temporary, "classes"));
  execFileSync(join(java, "bin/javac"), ["-d", join(temporary, "classes"), join(root, "mobile/android/shared/dev/jupiter/mobile/runtime/BoundedLines.java"), join(root, "mobile/android/probe/tests/BoundedLinesTest.java")], { stdio: "inherit" });
  execFileSync(join(java, "bin/java"), ["-Xmx32m", "-cp", join(temporary, "classes"), "dev.jupiter.mobile.qa.BoundedLinesTest"], { stdio: "inherit" });
} finally { await rm(temporary, { recursive: true, force: true }); }
