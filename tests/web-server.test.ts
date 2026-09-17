import { type ClientRequest, type IncomingMessage, request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RawData, WebSocket } from "ws";
import { attachments } from "../src/attachments/store.js";
import { type WebServerHandle, startWebServer } from "../src/web/server.js";
import {
  type ReplayResult,
  SequencedPacketBuffer,
  type SequencedWebPacket,
  type WebDownlinkPacket,
  type WebSidecar,
} from "../src/web/sidecar.js";

const BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-123456";
const PROXY_SECRET = "proxy-secret-for-tests-that-is-longer-than-thirty-two-characters";

class FakeSidecar implements WebSidecar {
  readonly runtimeEpoch = "runtime-test-epoch";
  readonly commands: Record<string, unknown>[] = [];
  readonly closeMock = vi.fn(async () => {});
  private readonly buffer: SequencedPacketBuffer;

  constructor(maxPackets = 100) {
    this.buffer = new SequencedPacketBuffer({ maxPackets, maxBytes: 1024 * 1024 });
  }

  get latestSequence(): number {
    return this.buffer.latestSequence;
  }

  async send(command: Record<string, unknown>): Promise<void> {
    this.commands.push(command);
  }

  subscribe(listener: (packet: SequencedWebPacket) => void): () => void {
    return this.buffer.subscribe(listener);
  }

  replayAfter(sequence: number, through?: number): ReplayResult {
    return this.buffer.replayAfter(sequence, through);
  }

  close(): Promise<void> {
    return this.closeMock();
  }

  emit(packet: WebDownlinkPacket): SequencedWebPacket {
    return this.buffer.append(packet);
  }
}

type Auth = {
  cookie: string;
  csrfToken: string;
  workspaceId: string;
  lease?: { id: string; fence: number };
};

const handles: WebServerHandle[] = [];
const openStreams: TestEventStream[] = [];

afterEach(async () => {
  for (const stream of openStreams.splice(0)) stream.close();
  for (const handle of handles.splice(0)) await handle.close();
  vi.restoreAllMocks();
});

async function start(sidecar = new FakeSidecar()) {
  const handle = await startWebServer({ sidecar, bootstrapToken: BOOTSTRAP_TOKEN });
  handles.push(handle);
  return { handle, sidecar };
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function startLan(sidecar = new FakeSidecar(), highRiskEnabled = false) {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const handle = await startWebServer({
    sidecar,
    bootstrapToken: BOOTSTRAP_TOKEN,
    mode: "lan",
    host: "127.0.0.1",
    port,
    origin,
    highRiskEnabled,
  });
  handles.push(handle);
  return { handle, sidecar };
}

async function startPublic(sidecar = new FakeSidecar()) {
  const port = await reservePort();
  const origin = "https://jupiter.example.test";
  const handle = await startWebServer({
    sidecar,
    bootstrapToken: BOOTSTRAP_TOKEN,
    mode: "public",
    host: "127.0.0.1",
    port,
    origin,
    proxySecret: PROXY_SECRET,
  });
  handles.push(handle);
  return { handle, sidecar };
}

function openTerminalSocket(handle: WebServerHandle, auth: Auth): Promise<WebSocket> {
  const url = `${handle.baseUrl.replace(/^http/, "ws")}/api/terminal`;
  const socket = new WebSocket(url, {
    origin: handle.origin,
    headers: { cookie: auth.cookie },
  });
  return new Promise((resolveOpen, rejectOpen) => {
    socket.once("open", () => resolveOpen(socket));
    socket.once("error", rejectOpen);
  });
}

function waitForSocketMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      rejectMessage(new Error("terminal WebSocket message timed out"));
    }, 5000);
    const onMessage = (raw: RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolveMessage(message);
    };
    socket.on("message", onMessage);
  });
}

