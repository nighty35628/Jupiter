import { readAndroidBootstrap } from "./bootstrap.js";
import { getAndroidRuntimeContext } from "./runtime-context.js";

try {
  await readAndroidBootstrap(process.stdin);
  const context = getAndroidRuntimeContext()!;
  if (context.role === "host") {
    const { startAndroidHost } = await import("./host.js");
    await startAndroidHost();
  } else {
    if (process.argv[2] !== "desktop") throw new Error("Invalid Android child role command");
    await import("../cli/index.js");
  }
} catch {
  // Do not serialize bootstrap data, config contents, or arbitrary error payloads.
  process.stderr.write("Jupiter Android could not initialize its private runtime.\n");
  process.exitCode = 1;
}
