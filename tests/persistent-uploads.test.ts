import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeDesktopCommand } from "../src/web/policy.js";
import { UploadStore } from "../src/web/uploads.js";
import { WorkspaceRegistry } from "../src/web/workspaces.js";

let home: string;
let root: string;
const stores: UploadStore[] = [];
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "jupiter-persistent-uploads-")));
  root = join(home, ".jupiter", "uploads");
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await rm(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function create(registry = new WorkspaceRegistry(), options = {}) {
  const store = await UploadStore.create(registry, { persistentRoot: root, ...options });
  stores.push(store);
  return { registry, store };
}
async function* body(value = "synthetic shared text") {
  yield Buffer.from(value);
}

describe("persistent Android upload quarantine", { retry: 0 }, () => {
  it("restores stable old draft tokens and bytes into a fresh existing registry after close/restart", async () => {
    const first = await create();
    const received = await first.store.receive("shared.txt", "text/plain", body());
    expect(received.file.lifecycle).toBe("session");
    await first.store.close();
    const second = await create();
    const command = await authorizeDesktopCommand(
      { cmd: "user_input", text: `inspect @jupiter-file:${received.file.id}` },
      {
        mode: "local",
        workspaces: second.registry,
      },
    );
    expect(command.command.text).toBe(`inspect @${join(root, received.file.id, "blob")}`);
    const opened = await second.registry.openFile(received.file.id);
    try {
      expect(await opened.handle.readFile("utf8")).toBe("synthetic shared text");
    } finally {
      await opened.handle.close();
    }
    expect(opened.ref).toEqual(received.file);
    expect((await readdir(root)).sort()).toEqual([received.file.id]);
    expect((await readdir(join(root, received.file.id))).sort()).toEqual(["blob", "meta.json"]);
  });

  it("retains ordinary Web's ephemeral close cleanup", async () => {
    const registry = new WorkspaceRegistry();
    const store = await UploadStore.create(registry);
    stores.push(store);
    const result = await store.receive("ephemeral.txt", "text/plain", body());
    const path = registry.resolveFile(result.file.id).absolutePath;
    expect(result.file.lifecycle).toBe("runtime");
    expect(await readFile(path, "utf8")).toBe("synthetic shared text");
    await store.close();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not follow an outside symlink substituted after a valid restore", async () => {
    const a = await create();
    const result = await a.store.receive("a.txt", undefined, body("allowed"));
    await a.store.close();
    const b = await create();
    const path = b.registry.resolveFile(result.file.id).absolutePath;
    const outside = join(home, "outside.txt");
    await writeFile(outside, "synthetic outside bytes");
    await rm(path);
    await symlink(outside, path);
    await expect(b.registry.openFile(result.file.id)).rejects.toThrow(/symbolic links/);
    expect(await readFile(outside, "utf8")).toBe("synthetic outside bytes");
  });

  it("retains the documented default 100-file limit after restoring 100 empty uploads", async () => {
    const a = await create();
    const seed = await a.store.receive("empty.txt", undefined, body(""), 0);
    const metadata = JSON.parse(await readFile(join(root, seed.file.id, "meta.json"), "utf8"));
    await a.store.close();
    const add = async () => {
      const id = randomUUID();
      const path = join(root, id);
      await mkdir(path);
      await writeFile(join(path, "blob"), "");
      await writeFile(join(path, "meta.json"), JSON.stringify({ ...metadata, id }));
    };
    await Promise.all(Array.from({ length: 99 }, add));
    const b = await create();
    await expect(b.store.receive("overflow.txt", undefined, body(""), 0)).rejects.toThrow(
      /file limit/,
    );
    await b.store.close();
    await add();
    await expect(create()).rejects.toThrow(/quota/);
  });

  it("recomputes both file and byte quotas after restart, and releases them on explicit delete", async () => {
    const options = { maxFiles: 1, maxFileBytes: 8, maxTotalBytes: 8 };
    const a = await create(undefined, options);
    const result = await a.store.receive("a.txt", "text/plain", body("12345678"), 8);
    await a.store.close();
    const b = await create(undefined, options);
    await expect(b.store.receive("b.txt", undefined, body("x"), 1)).rejects.toThrow(/file limit/);
    expect(await b.store.remove(result.file.id)).toBe(true);
    expect(await readdir(root)).toEqual([]);
    expect(() => b.registry.resolveFile(result.file.id)).toThrow(/expired/);
    const next = await b.store.receive("b.txt", undefined, body("12345678"), 8);
    await b.store.close();
    const c = await create(undefined, { ...options, maxFiles: 2 });
    await expect(c.store.receive("c.txt", undefined, body("x"), 1)).rejects.toThrow(/quota/);
    expect(await c.store.remove(next.file.id)).toBe(true);
    await c.store.close();
    const d = await create();
    expect(() => d.registry.resolveFile(next.file.id)).toThrow(/expired/);
  });

  it.each(["broken", "short", "oversized", "closed"])(
    "does not commit a %s receive, including across restart",
    async (kind) => {
      const f = await create(undefined, { maxFileBytes: 8, maxTotalBytes: 8 });
      async function* failed() {
        yield Buffer.from("one");
        if (kind === "broken") throw Error("cancelled stream");
        if (kind === "closed") await f.store.close();
        if (kind === "oversized") yield Buffer.alloc(9);
      }
      await expect(
        f.store.receive("failed.txt", undefined, failed(), kind === "short" ? 8 : undefined),
      ).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
      await f.store.close();
      const restarted = await create();
      expect(await readdir(root)).toEqual([]);
      expect((await restarted.store.receive("ok.txt", undefined, body("ok"), 2)).file.size).toBe(2);
    },
  );

  it("rolls back a commit failure and removes abandoned pre-commit staging on restart", async () => {
    const registry = new WorkspaceRegistry();
    const f = await create(registry);
    vi.spyOn(registry, "registerRuntimeFile").mockImplementationOnce(() => {
      throw Error("injected registration failure");
    });
    await expect(f.store.receive("failed.txt", undefined, body())).rejects.toThrow(/injected/);
    expect(await readdir(root)).toEqual([]);
    const stage = join(root, `.staging-${randomUUID()}`);
    await mkdir(stage);
    await writeFile(join(stage, "blob"), "uncommitted bytes");
    await f.store.close();
    await create();
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    "root",
    "parent",
    "entry",
    "metadata",
    "blob",
    "hardlink",
    "directory",
    "oversized-metadata",
    "path-metadata",
    "hash",
    "quota",
  ])("refuses unsafe/corrupt %s restore without registering its token", async (kind) => {
    const f = await create();
    const result = await f.store.receive("a.txt", "text/plain", body("data"), 4);
    const entry = join(root, result.file.id);
    await f.store.close();
    const outside = join(home, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "data");
    if (kind === "root" || kind === "parent" || kind === "entry") {
      const target = kind === "root" ? root : kind === "parent" ? join(home, ".jupiter") : entry;
      const moved = `${target}-real`;
      await rename(target, moved);
      await symlink(moved, target);
    } else if (
      kind === "metadata" ||
      kind === "blob" ||
      kind === "hardlink" ||
      kind === "directory"
    ) {
      const target = join(entry, kind === "metadata" ? "meta.json" : "blob");
      await rm(target);
      if (kind === "hardlink") await link(join(outside, "secret"), target);
      else if (kind === "directory") await mkdir(target);
      else await symlink(join(outside, "secret"), target);
    } else if (kind === "oversized-metadata")
      await writeFile(join(entry, "meta.json"), " ".repeat(4097));
    else if (kind === "path-metadata") {
      const metadata = JSON.parse(await readFile(join(entry, "meta.json"), "utf8"));
      metadata.absolutePath = join(outside, "secret");
      await writeFile(join(entry, "meta.json"), JSON.stringify(metadata));
    } else if (kind === "hash") await writeFile(join(entry, "blob"), "evil");
    const registry = new WorkspaceRegistry();
    await expect(create(registry, kind === "quota" ? { maxTotalBytes: 3 } : {})).rejects.toThrow();
    expect(() => registry.resolveFile(result.file.id)).toThrow(/expired/);
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("data");
  });

  it("does not forget unrelated file references or allow restored IDs to overwrite them", async () => {
    const f = await create();
    const unrelated = f.registry.registerRuntimeFile(join(home, "other"), {
      name: "other",
      source: "generated",
      size: 0,
      modifiedMs: 0,
      lifecycle: "runtime",
    });
    expect(await f.store.remove(unrelated.id)).toBe(false);
    expect(f.registry.resolveFile(unrelated.id).ref).toEqual(unrelated);
    const result = await f.store.receive("a.txt", undefined, body());
    await f.store.close();
    const registry = new WorkspaceRegistry();
    const existing = registry.registerRuntimeFile(
      join(home, "unrelated"),
      {
        name: "unrelated",
        source: "generated",
        size: 0,
        modifiedMs: 0,
        lifecycle: "runtime",
      },
      result.file.id,
    );
    await expect(create(registry)).rejects.toThrow(/already registered/);
    expect(registry.resolveFile(existing.id).ref).toEqual(existing);
    expect(() => registry.registerRuntimeFile(join(home, "x"), existing, "../escape")).toThrow(
      /UUID/,
    );
  });
});
