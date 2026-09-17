import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import type { Duplex } from "node:stream";
import { attachments, readImageSnapshot } from "../attachments/store.js";
import { renderIndexHtml, serveAsset } from "../server/assets.js";
import { type DeviceSession, DeviceSessionStore, WriterLeaseStore } from "./auth.js";
import { invokeWebHost } from "./host.js";
import { OperationJournal } from "./operations.js";
import {
  type WebAccessMode,
  type WebPolicyOptions,
  authorizeDesktopCommand,
  hostCommandAllowed,
  surfaceCapabilities,
} from "./policy.js";
import type { SequencedWebPacket, WebDownlinkPacket, WebSidecar } from "./sidecar.js";
import { WebTerminalManager } from "./terminal.js";
import { UploadStore } from "./uploads.js";
import { WorkspaceRegistry } from "./workspaces.js";

const LOOPBACK_HOST = "127.0.0.1";
const LOCAL_SESSION_COOKIE = "jupiter_web_session";
const PUBLIC_SESSION_COOKIE = "__Host-jupiter_web_session";
const MAX_JSON_BODY_BYTES = 256 * 1024;
const MAX_RPC_COMMANDS_PER_MINUTE = 600;
const MAX_BOOTSTRAP_ATTEMPTS_PER_MINUTE = 10;
const SSE_QUEUE_BYTES = 4 * 1024 * 1024;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export interface StartWebServerOptions {
  sidecar: WebSidecar;
  port?: number;
  bootstrapToken?: string;
  mode?: WebAccessMode;
  host?: string;
  origin?: string;
  proxySecret?: string;
  workspaceRoots?: readonly string[];
  workspaces?: WorkspaceRegistry;
  highRiskEnabled?: boolean;
}

export interface WebServerHandle {
  url: string;
  baseUrl: string;
  origin: string;
  port: number;
  runtimeEpoch: string;
  close(): Promise<void>;
}

interface ObserverConnection {
  connectionId: string;
  deviceId: string;
  client: SseClient;
  unsubscribe: () => void;
}

interface EventCursor {
  runtimeEpoch: string;
  sequence: number;
}

class SlidingWindowLimiter {
  private readonly attempts = new Map<string, number[]>();

  allow(key: string, limit: number, now = Date.now()): boolean {
    const cutoff = now - 60_000;
    const recent = (this.attempts.get(key) ?? []).filter((stamp) => stamp >= cutoff);
    if (recent.length >= limit) {
      this.attempts.set(key, recent);
      return false;
    }
    recent.push(now);
    this.attempts.set(key, recent);
    if (this.attempts.size > 1024) this.prune(cutoff);
    return true;
  }

  private prune(cutoff: number): void {
    for (const [key, entries] of this.attempts) {
      const current = entries.filter((stamp) => stamp >= cutoff);
      if (current.length === 0) this.attempts.delete(key);
      else this.attempts.set(key, current);
    }
  }
}

