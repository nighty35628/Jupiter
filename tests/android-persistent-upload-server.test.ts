import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WebServerHandle, startWebServer } from "../src/web/server.js";
import { SequencedPacketBuffer, type WebSidecar } from "../src/web/sidecar.js";
import { WorkspaceRegistry } from "../src/web/workspaces.js";

const android = vi.hoisted(() => ({
  current: undefined as undefined | { role: string; configPath: string },
}));
vi.mock("../src/mobile/runtime-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/mobile/runtime-context.js")>()),
  getAndroidRuntimeContext: () => android.current,
}));

class Sidecar implements WebSidecar {
  runtimeEpoch = randomUUID();
  buffer = new SequencedPacketBuffer();
  commands: Record<string, unknown>[] = [];
  get latestSequence() {
    return this.buffer.latestSequence;
  }
  subscribe: WebSidecar["subscribe"] = (listener) => this.buffer.subscribe(listener);
  replayAfter: WebSidecar["replayAfter"] = (...args) => this.buffer.replayAfter(...args);
  async send(command: Record<string, unknown>) {
    this.commands.push(command);
  }
  async close() {}
}

let home: string;
const handles: WebServerHandle[] = [];
const controllers: AbortController[] = [];
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "jupiter-android-upload-server-")));
  android.current = { role: "host", configPath: join(home, ".jupiter", "config.json") };
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const handle of handles.splice(0)) await handle.close();
  android.current = undefined;
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
async function start() {
  const registry = new WorkspaceRegistry();
  const sidecar = new Sidecar();
  // An untrusted option must never select persistence for ordinary Web.
  const options = {
    sidecar,
    workspaces: registry,
    bootstrapToken: "synthetic-upload-bootstrap",
    persistentRoot: join(home, "frontend-selected-root"),
  };
  const handle = await startWebServer(options);
  handles.push(handle);
  return { handle, registry, sidecar };
}
async function writer(handle: WebServerHandle) {
  const response = await fetch(`${handle.baseUrl}/api/bootstrap`, {
    method: "POST",
    headers: { origin: handle.origin, "content-type": "application/json" },
    body: JSON.stringify({ token: "synthetic-upload-bootstrap" }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0];
  const { csrfToken } = await response.json();
  const connection = randomUUID();
  const controller = new AbortController();
  controllers.push(controller);
  const events = await fetch(`${handle.baseUrl}/api/events?connectionId=${connection}`, {
    headers: { cookie },
    signal: controller.signal,
  });
  expect(events.status).toBe(200);
  const headers = {
    cookie,
    origin: handle.origin,
    "x-jupiter-csrf": csrfToken,
    "x-jupiter-connection": connection,
    "content-type": "application/json",
  };
  const acquired = await fetch(`${handle.baseUrl}/api/lease/acquire`, {
    method: "POST",
    headers,
    body: "{}",
  });
  expect(acquired.status).toBe(200);
  const { lease } = await acquired.json();
  return { ...headers, "x-jupiter-lease": lease.id, "x-jupiter-fence": String(lease.fence) };
}

describe("trusted Android upload persistence over real HTTP", { retry: 0 }, () => {
  it("reopens an old nonimage draft token, authorizes it, reads its bytes, and deletes it durably", async () => {
    const a = await start();
    const firstAuth = await writer(a.handle);
    const uploaded = await fetch(`${a.handle.baseUrl}/api/files/upload?name=shared.txt`, {
      method: "POST",
      headers: { ...firstAuth, "content-type": "text/plain" },
      body: "persistent share bytes",
    });
    expect(uploaded.status).toBe(201);
    const { file } = await uploaded.json();
    await a.handle.close();
    const b = await start();
    const auth = await writer(b.handle);
    const downloaded = await fetch(`${b.handle.baseUrl}/api/files/${file.id}`, {
      headers: { cookie: auth.cookie },
    });
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe("persistent share bytes");
    const dispatched = await fetch(`${b.handle.baseUrl}/api/rpc`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        commandId: "reopened_share_draft",
        payload: { cmd: "user_input", text: `read @jupiter-file:${file.id}` },
      }),
    });
    expect(dispatched.status).toBe(202);
    expect(b.sidecar.commands.find((command) => command.cmd === "user_input")?.text).toBe(
      `read @${join(home, ".jupiter", "uploads", file.id, "blob")}`,
    );
    expect(await readFile(b.registry.resolveFile(file.id).absolutePath, "utf8")).toBe(
      "persistent share bytes",
    );
    expect(await readdir(join(home, ".jupiter"))).toEqual(["uploads"]);
    expect(
      (await fetch(`${b.handle.baseUrl}/api/files/${file.id}`, { method: "DELETE", headers: auth }))
        .status,
    ).toBe(200);
    await b.handle.close();
    const c = await start();
    expect(() => c.registry.resolveFile(file.id)).toThrow(/expired/);
    expect(await readdir(join(home, ".jupiter", "uploads"))).toEqual([]);
  });

  it.each([undefined, "interactive", "scheduled"])(
    "keeps non-host %s uploads ephemeral despite frontend/environment flags",
    async (role) => {
      android.current = role
        ? { role, configPath: join(home, ".jupiter", "config.json") }
        : undefined;
      vi.stubEnv("JUPITER_RUNTIME_SURFACE", "android");
      vi.stubEnv("JUPITER_ANDROID", "1");
      const a = await start();
      const auth = await writer(a.handle);
      const response = await fetch(`${a.handle.baseUrl}/api/files/upload?name=shared.txt`, {
        method: "POST",
        headers: { ...auth, "content-type": "text/plain" },
        body: "ephemeral bytes",
      });
      expect(response.status).toBe(201);
      const { file } = await response.json();
      const path = a.registry.resolveFile(file.id).absolutePath;
      await a.handle.close();
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(home, ".jupiter"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(home, "frontend-selected-root"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("does not persist a cancelled HTTP body", async () => {
    const a = await start();
    const auth = await writer(a.handle);
    const req = request(`${a.handle.baseUrl}/api/files/upload?name=cancelled.txt`, {
      method: "POST",
      headers: { ...auth, "content-type": "text/plain", "content-length": "20" },
    });
    req.on("error", () => {});
    req.write("partial");
    const root = join(home, ".jupiter", "uploads");
    await vi.waitFor(async () =>
      expect((await readdir(root)).some((name) => name.startsWith(".staging-"))).toBe(true),
    );
    req.destroy();
    await vi.waitFor(async () => expect(await readdir(root)).toEqual([]));
    await a.handle.close();
    const b = await start();
    expect(await readdir(root)).toEqual([]);
    expect(b.registry.list()).toEqual([]);
  });
});
