import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const directory of ["dist", "dist/cli"]) {
  await mkdir(join(root, directory), { recursive: true });
  await cp(
    join(root, "src/attachments/image-worker.cjs"),
    join(root, directory, "image-worker.cjs"),
  );
}
for (const name of ["@silvia-odwyer/photon-node", "image-size"]) {
  const target = join(root, "dist/node_modules", name);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, "node_modules", name), target, { recursive: true, dereference: true });
}
