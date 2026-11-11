import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, readdir, rename, utimes } from "node:fs/promises";
import { join } from "node:path";

export function runtimeFingerprint(lock) {
  return createHash("sha256").update(JSON.stringify({
    format: 2,
    abi: lock.abi,
    inputs: lock.inputs.map(({ name, sha256 }) => ({ name, sha256 })),
    toolset: lock.toolset ? { name: lock.toolset.name, sha256: lock.toolset.sha256 } : null,
  })).digest("hex");
}

export async function treeBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isDirectory()) bytes += await treeBytes(path);
    else if (metadata.isFile()) bytes += metadata.size;
  }
  return bytes;
}

/** Android denies link(2) in app data; archive independent file contents instead. */
export async function detachHardlinks(directory) {
  let detached = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isDirectory()) detached += await detachHardlinks(path);
    else if (metadata.isFile() && metadata.nlink > 1) {
      const temp = join(directory, `.jupiter-detach-${randomUUID()}`);
      await copyFile(path, temp);
      await chmod(temp, metadata.mode & 0o777);
      await utimes(temp, metadata.atime, metadata.mtime);
      await rename(temp, path);
      detached++;
    }
  }
  return detached;
}
