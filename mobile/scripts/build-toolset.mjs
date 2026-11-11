import { execFileSync } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.env.JUPITER_ANDROID_OUTPUT ?? join(root, "output/android-local-20261101"));
await mkdir(join(output, "build-recipe"), { recursive: true });
for (const name of ["ubuntu.sources", "policy-rc.d", "resolv.conf", "99build-ca"])
  await cp(join(root, "mobile/rootfs", name), join(output, "build-recipe", name));
await cp(join(root, "mobile/scripts/build-linux-rootfs.sh"), join(output, "build-recipe/build-linux-rootfs.sh"));
const offline = process.argv.includes("--offline");
execFileSync("limactl", ["shell", "jupiter-android-build", "sudo", ...(offline ? ["unshare", "-n"] : []), "bash", "/work/build-recipe/build-linux-rootfs.sh", ...(offline ? ["--offline"] : [])], { stdio: "inherit" });