async function authenticate(handle: WebServerHandle): Promise<Auth> {
  const response = await fetch(`${handle.baseUrl}/api/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: handle.baseUrl,
    },
    body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
  });
  expect(response.status).toBe(200);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  const body = (await response.json()) as {
    csrfToken: string;
    workspaces: Array<{ id: string }>;
  };
  return { cookie, csrfToken: body.csrfToken, workspaceId: body.workspaces[0]!.id };
}

function mutationHeaders(auth: Auth, connectionId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    cookie: auth.cookie,
    origin: "",
    "x-jupiter-connection": connectionId,
    "x-jupiter-csrf": auth.csrfToken,
    ...(auth.lease
      ? {
          "x-jupiter-lease": auth.lease.id,
          "x-jupiter-fence": String(auth.lease.fence),
        }
      : {}),
  };
}

async function acquireLease(
  handle: WebServerHandle,
  auth: Auth,
  connectionId: string,
  force = false,
): Promise<void> {
  const headers = mutationHeaders(auth, connectionId);
  headers.origin = handle.origin;
  const response = await fetch(`${handle.baseUrl}/api/lease/acquire`, {
    method: "POST",
    headers,
    body: JSON.stringify(force ? { force: true, confirm: "take-control" } : { force: false }),
  });
  expect(response.status).toBe(200);
  auth.lease = ((await response.json()) as { lease: { id: string; fence: number } }).lease;
}

class TestEventStream {
  private text = "";
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly response: IncomingMessage,
    private readonly request: ClientRequest,
  ) {
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      this.text += chunk;
      for (const waiter of this.waiters) waiter();
    });
  }

  waitFor(expected: string): Promise<string> {
    if (this.text.includes(expected)) return Promise.resolve(this.text);
    return new Promise<string>((resolveWait, rejectWait) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(check);
        rejectWait(new Error(`SSE did not contain ${expected}: ${this.text}`));
      }, 1500);
      const check = () => {
        if (!this.text.includes(expected)) return;
        clearTimeout(timeout);
        this.waiters.delete(check);
        resolveWait(this.text);
      };
      this.waiters.add(check);
    });
  }

  close(): void {
    this.response.destroy();
    this.request.destroy();
  }
}

function connectEvents(
  handle: WebServerHandle,
  auth: Auth,
  connectionId: string,
  lastEventId?: number,
): Promise<TestEventStream> {
  const headers: Record<string, string> = { cookie: auth.cookie };
  if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
  return new Promise<TestEventStream>((resolveConnect, rejectConnect) => {
    const req = request(
      `${handle.baseUrl}/api/events?connectionId=${encodeURIComponent(connectionId)}`,
      { headers },
      (response) => {
        if (response.statusCode !== 200) {
          rejectConnect(new Error(`SSE returned ${response.statusCode}`));
          response.resume();
          return;
        }
        const stream = new TestEventStream(response, req);
        openStreams.push(stream);
        void acquireLease(handle, auth, connectionId)
          .then(() => resolveConnect(stream))
          .catch(rejectConnect);
      },
    );
    req.once("error", rejectConnect);
    req.end();
  });
}

describe("Jupiter Web Beta server", () => {
  it("serves a Web-mode shell while keeping the bootstrap token in the fragment only", async () => {
    const { handle } = await start();
    expect(handle.url).toBe(`${handle.baseUrl}/#bootstrap=${BOOTSTRAP_TOKEN}`);

    const response = await fetch(handle.url);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).toContain('name="jupiter-mode" content="web"');
    expect(html).not.toContain(BOOTSTRAP_TOKEN);
  });

  it("rejects cross-origin bootstrap and issues an HttpOnly Strict cookie on success", async () => {
    const { handle } = await start();
    const rejected = await fetch(`${handle.baseUrl}/api/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
    });
    expect(rejected.status).toBe(403);

    const response = await fetch(`${handle.baseUrl}/api/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: handle.baseUrl },
      body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(
      /HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/,
    );
    expect((await response.json()) as object).toEqual(
      expect.objectContaining({
        csrfToken: expect.any(String),
        device: expect.objectContaining({ id: expect.any(String) }),
        capabilities: expect.objectContaining({ writerLease: true }),
      }),
    );

    const replay = await fetch(`${handle.baseUrl}/api/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: handle.baseUrl },
      body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
    });
    expect(replay.status).toBe(401);
  });

  it("serves the pairing screen's logo without authentication but keeps the session private", async () => {
    const { handle } = await start();
    const response = await fetch(`${handle.baseUrl}/assets/icon.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(
      Buffer.from(await response.arrayBuffer())
        .subarray(0, 8)
        .toString("hex"),
    ).toBe("89504e470d0a1a0a");
    const session = await fetch(`${handle.baseUrl}/api/session`);
    expect(session.status).toBe(401);
  });

  it("keeps public mode behind the trusted HTTPS proxy and advertises restricted capabilities", async () => {
    const { handle } = await startPublic();
    const direct = await fetch(`${handle.baseUrl}/`);
    expect(direct.status).toBe(403);

    const response = await new Promise<{
      status: number;
      headers: IncomingMessage["headers"];
      body: Record<string, any>;
    }>((resolveResponse, rejectResponse) => {
      const body = JSON.stringify({ token: BOOTSTRAP_TOKEN });
      const req = request(
        `${handle.baseUrl}/api/bootstrap`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            host: "jupiter.example.test",
            origin: handle.origin,
            "x-jupiter-proxy-secret": PROXY_SECRET,
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            text += chunk;
          });
          res.on("end", () =>
            resolveResponse({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: JSON.parse(text) as Record<string, any>,
            }),
          );
        },
      );
      req.once("error", rejectResponse);
      req.end(body);
    });
    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]?.[0]).toMatch(
      /^__Host-jupiter_web_session=.*; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+; Secure$/,
    );
    expect(response.body).toEqual(
      expect.objectContaining({
        capabilities: expect.objectContaining({
          mode: "public",
          terminal: false,
          gitWrite: false,
          mcpWrite: false,
          secretWrite: false,
        }),
      }),
    );
  });

  it("requires the session, active controller and CSRF token, then deduplicates commandId", async () => {
    const { handle, sidecar } = await start();
    const auth = await authenticate(handle);
    await connectEvents(handle, auth, "controller_a");
    await vi.waitFor(() =>
      expect(sidecar.commands.some((c) => c.cmd === "desktop_resync")).toBe(true),
    );

    const resync = await fetch(`${handle.baseUrl}/api/rpc`, {
      method: "POST",
      headers: { ...mutationHeaders(auth, "controller_a"), origin: handle.baseUrl },
      body: JSON.stringify({
        commandId: "command_desktop_resync",
        payload: { cmd: "desktop_resync" },
      }),
    });
    expect(resync.status).toBe(202);
    expect(sidecar.commands).toContainEqual(
      expect.objectContaining({
        cmd: "desktop_resync",
        __web: expect.objectContaining({ commandId: "command_desktop_resync" }),
      }),
    );

    const envelope = {
      commandId: "command_12345678",
      payload: { cmd: "user_input", tabId: "tab-real", text: "hello" },
    };
    const rejected = await fetch(`${handle.baseUrl}/api/rpc`, {
      method: "POST",
      headers: {
        ...mutationHeaders(auth, "controller_a"),
        origin: handle.baseUrl,
        "x-jupiter-csrf": "wrong",
      },
      body: JSON.stringify(envelope),
    });
    expect(rejected.status).toBe(403);

    const send = () =>
      fetch(`${handle.baseUrl}/api/rpc`, {
        method: "POST",
        headers: { ...mutationHeaders(auth, "controller_a"), origin: handle.baseUrl },
        body: JSON.stringify(envelope),
      });
    expect((await send()).status).toBe(202);
    const duplicate = await send();
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual(
      expect.objectContaining({ accepted: true, duplicate: true }),
    );
    expect(sidecar.commands.filter((command) => command.cmd === "user_input")).toEqual([
      expect.objectContaining({
        ...envelope.payload,
        __web: expect.objectContaining({ commandId: envelope.commandId }),
      }),
    ]);
  });

  it("protects and serves whitelisted Desktop host reads", async () => {
    const { handle } = await start();
    const auth = await authenticate(handle);
    await connectEvents(handle, auth, "controller_host");
    const response = await fetch(`${handle.baseUrl}/api/host-invoke`, {
      method: "POST",
      headers: { ...mutationHeaders(auth, "controller_host"), origin: handle.baseUrl },
      body: JSON.stringify({
        operationId: "operation_git_info_123",
        command: "git_info",
        args: { workspaceId: auth.workspaceId },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({ isRepo: true, branches: expect.any(Array) }),
      }),
    );
  });

  it("streams native Desktop packets in order and replays only the missed suffix", async () => {
    const { handle, sidecar } = await start();
    const auth = await authenticate(handle);
    const firstResponse = await connectEvents(handle, auth, "controller_a");
    await vi.waitFor(() =>
      expect(sidecar.commands.some((c) => c.cmd === "desktop_resync")).toBe(true),
    );
    const first = sidecar.emit({
      channel: "rpc:event",
      payload: { data: JSON.stringify({ type: "$tab_opened", tabId: "tab-a" }) },
    });
    const firstText = await firstResponse.waitFor("$tab_opened");
    expect(firstText).toContain(`id: ${sidecar.runtimeEpoch}:${first.sequence}`);

    firstResponse.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const second = sidecar.emit({
      channel: "rpc:event",
      payload: { data: JSON.stringify({ type: "$ready", tabId: "tab-a" }) },
    });
    const resyncCount = sidecar.commands.filter(
      (command) => command.cmd === "desktop_resync",
    ).length;
    const secondResponse = await connectEvents(handle, auth, "controller_a", first.sequence);
    const replayed = await secondResponse.waitFor("$ready");
    expect(replayed).toContain(`id: ${sidecar.runtimeEpoch}:${second.sequence}`);
    expect(sidecar.commands.filter((command) => command.cmd === "desktop_resync")).toHaveLength(
      resyncCount,
    );
  });

  it("requests a full Desktop resync when the replay cursor is outside the retained window", async () => {
    const sidecar = new FakeSidecar(2);
    sidecar.emit({ channel: "rpc:stderr", payload: { data: "one" } });
    sidecar.emit({ channel: "rpc:stderr", payload: { data: "two" } });
    sidecar.emit({ channel: "rpc:stderr", payload: { data: "three" } });
    const { handle } = await start(sidecar);
    const auth = await authenticate(handle);
    await connectEvents(handle, auth, "controller_a", 0);
    await vi.waitFor(() =>
      expect(sidecar.commands.some((command) => command.cmd === "desktop_resync")).toBe(true),
    );
  });

  it("keeps multiple observers connected and rejects a stale writer fence", async () => {
    const { handle } = await start();
    const auth = await authenticate(handle);
    const first = await connectEvents(handle, auth, "controller_a");
    await connectEvents(handle, auth, "controller_b");

    const staleLease = { ...auth.lease! };
    await acquireLease(handle, auth, "controller_b", true);

    const response = await fetch(`${handle.baseUrl}/api/rpc`, {
      method: "POST",
      headers: {
        ...mutationHeaders({ ...auth, lease: staleLease }, "controller_a"),
        origin: handle.baseUrl,
      },
      body: JSON.stringify({ commandId: "command_old_page", payload: { cmd: "tab_open" } }),
    });
    expect(response.status).toBe(409);
    expect(await first.waitFor("retry: 1000")).toContain("retry: 1000");
  });

  it("uploads browser files, supports ranges, and resolves opaque references only at dispatch", async () => {
    const { handle, sidecar } = await start();
    const auth = await authenticate(handle);
    await connectEvents(handle, auth, "controller_upload");
    const upload = await fetch(`${handle.baseUrl}/api/files/upload?name=notes.txt`, {
      method: "POST",
      headers: {
        ...mutationHeaders(auth, "controller_upload"),
        origin: handle.baseUrl,
        "content-type": "text/plain",
      },
      body: "hello web file",
    });
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as { file: { id: string; name: string } };
    expect(uploaded.file.name).toBe("notes.txt");

    const range = await fetch(`${handle.baseUrl}/api/files/${uploaded.file.id}`, {
      headers: { cookie: auth.cookie, range: "bytes=0-4" },
    });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("hello");

    const response = await fetch(`${handle.baseUrl}/api/rpc`, {
      method: "POST",
      headers: { ...mutationHeaders(auth, "controller_upload"), origin: handle.baseUrl },
      body: JSON.stringify({
        commandId: "command_uploaded_file",
        payload: {
          cmd: "user_input",
          tabId: "tab-real",
          text: `inspect @jupiter-file:${uploaded.file.id}`,
        },
      }),
    });
    expect(response.status).toBe(202);
    const command = sidecar.commands.find((item) => item.__web && item.cmd === "user_input");
    expect(command?.text).not.toContain("jupiter-file:");
    expect(command?.text).toContain("jupiter-web-uploads-");
  });
  it("normalizes image uploads with the original name and authenticates binary previews", async () => {
    const image = {
      kind: "image" as const,
      id: "a".repeat(64),
      name: "diagram.png",
      width: 2,
      height: 1,
      mime: "image/png" as const,
      bytes: 4,
    };
    const imported = vi.spyOn(attachments, "importBytes").mockResolvedValue(image);
    vi.spyOn(attachments, "read").mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3, 4]),
      mime: image.mime,
      name: image.name,
    });
    const { handle } = await start();
    const auth = await authenticate(handle);
    await connectEvents(handle, auth, "image_controller");
    const uploaded = await fetch(`${handle.baseUrl}/api/files/upload?name=diagram.png`, {
      method: "POST",
      headers: {
        ...mutationHeaders(auth, "image_controller"),
        origin: handle.baseUrl,
        "content-type": "image/png",
      },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(uploaded.status).toBe(201);
    expect((await uploaded.json()).image).toEqual(image);
    expect(imported.mock.calls[0]?.[1]).toBe("diagram.png");
    const anonymous = await fetch(`${handle.baseUrl}/api/images/${image.id}`);
    expect(anonymous.status).toBe(401);
    const preview = await fetch(`${handle.baseUrl}/api/images/${image.id}?thumbnail=1`, {
      headers: { cookie: auth.cookie },
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/png");
    expect(preview.headers.get("cache-control")).toContain("no-store");
    expect(preview.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("redacts host paths from LAN event streams while preserving workspace identity", async () => {
    const { handle, sidecar } = await startLan();
    const auth = await authenticate(handle);
    const stream = await connectEvents(handle, auth, "controller_lan");
    sidecar.emit({
      channel: "rpc:event",
      payload: {
        data: JSON.stringify({
          type: "$settings",
          tabId: "tab-a",
          workspaceDir: process.cwd(),
          recentWorkspaces: [process.cwd()],
          executablePath: `${process.cwd()}/private-tool`,
          baseUrl: "https://private-provider.example/v1",
          apiKeyPrefix: "sk-secret…123",
          providerDialect: "openai-compatible",
          providerLabel: "private-provider.example",
          providerId: "custom-private",
          officialDeepSeek: false,
        }),
      },
    });
    const text = await stream.waitFor("$settings");
    expect(text).not.toContain(process.cwd());
    expect(text).toContain(auth.workspaceId);
    expect(text).toContain("Jupiter");
    expect(text).not.toContain("private-provider");
    expect(text).not.toContain("sk-secret");
    expect(text).not.toContain("openai-compatible");
  });

  it("keeps provider credentials local even when LAN high-risk access is enabled", async () => {
    const { handle, sidecar } = await startLan(new FakeSidecar(), true);
    const auth = await authenticate(handle);
    await connectEvents(handle, auth, "controller_provider");

    const save = await fetch(`${handle.baseUrl}/api/rpc`, {
      method: "POST",
      headers: { ...mutationHeaders(auth, "controller_provider"), origin: handle.origin },
      body: JSON.stringify({
        commandId: "command_provider_save",
        payload: {
          cmd: "settings_save",
          baseUrl: "https://private-provider.example/v1",
          apiKey: "private-key",
          providerDialect: "openai-compatible",
          model: "remote-model",
        },
      }),
    });
    expect(save.status).toBe(202);
    const command = sidecar.commands.find((item) => item.cmd === "settings_save");
    expect(command).toMatchObject({ cmd: "settings_save", model: "remote-model" });
    expect(command).not.toHaveProperty("baseUrl");
    expect(command).not.toHaveProperty("apiKey");
    expect(command).not.toHaveProperty("providerDialect");

    const test = await fetch(`${handle.baseUrl}/api/rpc`, {
      method: "POST",
      headers: { ...mutationHeaders(auth, "controller_provider"), origin: handle.origin },
      body: JSON.stringify({
        commandId: "command_provider_test",
        payload: {
          cmd: "provider_test",
          baseUrl: "https://private-provider.example/v1",
          apiKey: "private-key",
          providerDialect: "openai-compatible",
          model: "remote-model",
        },
      }),
    });
    expect(test.status).toBe(400);
    expect(sidecar.commands.some((item) => item.cmd === "provider_test")).toBe(false);
  });

  it("runs the shared terminal UI over an authenticated and fenced WebSocket PTY", async () => {
    const { handle } = await start();
    const auth = await authenticate(handle);
    await connectEvents(handle, auth, "controller_terminal");
    const socket = await openTerminalSocket(handle, auth);
    const ready = waitForSocketMessage(
      socket,
      (message) => message.type === "ready" && message.id === "test-terminal",
    );
    socket.send(
      JSON.stringify({
        type: "spawn",
        id: "test-terminal",
        workspaceId: auth.workspaceId,
        leaseId: auth.lease!.id,
        fence: auth.lease!.fence,
        cols: 80,
        rows: 24,
      }),
    );
    await ready;

    const output = waitForSocketMessage(
      socket,
      (message) =>
        message.type === "output" && String(message.data).includes("__JUPITER_WEB_PTY__"),
    );
    socket.send(
      JSON.stringify({
        type: "write",
        id: "test-terminal",
        leaseId: auth.lease!.id,
        fence: auth.lease!.fence,
        data: "echo __JUPITER_WEB_PTY__\r",
      }),
    );
    expect(await output).toEqual(expect.objectContaining({ id: "test-terminal" }));
    socket.close();
  });

  it("rejects terminal WebSockets in LAN mode until high-risk access is explicit", async () => {
    const { handle } = await startLan();
    const auth = await authenticate(handle);
    await connectEvents(handle, auth, "controller_lan_terminal");
    const url = `${handle.baseUrl.replace(/^http/, "ws")}/api/terminal`;
    const status = await new Promise<number>((resolveStatus, rejectStatus) => {
      const socket = new WebSocket(url, {
        origin: handle.origin,
        headers: { cookie: auth.cookie },
      });
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolveStatus(response.statusCode ?? 0);
      });
      socket.once("open", () => rejectStatus(new Error("restricted terminal unexpectedly opened")));
      socket.once("error", () => {});
    });
    expect(status).toBe(403);
  });
});
