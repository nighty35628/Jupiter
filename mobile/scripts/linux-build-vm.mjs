import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.env.JUPITER_ANDROID_OUTPUT ?? join(root, "output/android-local-20261101"));
const lock = JSON.parse(await readFile(join(root, "mobile/build-environment-lock.json"), "utf8"));
const image = join(output, "downloads", lock.linuxBuildImage.name);
if (createHash("sha256").update(await readFile(image)).digest("hex") !== lock.linuxBuildImage.sha256)
  throw new Error("Linux build image checksum mismatch");
const config = {
  vmType: "vz", arch: "aarch64", cpus: 2, memory: "1536MiB", disk: "4GiB",
  images: [{ location: pathToFileURL(image).href, arch: "aarch64", digest: `sha256:${lock.linuxBuildImage.sha256}` }],
  mounts: [{ location: output, mountPoint: "/work", writable: true }], mountType: "virtiofs",
  ssh: { loadDotSSHPubKeys: false, forwardAgent: false, forwardX11: false, forwardX11Trusted: false },
  containerd: { user: false, system: false }, upgradePackages: false, propagateProxyEnv: false,
  rosetta: { enabled: false, binfmt: false },
};
const path = join(output, "linux-build-vm.yaml");
await writeFile(path, JSON.stringify(config, null, 2));
const name = "jupiter-android-build";
const existing = execFileSync("limactl", ["list", "--json"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(JSON.parse);
const instance = existing.find(item => item.name === name);
if (instance) {
  if (instance.config?.mounts?.length !== 1 || instance.config.mounts[0].location !== output ||
      instance.config.images?.[0]?.digest !== `sha256:${lock.linuxBuildImage.sha256}`)
    throw new Error("Refusing to reuse an unrelated Linux build VM");
} else execFileSync("limactl", ["create", "--tty=false", `--name=${name}`, path], { stdio: "inherit" });
execFileSync("limactl", ["start", "--tty=false", name], { stdio: "inherit" });