class SseClient {
  private readonly queue: string[] = [];
  private queuedBytes = 0;
  private waitingForDrain = false;
  private closed = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly response: ServerResponse) {
    this.enqueue("retry: 1000\n\n");
    this.heartbeat = setInterval(() => this.enqueue(": keep-alive\n\n"), 15_000);
    this.heartbeat.unref();
  }

  send(item: SequencedWebPacket, runtimeEpoch: string): void {
    this.enqueue(`id: ${runtimeEpoch}:${item.sequence}\ndata: ${JSON.stringify(item.packet)}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.queue.length = 0;
    this.queuedBytes = 0;
    if (!this.response.writableEnded) this.response.end();
  }

  private enqueue(frame: string): void {
    if (this.closed) return;
    const bytes = Buffer.byteLength(frame, "utf8");
    if (this.queuedBytes + bytes > SSE_QUEUE_BYTES) {
      this.close();
      return;
    }
    this.queue.push(frame);
    this.queuedBytes += bytes;
    this.flush();
  }

  private flush(): void {
    if (this.closed || this.waitingForDrain) return;
    while (this.queue.length > 0) {
      const frame = this.queue.shift();
      if (frame === undefined) return;
      this.queuedBytes -= Buffer.byteLength(frame, "utf8");
      if (!this.response.write(frame)) {
        this.waitingForDrain = true;
        this.response.once("drain", () => {
          this.waitingForDrain = false;
          this.flush();
        });
        return;
      }
    }
  }
}

class WebServerRuntime {
  private readonly bootstrapToken: string;
  private readonly sessionStore: DeviceSessionStore;
  private readonly leaseStore = new WriterLeaseStore();
  private readonly bootstrapLimiter = new SlidingWindowLimiter();
  private readonly rpcLimiter = new SlidingWindowLimiter();
  private readonly operations = new OperationJournal();
  private readonly observers = new Map<string, ObserverConnection>();
  private readonly terminals = new WebTerminalManager();
  private expectedHost = "";
  private expectedOrigin = "";

  constructor(
    private readonly sidecar: WebSidecar,
    private readonly workspaces: WorkspaceRegistry,
    private readonly uploads: UploadStore,
    private readonly mode: WebAccessMode,
    private readonly listenHost: string,
    private readonly configuredOrigin: string | undefined,
    private readonly proxySecret: string | undefined,
    private readonly highRiskEnabled: boolean,
    bootstrapToken?: string,
  ) {
    this.bootstrapToken = bootstrapToken ?? randomBytes(32).toString("hex");
    this.sessionStore = new DeviceSessionStore(this.bootstrapToken);
  }

  setAddress(port: number): void {
    const fallbackHost = isWildcardHost(this.listenHost) ? LOOPBACK_HOST : this.listenHost;
    const origin = this.configuredOrigin ?? `http://${formatHost(fallbackHost)}:${port}`;
    const parsed = new URL(origin);
    this.expectedOrigin = parsed.origin;
    this.expectedHost = parsed.host;
  }

  launchUrl(): string {
    return `${this.expectedOrigin}/#bootstrap=${this.bootstrapToken}`;
  }

  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applySecurityHeaders(res, this.mode);
    if (!this.networkAllowed(req)) {
      respondJson(res, 403, { error: "request is outside the configured Web access boundary" });
      return;
    }
    if (this.expectedHost && req.headers.host !== this.expectedHost) {
      respondJson(res, 421, { error: "invalid Host header" });
      return;
    }

    const url = new URL(req.url ?? "/", this.expectedOrigin || "http://127.0.0.1");
    const method = (req.method ?? "GET").toUpperCase();
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (method !== "GET") return methodNotAllowed(res);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderIndexHtml("", "web"));
      return;
    }
    if (url.pathname.startsWith("/assets/")) {
      if (method !== "GET") return methodNotAllowed(res);
      const name = url.pathname.slice("/assets/".length);
      if (!isSafeAssetName(name)) return notFound(res);
      const asset = serveAsset(name);
      if (!asset) return notFound(res);
      res.writeHead(200, { "cache-control": "no-cache", "content-type": asset.contentType });
      res.end(asset.body);
      return;
    }
    if (url.pathname === "/api/bootstrap") {
      await this.handleBootstrap(req, res, method);
      return;
    }

    if (!this.isExpectedOrigin(req, method !== "GET" && method !== "HEAD")) {
      respondJson(res, 403, { error: "invalid Origin header" });
      return;
    }
    const session = this.authenticate(req);
    if (!session) {
      respondJson(res, 401, { error: "browser session is missing or expired" });
      return;
    }

    if (url.pathname === "/api/session" && method === "GET") {
      respondJson(res, 200, this.sessionPayload(session));
      return;
    }
    if (url.pathname === "/api/events" && method === "GET") {
      this.handleEvents(req, res, url, session);
      return;
    }
    if (url.pathname === "/api/lease/acquire" && method === "POST") {
      await this.handleLeaseAcquire(req, res, session);
      return;
    }
    if (url.pathname === "/api/lease/renew" && method === "POST") {
      this.handleLeaseRenew(req, res, session);
      return;
    }
    if (url.pathname === "/api/pairing" && method === "POST") {
      this.handlePairing(req, res, session);
      return;
    }
    if (url.pathname === "/api/devices" && method === "GET") {
      respondJson(res, 200, {
        devices: this.sessionStore.list(),
        lease: this.leaseStore.current(),
      });
      return;
    }
    if (url.pathname.startsWith("/api/devices/") && method === "DELETE") {
      this.handleDeviceRevoke(req, res, session, decodeURIComponent(url.pathname.slice(13)));
      return;
    }
    if (url.pathname === "/api/rpc" && method === "POST") {
      await this.handleRpc(req, res, session);
      return;
    }
    if (url.pathname === "/api/host-invoke" && method === "POST") {
      await this.handleHostInvoke(req, res, session);
      return;
    }
    if (url.pathname === "/api/files/resolve" && method === "POST") {
      await this.handleFileResolve(req, res, session);
      return;
    }
    if (url.pathname === "/api/files/upload" && method === "POST") {
      await this.handleUpload(req, res, url, session);
      return;
    }
    if (url.pathname.startsWith("/api/images/") && (method === "GET" || method === "HEAD")) {
      try {
        const image = await attachments.read(
          url.pathname.slice(12),
          url.searchParams.get("thumbnail") === "1",
        );
        res.writeHead(200, {
          "content-type": image.mime,
          "content-length": image.bytes.length,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
        });
        res.end(method === "HEAD" ? undefined : image.bytes);
      } catch {
        respondJson(res, 404, { error: "Image is unavailable" });
      }
      return;
    }
    if (url.pathname.startsWith("/api/files/") && (method === "GET" || method === "HEAD")) {
      await this.handleFileDownload(req, res, decodeURIComponent(url.pathname.slice(11)), method);
      return;
    }
    if (url.pathname.startsWith("/api/files/") && method === "DELETE") {
      await this.handleFileDelete(req, res, session, decodeURIComponent(url.pathname.slice(11)));
      return;
    }
    notFound(res);
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", this.expectedOrigin || "http://127.0.0.1");
    if (url.pathname !== "/api/terminal") {
      rejectUpgrade(socket, 404, "not found");
      return;
    }
    if (
      !this.networkAllowed(req) ||
      (this.expectedHost && req.headers.host !== this.expectedHost) ||
      !this.isExpectedOrigin(req, true)
    ) {
      rejectUpgrade(socket, 403, "terminal connection rejected");
      return;
    }
    if (!surfaceCapabilities(this.policy()).terminal) {
      rejectUpgrade(socket, 403, "terminal is disabled for this Web access mode");
      return;
    }
    const session = this.authenticate(req);
    if (!session) {
      rejectUpgrade(socket, 401, "browser session is missing or expired");
      return;
    }
    this.terminals.accept(req, socket, head, {
      deviceId: session.id,
      validateLease: (leaseId, fence) =>
        Boolean(this.leaseStore.validate(leaseId, session.id, fence)),
      resolveWorkspace: (workspaceId) => this.workspaces.resolveDirectory(workspaceId),
    });
  }

  closeConnections(): void {
    for (const observer of this.observers.values()) {
      observer.unsubscribe();
      observer.client.close();
    }
    this.observers.clear();
    this.terminals.close();
  }

  private async handleBootstrap(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
  ): Promise<void> {
    if (method !== "POST") return methodNotAllowed(res);
    if (!this.isExpectedOrigin(req, true)) {
      respondJson(res, 403, { error: "invalid Origin header" });
      return;
    }
    const remote = req.socket.remoteAddress ?? "unknown";
    if (!this.bootstrapLimiter.allow(remote, MAX_BOOTSTRAP_ATTEMPTS_PER_MINUTE)) {
      res.setHeader("retry-after", "60");
      respondJson(res, 429, { error: "too many bootstrap attempts" });
      return;
    }
    const body = await readJsonBody(req, res);
    if (!body) return;
    const token = typeof body.token === "string" ? body.token : "";
    const consumed = this.sessionStore.consumePairingToken(
      token,
      typeof body.deviceName === "string" ? body.deviceName : undefined,
    );
    if (!consumed) {
      respondJson(res, 401, { error: "pairing token is invalid, expired, or already used" });
      return;
    }
    res.setHeader(
      "set-cookie",
      this.sessionCookie(consumed.cookieToken, consumed.session.expiresAt),
    );
    respondJson(res, 200, this.sessionPayload(consumed.session));
  }

  private handleEvents(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    session: DeviceSession,
  ): void {
    const connectionId = url.searchParams.get("connectionId") ?? "";
    if (!validId(connectionId)) {
      respondJson(res, 400, { error: "invalid connectionId" });
      return;
    }
    const previous = this.observers.get(connectionId);
    if (previous) {
      previous.unsubscribe();
      previous.client.close();
      this.observers.delete(connectionId);
    }

    res.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    res.flushHeaders?.();
    const client = new SseClient(res);
    const runtimeEpoch = this.sidecar.runtimeEpoch;
    const barrier = this.sidecar.latestSequence;
    const pendingLive: SequencedWebPacket[] = [];
    let replaying = true;
    const unsubscribe = this.sidecar.subscribe((packet) => {
      if (packet.sequence <= barrier) return;
      if (replaying) pendingLive.push(packet);
      else client.send(this.outboundPacket(packet), this.sidecar.runtimeEpoch);
    });
    const observer = { connectionId, deviceId: session.id, client, unsubscribe };
    this.observers.set(connectionId, observer);

    const cursor = parseEventCursor(req.headers["last-event-id"], runtimeEpoch);
    let needsResync = cursor === null || cursor.runtimeEpoch !== runtimeEpoch;
    if (!needsResync && cursor) {
      const replay = this.sidecar.replayAfter(cursor.sequence, barrier);
      if (replay.status === "gap") needsResync = true;
      else {
        for (const packet of replay.packets) client.send(this.outboundPacket(packet), runtimeEpoch);
      }
    }
    replaying = false;
    pendingLive.sort((a, b) => a.sequence - b.sequence);
    for (const packet of pendingLive) client.send(this.outboundPacket(packet), runtimeEpoch);
    if (needsResync) {
      void this.sidecar
        .send({ cmd: "desktop_resync", requestId: randomUUID() })
        .catch(() => client.close());
    }

    res.once("close", () => {
      if (this.observers.get(connectionId)?.client !== client) return;
      this.observers.delete(connectionId);
      unsubscribe();
      client.close();
    });
  }

  private async handleLeaseAcquire(
    req: IncomingMessage,
    res: ServerResponse,
    session: DeviceSession,
  ): Promise<void> {
    if (!this.authorizeConnectionMutation(req, res, session)) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const force = body.force === true;
    if (force && body.confirm !== "take-control") {
      respondJson(res, 400, { error: "forced takeover requires explicit confirmation" });
      return;
    }
    const previous = this.leaseStore.current();
    const lease = this.leaseStore.acquire(session.id, force);
    if (!lease) {
      respondJson(res, 409, { error: "another paired device currently controls Jupiter" });
      return;
    }
    if (previous && previous.deviceId !== session.id) this.terminals.closeDevice(previous.deviceId);
    respondJson(res, 200, { lease });
  }

  private handleLeaseRenew(
    req: IncomingMessage,
    res: ServerResponse,
    session: DeviceSession,
  ): void {
    if (!this.authorizeConnectionMutation(req, res, session)) return;
    const lease = this.leaseFromHeaders(req, session);
    if (!lease) {
      respondJson(res, 409, { error: "writer lease is missing, expired, or superseded" });
      return;
    }
    const renewed = this.leaseStore.renew(lease.id, session.id, lease.fence);
    if (!renewed) {
      respondJson(res, 409, { error: "writer lease could not be renewed" });
      return;
    }
    respondJson(res, 200, { lease: renewed });
  }

  private handlePairing(req: IncomingMessage, res: ServerResponse, session: DeviceSession): void {
    if (!this.authorizeWriterMutation(req, res, session)) return;
    const pairing = this.sessionStore.issuePairingToken();
    respondJson(res, 201, {
      expiresAt: pairing.expiresAt,
      url: `${this.expectedOrigin}/#bootstrap=${pairing.token}`,
    });
  }

  private handleDeviceRevoke(
    req: IncomingMessage,
    res: ServerResponse,
    session: DeviceSession,
    deviceId: string,
  ): void {
    if (!this.authorizeWriterMutation(req, res, session)) return;
    if (!deviceId) {
      respondJson(res, 400, { error: "device id is required" });
      return;
    }
    if (this.sessionStore.revoke(deviceId)) {
      this.leaseStore.releaseForDevice(deviceId);
      this.terminals.closeDevice(deviceId);
      for (const [connectionId, observer] of this.observers) {
        if (observer.deviceId !== deviceId) continue;
        observer.unsubscribe();
        observer.client.close();
        this.observers.delete(connectionId);
      }
    }
    respondJson(res, 200, { revoked: true });
  }

  private async handleRpc(
    req: IncomingMessage,
    res: ServerResponse,
    session: DeviceSession,
  ): Promise<void> {
    if (!this.authorizeWriterMutation(req, res, session)) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const lease = this.leaseFromHeaders(req, session);
    if (!lease) {
      respondJson(res, 409, { error: "writer lease changed while the command was in flight" });
      return;
    }
    const commandId = typeof body.commandId === "string" ? body.commandId : "";
    if (!validId(commandId)) {
      respondJson(res, 400, { error: "invalid commandId" });
      return;
    }
    const payload = body.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      respondJson(res, 400, { error: "payload must be a command object" });
      return;
    }

    try {
      const authorized = await authorizeDesktopCommand(
        payload as Record<string, unknown>,
        this.policy(),
      );
      if (!this.leaseStore.validate(lease.id, session.id, lease.fence)) {
        respondJson(res, 409, { error: "writer lease was superseded before command dispatch" });
        return;
      }
      const outcome = await this.operations.run(commandId, async () => {
        await this.sidecar.send({
          ...authorized.command,
          __web: {
            commandId,
            deviceId: session.id,
            leaseId: lease.id,
            fence: lease.fence,
            runtimeEpoch: this.sidecar.runtimeEpoch,
          },
        });
        return { accepted: true, risk: authorized.risk };
      });
      respondJson(res, 202, {
        ...outcome.value,
        duplicate: outcome.duplicate,
        commandId,
        runtimeEpoch: this.sidecar.runtimeEpoch,
      });
    } catch (error) {
      respondJson(res, 400, { error: this.errorForClient(error) });
    }
  }

  private async handleHostInvoke(
    req: IncomingMessage,
    res: ServerResponse,
    session: DeviceSession,
  ): Promise<void> {
    if (!this.authorizeWriterMutation(req, res, session)) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const lease = this.leaseFromHeaders(req, session);
    if (!lease) {
      respondJson(res, 409, { error: "writer lease changed while the operation was in flight" });
      return;
    }
    const command = typeof body.command === "string" ? body.command : "";
    const args = body.args;
    const operationId = typeof body.operationId === "string" ? body.operationId : "";
    if (!validId(operationId) || !args || typeof args !== "object" || Array.isArray(args)) {
      respondJson(res, 400, { error: "operationId, command and args are required" });
      return;
    }
    if (!hostCommandAllowed(command, this.policy())) {
      respondJson(res, 403, { error: `${command || "host command"} is not permitted` });
      return;
    }
    try {
      const operation = () =>
        invokeWebHost(command, args as Record<string, unknown>, { workspaces: this.workspaces });
      // Binary previews are reads, not replayable mutations. Do not retain their byte arrays.
      const outcome =
        command === "read_file_bytes"
          ? { duplicate: false, value: await operation() }
          : await this.operations.run(operationId, operation);
      const result =
        this.mode === "local"
          ? outcome.value
          : sanitizeRemoteValue(outcome.value, "", this.workspaces);
      respondJson(res, 200, { result, duplicate: outcome.duplicate, operationId });
    } catch (error) {
      respondJson(res, 400, { error: this.errorForClient(error) });
    }
  }

  private async handleFileResolve(
    req: IncomingMessage,
    res: ServerResponse,
    session: DeviceSession,
  ): Promise<void> {
    if (!this.authorizeConnectionMutation(req, res, session)) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const file = await this.workspaces.issueWorkspaceFile(
        typeof body.workspaceId === "string" ? body.workspaceId : "",
        typeof body.path === "string" ? body.path : "",
        typeof body.mime === "string" ? body.mime : undefined,
      );
      respondJson(res, 200, { file });
    } catch (error) {
      respondJson(res, 400, { error: this.errorForClient(error) });
    }
  }

  private async handleUpload(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    session: DeviceSession,
  ): Promise<void> {
    if (!this.authorizeWriterMutation(req, res, session)) return;
    const lease = this.leaseFromHeaders(req, session);
    if (!lease) return;
    const name = url.searchParams.get("name") ?? headerValue(req.headers["x-jupiter-file-name"]);
    try {
      const contentLength = parseContentLength(req.headers["content-length"]);
      const upload = await this.uploads.receive(
        name,
        headerValue(req.headers["content-type"]),
        req,
        contentLength,
      );
      if (!this.leaseStore.validate(lease.id, session.id, lease.fence)) {
        await this.uploads.remove(upload.file.id);
        respondJson(res, 409, { error: "writer lease changed during upload" });
        return;
      }
      if (
        /^image\//i.test(headerValue(req.headers["content-type"])) ||
        /\.(png|jpe?g|webp|gif)$/i.test(name)
      ) {
        try {
          const image = await attachments.importBytes(
            await readImageSnapshot(this.workspaces.resolveFile(upload.file.id).absolutePath),
            upload.file.name,
          );
          if (!this.leaseStore.validate(lease.id, session.id, lease.fence))
            throw new Error("writer lease changed during image processing");
          respondJson(res, 201, { ...upload, image });
        } finally {
          await this.uploads.remove(upload.file.id);
        }
      } else respondJson(res, 201, upload);
    } catch (error) {
      respondJson(res, 400, { error: this.errorForClient(error) });
    }
  }

  private async handleFileDownload(
    req: IncomingMessage,
    res: ServerResponse,
    fileId: string,
    method: string,
  ): Promise<void> {
    try {
      const record = this.workspaces.resolveFile(fileId);
      const metadata = await stat(record.absolutePath);
      if (!metadata.isFile()) throw new Error("not a file");
      const range = parseRange(headerValue(req.headers.range), metadata.size);
      const disposition = safeInlineMime(record.ref.mime) ? "inline" : "attachment";
      const headers: Record<string, string | number> = {
        "accept-ranges": "bytes",
        "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(record.ref.name)}`,
        "content-type": record.ref.mime ?? "application/octet-stream",
        "content-length": range ? range.end - range.start + 1 : metadata.size,
        "content-security-policy": "sandbox",
      };
      if (range) headers["content-range"] = `bytes ${range.start}-${range.end}/${metadata.size}`;
      res.writeHead(range ? 206 : 200, headers);
      if (method === "HEAD") {
        res.end();
        return;
      }
      const stream = createReadStream(record.absolutePath, range ?? undefined);
      stream.once("error", () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      respondJson(res, 404, { error: this.errorForClient(error) });
    }
  }

  private async handleFileDelete(
    req: IncomingMessage,
    res: ServerResponse,
    session: DeviceSession,
    fileId: string,
  ): Promise<void> {
    if (!this.authorizeWriterMutation(req, res, session)) return;
    respondJson(res, 200, { removed: await this.uploads.remove(fileId) });
  }

  private authorizeConnectionMutation(
    req: IncomingMessage,
    res: ServerResponse,
    session: DeviceSession,
  ): boolean {
    const csrf = headerValue(req.headers["x-jupiter-csrf"]);
    if (!safeEqual(csrf, session.csrfToken)) {
      respondJson(res, 403, { error: "invalid CSRF token" });
      return false;
    }
    const connectionId = headerValue(req.headers["x-jupiter-connection"]);
    const observer = this.observers.get(connectionId);
    if (!observer || observer.deviceId !== session.id) {
      respondJson(res, 409, { error: "this browser connection is not registered" });
      return false;
    }
    if (!this.rpcLimiter.allow(session.id, MAX_RPC_COMMANDS_PER_MINUTE)) {
      res.setHeader("retry-after", "60");
      respondJson(res, 429, { error: "too many Web commands" });
      return false;
    }
    return true;
  }

  private authorizeWriterMutation(
    req: IncomingMessage,
    res: ServerResponse,
    session: DeviceSession,
  ): boolean {
    if (!this.authorizeConnectionMutation(req, res, session)) return false;
    if (!this.leaseFromHeaders(req, session)) {
      respondJson(res, 409, { error: "this device does not hold the current writer lease" });
      return false;
    }
    return true;
  }

  private leaseFromHeaders(req: IncomingMessage, session: DeviceSession) {
    const leaseId = headerValue(req.headers["x-jupiter-lease"]);
    const fence = Number(headerValue(req.headers["x-jupiter-fence"]));
    if (!leaseId || !Number.isSafeInteger(fence) || fence < 1) return null;
    return this.leaseStore.validate(leaseId, session.id, fence);
  }

  private authenticate(req: IncomingMessage): DeviceSession | null {
    const cookie = parseCookies(headerValue(req.headers.cookie))[this.cookieName()] ?? "";
    return this.sessionStore.authenticate(cookie);
  }

  private sessionPayload(session: DeviceSession): Record<string, unknown> {
    const lease = this.leaseStore.current();
    const workspaces = this.workspaces
      .list()
      .map((workspace) =>
        this.mode === "local"
          ? { ...workspace, root: this.workspaces.rootFor(workspace.id) }
          : workspace,
      );
    return {
      csrfToken: session.csrfToken,
      device: session,
      lease: lease && lease.deviceId === session.id ? lease : null,
      writerAvailable: lease === null || lease.deviceId === session.id,
      runtimeEpoch: this.sidecar.runtimeEpoch,
      capabilities: surfaceCapabilities(this.policy()),
      workspaces,
    };
  }

  private policy(): WebPolicyOptions {
    return {
      mode: this.mode,
      highRiskEnabled: this.highRiskEnabled,
      workspaces: this.workspaces,
    };
  }

  errorForClient(error: unknown): string {
    const message = errorMessage(error);
    return this.mode === "local" ? message : redactHostText(message, this.workspaces);
  }

  private outboundPacket(item: SequencedWebPacket): SequencedWebPacket {
    if (this.mode === "local") return item;
    return {
      sequence: item.sequence,
      packet: sanitizeRemotePacket(item.packet, this.workspaces),
    };
  }

  private isExpectedOrigin(req: IncomingMessage, required: boolean): boolean {
    const origin = headerValue(req.headers.origin);
    if (!origin) return !required;
    return origin === this.expectedOrigin;
  }

  private networkAllowed(req: IncomingMessage): boolean {
    const address = req.socket.remoteAddress;
    if (this.mode === "local") return isLoopbackAddress(address);
    if (this.mode === "public") {
      return (
        isLoopbackAddress(address) &&
        Boolean(this.proxySecret) &&
        safeEqual(headerValue(req.headers["x-jupiter-proxy-secret"]), this.proxySecret ?? "")
      );
    }
    return isPrivateAddress(address);
  }

  private sessionCookie(token: string, expiresAt: number): string {
    const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    return [
      `${this.cookieName()}=${token}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${maxAge}`,
      ...(this.mode === "public" ? ["Secure"] : []),
    ].join("; ");
  }

  private cookieName(): string {
    return this.mode === "public" ? PUBLIC_SESSION_COOKIE : LOCAL_SESSION_COOKIE;
  }
}

