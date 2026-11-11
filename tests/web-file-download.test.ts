import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WebServerHandle, startWebServer } from "../src/web/server.js";
import { SequencedPacketBuffer } from "../src/web/sidecar.js";
import { WorkspaceRegistry } from "../src/web/workspaces.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) };
});

const actualFs = await vi.importActual<typeof fs>("node:fs/promises");

describe("workspace file downloads", { retry: 0 }, () => {
  let root: string;
  let workspace: string;
  let outside: string;
  let registry: WorkspaceRegistry;
  let workspaceId: string;
  let server: WebServerHandle | undefined;
  let cookie: string;

  beforeEach(async () => {
    vi.mocked(fs.open).mockReset().mockImplementation(actualFs.open);
    vi.mocked(fs.lstat).mockReset().mockImplementation(actualFs.lstat);
    root = await mkdtemp(join(tmpdir(), "jupiter-file-download-"));
    workspace = join(root, "workspace");
    outside = join(root, "workspace-other");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(workspace, "note.txt"), "hello workspace");
    await writeFile(join(outside, "secret.txt"), "synthetic outside secret");
    registry = await WorkspaceRegistry.create([workspace]);
    workspaceId = registry.list()[0]!.id;
    const buffer = new SequencedPacketBuffer();
    const token = "file-download-tests-only-bootstrap";
    server = await startWebServer({
      bootstrapToken: token,
      workspaces: registry,
      sidecar: {
        runtimeEpoch: "file-download-tests",
        latestSequence: 0,
        send: async () => {
          throw new Error("file download tests must not dispatch commands");
        },
        subscribe: (listener) => buffer.subscribe(listener),
        replayAfter: (sequence, through) => buffer.replayAfter(sequence, through),
        close: async () => {},
      },
    });
    const auth = await fetch(`${server.baseUrl}/api/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.origin },
      body: JSON.stringify({ token }),
    });
    expect(auth.status).toBe(200);
    cookie = (auth.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
    await auth.arrayBuffer();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.close();
    server = undefined;
    await rm(root, { recursive: true, force: true });
  });

  function download(fileId: string, method = "GET", range?: string) {
    return fetch(`${server!.baseUrl}/api/files/${fileId}`, {
      method,
      headers: { cookie, ...(range ? { range } : {}) },
    });
  }

  it.each(["GET", "HEAD"])("downloads a normal file with %s", async (method) => {
    const ref = await registry.issueWorkspaceFile(workspaceId, "note.txt", "text/plain");
    const response = await download(ref.id, method);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("15");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-disposition")).toContain("note.txt");
    expect(await response.text()).toBe(method === "HEAD" ? "" : "hello workspace");
  });

  it.each(["GET", "HEAD"])("supports byte ranges with %s", async (method) => {
    const ref = await registry.issueWorkspaceFile(workspaceId, "note.txt");
    const response = await download(ref.id, method, "bytes=6-14");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 6-14/15");
    expect(response.headers.get("content-length")).toBe("9");
    expect(await response.text()).toBe(method === "HEAD" ? "" : "workspace");
  });

  it("allows symlinks whose canonical target stays in the issuing workspace", async () => {
    const ref = await registry.issueWorkspaceFile(workspaceId, "note.txt");
    await writeFile(join(workspace, "replacement.txt"), "allowed replacement");
    await unlink(join(workspace, "note.txt"));
    await symlink(join(workspace, "replacement.txt"), join(workspace, "note.txt"));
    const response = await download(ref.id);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("allowed replacement");
  });

  it("accepts an in-workspace symlink at issuance but rejects traversal and outside links", async () => {
    await symlink(join(workspace, "note.txt"), join(workspace, "alias.txt"));
    const ref = await registry.issueWorkspaceFile(workspaceId, "alias.txt");
    const response = await download(ref.id);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello workspace");
    await symlink(join(outside, "secret.txt"), join(workspace, "outside.txt"));
    for (const path of ["outside.txt", "../workspace-other/secret.txt"]) {
      await expect(registry.issueWorkspaceFile(workspaceId, path)).rejects.toThrow(
        "outside the authorized workspace",
      );
    }
  });

  it.each(["GET", "HEAD"])(
    "rejects a cached file replaced by an outside symlink with %s",
    async (method) => {
      const ref = await registry.issueWorkspaceFile(workspaceId, "note.txt");
      await unlink(join(workspace, "note.txt"));
      await symlink(join(outside, "secret.txt"), join(workspace, "note.txt"));
      await expect(registry.resolveExisting(workspaceId, "note.txt")).rejects.toThrow(
        "outside the authorized workspace",
      );
      const response = await download(ref.id, method);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("synthetic outside secret");
    },
  );

  it("rejects a parent directory replaced by an outside symlink", async () => {
    await mkdir(join(workspace, "nested"));
    await writeFile(join(workspace, "nested", "secret.txt"), "allowed");
    const ref = await registry.issueWorkspaceFile(workspaceId, "nested/secret.txt");
    await rename(join(workspace, "nested"), join(workspace, "original"));
    await symlink(outside, join(workspace, "nested"), "dir");
    const response = await download(ref.id);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("synthetic outside secret");
  });

  it("rejects a link into a different registered workspace", async () => {
    await registry.register(outside);
    const ref = await registry.issueWorkspaceFile(workspaceId, "note.txt");
    await unlink(join(workspace, "note.txt"));
    await symlink(join(outside, "secret.txt"), join(workspace, "note.txt"));
    const response = await download(ref.id);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("synthetic outside secret");
  });

  it("rejects deleted files and directory replacements", async () => {
    const ref = await registry.issueWorkspaceFile(workspaceId, "note.txt");
    await unlink(join(workspace, "note.txt"));
    let response = await download(ref.id);
    expect(response.status).toBe(404);
    await response.arrayBuffer();
    await mkdir(join(workspace, "note.txt"));
    response = await download(ref.id);
    expect(response.status).toBe(404);
    await response.arrayBuffer();
  });

  it("uses current file metadata after an authorized regular-file replacement", async () => {
    const ref = await registry.issueWorkspaceFile(workspaceId, "note.txt");
    await writeFile(join(workspace, "new.txt"), "new");
    await rename(join(workspace, "new.txt"), join(workspace, "note.txt"));
    const response = await download(ref.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("3");
    expect(await response.text()).toBe("new");
  });

  it("continues to download explicitly registered runtime files outside workspaces", async () => {
    const ref = registry.registerRuntimeFile(join(outside, "secret.txt"), {
      source: "generated",
      name: "generated.txt",
      size: 24,
      modifiedMs: 0,
      lifecycle: "runtime",
    });
    const response = await download(ref.id);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("synthetic outside secret");
  });

  it("rejects an outside symlink substituted between validation and open", async () => {
    const ref = await registry.issueWorkspaceFile(workspaceId, "note.txt");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      await unlink(join(workspace, "note.txt"));
      await symlink(join(outside, "secret.txt"), join(workspace, "note.txt"));
      return actualFs.open(...args);
    });
    const response = await download(ref.id);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("synthetic outside secret");
    expect(fs.open).toHaveBeenCalledOnce();
  });

  it.each(["before-open", "after-open"])(
    "rejects a parent-directory swap %s and closes the opened fd",
    async (phase) => {
      await mkdir(join(workspace, "nested"));
      await writeFile(join(workspace, "nested", "secret.txt"), "allowed");
      const ref = await registry.issueWorkspaceFile(workspaceId, "nested/secret.txt");
      let handle: fs.FileHandle | undefined;
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        if (phase === "after-open") handle = await actualFs.open(...args);
        try {
          await rename(join(workspace, "nested"), join(workspace, "original"));
          await symlink(outside, join(workspace, "nested"), "dir");
        } catch (error) {
          await handle?.close();
          throw error;
        }
        handle ??= await actualFs.open(...args);
        return handle;
      });
      const response = await download(ref.id);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("synthetic outside secret");
      expect(handle).toBeDefined();
      expect(handle!.fd).toBe(-1);
    },
  );

  it("rejects a parent swap before the initial inode snapshot", async () => {
    await mkdir(join(workspace, "nested"));
    await writeFile(join(workspace, "nested", "secret.txt"), "allowed");
    const ref = await registry.issueWorkspaceFile(workspaceId, "nested/secret.txt");
    vi.mocked(fs.lstat).mockImplementationOnce(async (...args) => {
      await rename(join(workspace, "nested"), join(workspace, "original"));
      await symlink(outside, join(workspace, "nested"), "dir");
      return actualFs.lstat(...args);
    });
    const response = await download(ref.id);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("synthetic outside secret");
  });

  it.each([undefined, "bytes=6-14"])(
    "reads the validated fd even if the cached path is replaced before streaming (%s)",
    async (range) => {
      const ref = await registry.issueWorkspaceFile(workspaceId, "note.txt");
      const openFile = registry.openFile.bind(registry);
      let handle: fs.FileHandle | undefined;
      vi.spyOn(registry, "openFile").mockImplementationOnce(async (id) => {
        const opened = await openFile(id);
        handle = opened.handle;
        await unlink(join(workspace, "note.txt"));
        await symlink(join(outside, "secret.txt"), join(workspace, "note.txt"));
        return opened;
      });
      const response = await download(ref.id, "GET", range);
      expect(response.status).toBe(range ? 206 : 200);
      expect(await response.text()).toBe(range ? "workspace" : "hello workspace");
      await vi.waitFor(() => expect(handle!.fd).toBe(-1));
    },
  );

  it.each(["GET", "HEAD", "invalid-range"])("closes the fd after %s", async (mode) => {
    const ref = await registry.issueWorkspaceFile(workspaceId, "note.txt");
    const openFile = vi.spyOn(registry, "openFile");
    const response = await download(
      ref.id,
      mode === "HEAD" ? "HEAD" : "GET",
      mode === "invalid-range" ? "bytes=99-100" : undefined,
    );
    expect(response.status).toBe(mode === "invalid-range" ? 404 : 200);
    await response.arrayBuffer();
    const opened = await openFile.mock.results[0]!.value;
    await vi.waitFor(() => expect(opened.handle.fd).toBe(-1));
  });

  it("closes the fd when a client cancels a streaming download", async () => {
    await writeFile(join(workspace, "large.bin"), Buffer.alloc(8 * 1024 * 1024, 42));
    const ref = await registry.issueWorkspaceFile(workspaceId, "large.bin");
    const openFile = vi.spyOn(registry, "openFile");
    const response = await download(ref.id);
    expect(response.status).toBe(200);
    await response.body!.cancel();
    const opened = await openFile.mock.results[0]!.value;
    await vi.waitFor(() => expect(opened.handle.fd).toBe(-1));
  });

  it("closes the fd on a stream error without sending a second response", async () => {
    const ref = await registry.issueWorkspaceFile(workspaceId, "note.txt");
    const openFile = registry.openFile.bind(registry);
    let handle: fs.FileHandle | undefined;
    vi.spyOn(registry, "openFile").mockImplementationOnce(async (id) => {
      const opened = await openFile(id);
      handle = opened.handle;
      const createReadStream = handle.createReadStream.bind(handle);
      vi.spyOn(handle, "createReadStream").mockImplementationOnce((options) => {
        const stream = createReadStream(options);
        vi.spyOn(stream, "_read").mockImplementation(() => {
          stream.destroy(new Error("synthetic stream failure"));
        });
        return stream;
      });
      return opened;
    });
    await expect(download(ref.id).then((response) => response.text())).rejects.toThrow();
    await vi.waitFor(() => expect(handle!.fd).toBe(-1));
  });

  it("rejects unknown and forgotten file ids", async () => {
    const ref = await registry.issueWorkspaceFile(workspaceId, "note.txt");
    registry.forgetFile(ref.id);
    for (const id of [ref.id, "unknown-file-id"]) {
      const response = await download(id);
      expect(response.status).toBe(404);
      await response.arrayBuffer();
    }
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("downloads an empty file", async () => {
    await writeFile(join(workspace, "empty.txt"), "");
    const ref = await registry.issueWorkspaceFile(workspaceId, "empty.txt");
    const response = await download(ref.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("0");
    expect(await response.text()).toBe("");
  });
});
