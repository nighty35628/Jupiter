import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detachHardlinks,
  runtimeFingerprint,
  treeBytes,
} from "../mobile/scripts/runtime-files.mjs";

describe("Android runtime archive inputs", { retry: 0 }, () => {
  it("converts hardlinks to independent files without traversing symlinks", async () => {
    const parent = await mkdtemp(join(tmpdir(), "jupiter-runtime-test-"));
    try {
      const root = join(parent, "root");
      await mkdir(root);
      await writeFile(join(root, "a"), "same contents", { mode: 0o755 });
      await link(join(root, "a"), join(root, "b"));
      await mkdir(join(parent, "outside"));
      await writeFile(join(parent, "outside/file"), "outside");
      await link(join(parent, "outside/file"), join(parent, "outside/other"));
      await symlink(join(parent, "outside"), join(root, "directory-link"));
      expect(await detachHardlinks(root)).toBeGreaterThan(0);
      expect((await lstat(join(root, "a"))).nlink).toBe(1);
      expect((await lstat(join(root, "b"))).nlink).toBe(1);
      if (process.platform !== "win32") {
        expect((await lstat(join(root, "a"))).mode & 0o777).toBe(0o755);
      }
      expect(await readFile(join(root, "b"), "utf8")).toBe("same contents");
      expect(await treeBytes(root)).toBe(26);
      expect((await lstat(join(parent, "outside/file"))).nlink).toBe(2);
      expect(await detachHardlinks(root)).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("invalidates the runtime for every pinned input and ignores mirror-only changes", () => {
    const lock = {
      abi: "arm64-v8a",
      inputs: [
        { name: "base", sha256: "a" },
        { name: "node", sha256: "b" },
      ],
    };
    expect(runtimeFingerprint(lock)).not.toBe(
      runtimeFingerprint({
        ...lock,
        inputs: [lock.inputs[0], { ...lock.inputs[1], sha256: "new" }],
      }),
    );
    expect(runtimeFingerprint(lock)).toBe(
      runtimeFingerprint({
        ...lock,
        inputs: lock.inputs.map((input) => ({ ...input, url: "mirror" })),
      }),
    );
    expect(runtimeFingerprint(lock)).not.toBe(runtimeFingerprint({ ...lock, abi: "x86_64" }));
    expect(runtimeFingerprint(lock)).not.toBe(
      runtimeFingerprint({ ...lock, toolset: { name: "tools", sha256: "a" } }),
    );
    expect(runtimeFingerprint({ ...lock, toolset: { name: "tools", sha256: "a" } })).not.toBe(
      runtimeFingerprint({ ...lock, toolset: { name: "tools", sha256: "b" } }),
    );
  });
});