export async function startWebServer(opts: StartWebServerOptions): Promise<WebServerHandle> {
  const mode = opts.mode ?? "local";
  const listenHost = opts.host ?? (mode === "lan" ? "0.0.0.0" : LOOPBACK_HOST);
  validateStartOptions(mode, listenHost, opts.origin, opts.proxySecret);
  const workspaces =
    opts.workspaces ?? (await WorkspaceRegistry.create(opts.workspaceRoots ?? [process.cwd()]));
  const uploads = await UploadStore.create(workspaces);
  const runtime = new WebServerRuntime(
    opts.sidecar,
    workspaces,
    uploads,
    mode,
    listenHost,
    opts.origin,
    opts.proxySecret,
    opts.highRiskEnabled === true,
    opts.bootstrapToken,
  );
  const server = createServer((req, res) => {
    runtime.dispatch(req, res).catch((error) => {
      if (!res.headersSent) applySecurityHeaders(res, mode);
      if (!res.writableEnded) respondJson(res, 500, { error: runtime.errorForClient(error) });
    });
  });
  server.on("upgrade", (req, socket, head) => runtime.handleUpgrade(req, socket, head));

  return new Promise((resolveStart, rejectStart) => {
    const onStartupError = (error: Error) => {
      void uploads.close();
      rejectStart(error);
    };
    server.once("error", onStartupError);
    server.listen(opts.port ?? 0, listenHost, () => {
      server.off("error", onStartupError);
      const port = (server.address() as AddressInfo).port;
      runtime.setAddress(port);
      const directHost = isWildcardHost(listenHost) ? LOOPBACK_HOST : listenHost;
      const baseUrl = `http://${formatHost(directHost)}:${port}`;
      let closePromise: Promise<void> | null = null;
      const close = (): Promise<void> => {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          runtime.closeConnections();
          await new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
            setTimeout(() => server.closeAllConnections?.(), 1000).unref();
          });
          await Promise.allSettled([opts.sidecar.close(), uploads.close()]);
        })();
        return closePromise;
      };
      resolveStart({
        url: runtime.launchUrl(),
        baseUrl,
        origin: opts.origin ?? baseUrl,
        port,
        runtimeEpoch: opts.sidecar.runtimeEpoch,
        close,
      });
    });
  });
}

function validateStartOptions(
  mode: WebAccessMode,
  host: string,
  origin: string | undefined,
  proxySecret: string | undefined,
): void {
  if (mode === "local" && !isLoopbackHost(host)) {
    throw new Error("local Web mode must bind to a loopback host");
  }
  if (mode === "lan" && !origin) {
    throw new Error("LAN Web mode requires an explicit --origin URL");
  }
  if (mode === "public") {
    if (!isLoopbackHost(host)) throw new Error("public Web mode must remain bound to loopback");
    if (!origin || new URL(origin).protocol !== "https:") {
      throw new Error("public Web mode requires an explicit HTTPS origin");
    }
    if (!proxySecret || proxySecret.length < 32) {
      throw new Error("public Web mode requires a 32+ character trusted proxy secret");
    }
  }
}

function applySecurityHeaders(res: ServerResponse, mode: WebAccessMode): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (mode === "public") res.setHeader("strict-transport-security", "max-age=31536000");
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  const reason =
    status === 401
      ? "Unauthorized"
      : status === 403
        ? "Forbidden"
        : status === 404
          ? "Not Found"
          : "Error";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function methodNotAllowed(res: ServerResponse): void {
  respondJson(res, 405, { error: "method not allowed" });
}

const HOST_PATH_KEYS = new Set([
  "allowPrefix",
  "absPath",
  "cwd",
  "executablePath",
  "importedPath",
  "path",
  "recentWorkspaces",
  "root",
  "rootDir",
  "sandboxRoot",
  "workspace",
  "workspaceDir",
]);

function sanitizeRemotePacket(
  packet: WebDownlinkPacket,
  workspaces: WorkspaceRegistry,
): WebDownlinkPacket {
  if (packet.channel === "rpc:exit") return packet;
  if (packet.channel === "rpc:stderr") {
    return {
      channel: "rpc:stderr",
      payload: { data: redactHostText(packet.payload.data, workspaces) },
    };
  }
  try {
    const event = JSON.parse(packet.payload.data) as unknown;
    return {
      channel: "rpc:event",
      payload: { data: JSON.stringify(sanitizeRemoteValue(event, "", workspaces)) },
    };
  } catch {
    return {
      channel: "rpc:stderr",
      payload: { data: "[web] invalid runtime event was suppressed" },
    };
  }
}

function sanitizeRemoteValue(value: unknown, key: string, workspaces: WorkspaceRegistry): unknown {
  if (typeof value === "string") {
    if (HOST_PATH_KEYS.has(key) && isAbsolute(value)) {
      const described = workspaces.describeHostPath(value);
      if (!described) return "[host path hidden]";
      return described.relativePath
        ? `${described.workspaceName}/${described.relativePath}`
        : described.workspaceName;
    }
    return redactHostText(value, workspaces);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRemoteValue(item, key, workspaces));
  }
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(source)) {
    if (
      source.type === "$settings" &&
      [
        "baseUrl",
        "apiKeyPrefix",
        "providerDialect",
        "providerLabel",
        "providerId",
        "officialDeepSeek",
      ].includes(childKey)
    ) {
      continue;
    }
    if (
      (childKey === "workspaceDir" || childKey === "workspace") &&
      typeof childValue === "string"
    ) {
      const described = workspaces.describeHostPath(childValue);
      if (described) output.workspaceId = described.workspaceId;
    }
    output[childKey] = sanitizeRemoteValue(childValue, childKey, workspaces);
  }
  return output;
}

function redactHostText(text: string, workspaces: WorkspaceRegistry): string {
  let output = workspaces.redactKnownRoots(text);
  output = replacePathForms(output, homedir(), "~");
  output = replacePathForms(output, tmpdir(), "[runtime-temp]");
  return output;
}

function replacePathForms(text: string, path: string, replacement: string): string {
  const forms = new Set([path, path.split("\\").join("/"), path.split("/").join("\\")]);
  let output = text;
  for (const form of forms) {
    if (form) output = output.split(form).join(replacement);
  }
  return output;
}

function notFound(res: ServerResponse): void {
  respondJson(res, 404, { error: "not found" });
}

async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  let total = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        respondJson(res, 413, { error: `body exceeds ${MAX_JSON_BODY_BYTES} bytes` });
        return null;
      }
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      respondJson(res, 400, { error: "expected a JSON object" });
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    respondJson(res, 400, { error: "invalid JSON body" });
    return null;
  }
}

function parseEventCursor(
  value: string | string[] | undefined,
  currentEpoch: string,
): EventCursor | null {
  const raw = headerValue(value).trim();
  if (!raw) return null;
  const separator = raw.lastIndexOf(":");
  if (separator > 0) {
    const runtimeEpoch = raw.slice(0, separator);
    const sequence = Number(raw.slice(separator + 1));
    return Number.isSafeInteger(sequence) && sequence >= 0 ? { runtimeEpoch, sequence } : null;
  }
  const sequence = Number(raw);
  return Number.isSafeInteger(sequence) && sequence >= 0
    ? { runtimeEpoch: currentEpoch, sequence }
    : null;
}

function parseRange(value: string, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim());
  if (!match) throw new Error("invalid Range header");
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= size
  ) {
    throw new Error("range is outside the file");
  }
  return { start, end };
}

function parseContentLength(value: string | string[] | undefined): number | undefined {
  const raw = headerValue(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid Content-Length");
  return parsed;
}

function safeInlineMime(mime: string | undefined): boolean {
  return Boolean(
    mime &&
      (/^image\/(png|jpeg|gif|webp)$/.test(mime) ||
        mime === "application/pdf" ||
        mime === "text/plain"),
  );
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isPrivateAddress(address: string | undefined): boolean {
  if (!address || isLoopbackAddress(address)) return Boolean(address);
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (/^10\./.test(normalized) || /^192\.168\./.test(normalized)) return true;
  const match = /^172\.(\d+)\./.exec(normalized);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return (
    /^169\.254\./.test(normalized) ||
    /^f[cd][0-9a-f]{2}:/i.test(normalized) ||
    /^fe80:/i.test(normalized)
  );
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isSafeAssetName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 240 &&
    !name.startsWith("/") &&
    !name.split("/").includes("..") &&
    /^[a-zA-Z0-9._/-]+$/.test(name)
  );
}

function parseCookies(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function validId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
