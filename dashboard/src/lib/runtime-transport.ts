// Runtime transport for Web, legacy Dashboard server, and Vite mock modes.

import { createWebHostServices } from "./host-services";
import { runtimeMode } from "./surface-capabilities";

type UnlistenFn = () => void;
type EventCallback<T = any> = (event: { payload: T; event: string }) => void;

// 事件监听中心
const listeners = new Map<string, Set<EventCallback>>();
let eventIdCounter = 0;
let currentTurn = 1;

const MODE = runtimeMode.mode;
const rawMode = runtimeMode.rawMode;
const isServerMode = runtimeMode.isServerMode;

console.log(`[tauri-bridge] mode=${MODE}${isServerMode ? ` mode="${rawMode}"` : ""}`);

// 事件广播
function broadcast(eventName: string, payload: any) {
  const callbacks = listeners.get(eventName);
  if (callbacks) {
    for (const cb of callbacks) {
      cb({ payload, event: eventName });
    }
  }
}

export function emitRuntimeEvent(eventName: string, payload: unknown): void {
  broadcast(eventName, payload);
}

function emitEvent(event: Record<string, any>) {
  broadcast("rpc:event", { data: JSON.stringify(event) });
}

// SSE 连接（Server 模式）
let sse: EventSource | null = null;
let sseTurnStarted = false;
let sseReconnectAttempts = 0;
const SSE_MAX_RECONNECT_ATTEMPTS = 10;
const SSE_RECONNECT_BASE_DELAY = 1000;

let cliDisconnected = false;

type WebPacket = {
  channel: "rpc:event" | "rpc:stderr" | "rpc:exit";
  payload: Record<string, any>;
};

let webCsrfToken = "";
let webDeviceId = "";
type WebLease = { id: string; fence: number; expiresAt: number };
type WebWorkspace = { id: string; name: string; writable: boolean; root?: string };
export type WebUploadedFile = {
  token: string;
  id: string;
  name: string;
  mime?: string;
  size: number;
  previewUrl: string;
};
let webLease: WebLease | null = null;
let webWorkspaces: WebWorkspace[] = [];
let webLeaseRenewTimer: ReturnType<typeof setInterval> | null = null;
let webInitPromise: Promise<void> | null = null;
let webEvents: EventSource | null = null;
const webConnectionId = makeBrowserId();
const webTabIds = new Set<string>();
const pendingWebDownloads = new Map<string, string>();
const pendingWebCopies = new Set<string>();
type WebTerminalConnection = { socket: WebSocket; closing: boolean };
const webTerminalConnections = new Map<string, WebTerminalConnection>();

function makeBrowserId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.replace(/-/g, "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function trackWebTab(packet: WebPacket): void {
  if (packet.channel !== "rpc:event" || typeof packet.payload.data !== "string") return;
  try {
    const event = JSON.parse(packet.payload.data) as Record<string, unknown>;
    const tabId = typeof event.tabId === "string" ? event.tabId : "";
    if (!tabId) return;
    if (event.type === "$tab_opened") webTabIds.add(tabId);
    else if (event.type === "$tab_closed") webTabIds.delete(tabId);
  } catch {
    // The regular packet parser below reports malformed events.
  }
}

function reportInactiveWebController(): void {
  webLease = null;
  const message =
    "This page is read-only because another paired device controls Jupiter. Take control before making changes.";
  if (webTabIds.size === 0) {
    broadcast("rpc:stderr", { data: message });
    return;
  }
  for (const tabId of webTabIds) {
    broadcast("rpc:event", {
      data: JSON.stringify({ type: "$error", tabId, message }),
    });
  }
}

async function readJsonResponse(res: Response): Promise<any> {
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message = body && typeof body === "object" ? body.error : body;
    throw new Error(typeof message === "string" ? message : `HTTP ${res.status}`);
  }
  return body;
}

export class WebSessionError extends Error {
  constructor(public readonly code: "required" | "expired" | "invalidLink" | "wrongServer") {
    super(`Web session: ${code}`);
    this.name = "WebSessionError";
  }
}

export function parseWebPairingLink(link: string, origin: string): string {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new WebSessionError("invalidLink");
  }
  if (url.origin !== origin) throw new WebSessionError("wrongServer");
  const token = new URLSearchParams(url.hash.slice(1)).get("bootstrap");
  if (url.username || url.password || !token || !/^[a-zA-Z0-9_-]{16,256}$/.test(token)) {
    throw new WebSessionError("invalidLink");
  }
  return token;
}

let webAuthenticationPromise: Promise<void> | null = null;

export function authenticateWebSession(pairingLink?: string): Promise<void> {
  // StrictMode and startup retries must not consume a single-use token twice.
  if (webAuthenticationPromise) return webAuthenticationPromise;
  webAuthenticationPromise = authenticateWebSessionOnce(pairingLink).finally(() => {
    webAuthenticationPromise = null;
  });
  return webAuthenticationPromise;
}

async function authenticateWebSessionOnce(pairingLink?: string): Promise<void> {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const bootstrapToken = pairingLink
    ? parseWebPairingLink(pairingLink, window.location.origin)
    : params.get("bootstrap");
  let expiredLink = false;
  if (bootstrapToken) {
    const response = await fetch("/api/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: bootstrapToken }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok || response.status === 401) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    if (response.status !== 401) {
      const body = await readJsonResponse(response);
      applyWebSession(body);
      return;
    }
    // Reopening a consumed link should still work in an already paired browser.
    expiredLink = true;
  }

  const response = await fetch("/api/session", {
    credentials: "same-origin",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401) throw new WebSessionError(expiredLink ? "expired" : "required");
  const body = await readJsonResponse(response);
  applyWebSession(body);
}

function applyWebSession(body: any): void {
  if (typeof body?.csrfToken !== "string" || !body.csrfToken) {
    throw new Error("Web session did not return a CSRF token");
  }
  webCsrfToken = typeof body?.csrfToken === "string" ? body.csrfToken : "";
  webDeviceId = typeof body?.device?.id === "string" ? body.device.id : "";
  webLease =
    body?.lease && typeof body.lease.id === "string" && Number.isSafeInteger(body.lease.fence)
      ? body.lease
      : null;
  webWorkspaces = Array.isArray(body?.workspaces)
    ? body.workspaces.filter(
        (item: unknown): item is WebWorkspace =>
          Boolean(item) && typeof item === "object" && typeof (item as WebWorkspace).id === "string",
      )
    : [];
  if (body?.capabilities && typeof body.capabilities === "object") {
    document.documentElement.dataset.webMode = String(body.capabilities.mode ?? "local");
    document.documentElement.dataset.webTerminal = String(body.capabilities.terminal === true);
    document.documentElement.dataset.webGitWrite = String(body.capabilities.gitWrite === true);
    document.documentElement.dataset.webMcpWrite = String(body.capabilities.mcpWrite === true);
    document.documentElement.dataset.webSecretWrite = String(body.capabilities.secretWrite === true);
    window.dispatchEvent(new CustomEvent("jupiter:web-capabilities", { detail: body.capabilities }));
  }
}

function connectWebEvents(): Promise<void> {
  webEvents?.close();
  const source = new EventSource(`/api/events?connectionId=${encodeURIComponent(webConnectionId)}`);
  webEvents = source;
  return new Promise<void>((resolveOpen, rejectOpen) => {
    let opened = false;
    const timeout = setTimeout(() => {
      if (opened) return;
      source.close();
      if (webEvents === source) webEvents = null;
      rejectOpen(new Error("Web event connection timed out"));
    }, 10_000);

    source.onopen = () => {
      opened = true;
      clearTimeout(timeout);
      cliDisconnected = false;
      resolveOpen();
    };
    source.onmessage = (message) => {
      try {
        const packet = JSON.parse(message.data) as WebPacket;
        if (
          packet.channel !== "rpc:event" &&
          packet.channel !== "rpc:stderr" &&
          packet.channel !== "rpc:exit"
        ) {
          throw new Error("unknown Web packet channel");
        }
        void deliverWebPacket(packet);
      } catch (err) {
        console.warn("[tauri-bridge] bad Web event:", err);
      }
    };
    source.onerror = () => {
      if (!opened) {
        clearTimeout(timeout);
        source.close();
        if (webEvents === source) webEvents = null;
        rejectOpen(new Error("Web event connection failed"));
        return;
      }
      if (cliDisconnected) return;
      cliDisconnected = true;
      broadcast("rpc:stderr", { data: "Web connection lost; reconnecting..." });
    };
  });
}

async function deliverWebPacket(packet: WebPacket): Promise<void> {
  trackWebTab(packet);
  if (packet.channel === "rpc:event" && typeof packet.payload.data === "string") {
    try {
      const event = JSON.parse(packet.payload.data) as Record<string, any>;
      if (event.type === "$session_action_result" && typeof event.requestId === "string") {
        const filename = pendingWebDownloads.get(event.requestId);
        const shouldCopy = pendingWebCopies.has(event.requestId);
        if (filename) {
          pendingWebDownloads.delete(event.requestId);
          pendingWebCopies.delete(event.requestId);
          event.action = "export";
          if (event.ok && typeof event.content === "string") {
            downloadBrowserText(filename, event.content);
          } else if (event.ok) {
            event.ok = false;
            event.error = "Web export returned no content";
          }
        } else if (shouldCopy) {
          pendingWebCopies.delete(event.requestId);
          if (event.ok && typeof event.content === "string") {
            try {
              await writeBrowserClipboard(event.content);
            } catch (error) {
              event.ok = false;
              event.error = (error as Error).message;
            }
          }
        }
        delete event.content;
        packet = { ...packet, payload: { ...packet.payload, data: JSON.stringify(event) } };
      }
    } catch {
      // The normal RPC event parser below reports malformed events.
    }
  }
  broadcast(packet.channel, packet.payload);
  cliDisconnected = false;
}

async function webInit(): Promise<void> {
  if (webInitPromise) return webInitPromise;
  webInitPromise = (async () => {
    document.documentElement.dataset.web = "true";
    await authenticateWebSession();
    if (!webCsrfToken) throw new Error("Web session did not return a CSRF token");
    await connectWebEvents();
    await acquireWebLease(false);
  })();
  try {
    await webInitPromise;
  } catch (err) {
    webInitPromise = null;
    throw err;
  }
}

async function acquireWebLease(force: boolean): Promise<void> {
  const response = await fetch("/api/lease/acquire", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-jupiter-connection": webConnectionId,
      "x-jupiter-csrf": webCsrfToken,
    },
    body: JSON.stringify(force ? { force: true, confirm: "take-control" } : { force: false }),
  });
  if (response.status === 409) {
    webLease = null;
    reportInactiveWebController();
    return;
  }
  const body = await readJsonResponse(response);
  webLease = body?.lease ?? null;
  scheduleLeaseRenewal();
}

function scheduleLeaseRenewal(): void {
  if (webLeaseRenewTimer) clearInterval(webLeaseRenewTimer);
  webLeaseRenewTimer = setInterval(() => {
    void renewWebLease();
  }, 10_000);
}

async function renewWebLease(): Promise<void> {
  if (!webLease) return;
  const response = await fetch("/api/lease/renew", {
    method: "POST",
    credentials: "same-origin",
    headers: webMutationHeaders(),
  });
  if (response.status === 409) {
    reportInactiveWebController();
    return;
  }
  const body = await readJsonResponse(response);
  webLease = body?.lease ?? null;
}

function webMutationHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "x-jupiter-connection": webConnectionId,
    "x-jupiter-csrf": webCsrfToken,
  };
  if (webLease) {
    headers["x-jupiter-lease"] = webLease.id;
    headers["x-jupiter-fence"] = String(webLease.fence);
  }
  return headers;
}

function workspaceForLegacyPath(value: unknown): WebWorkspace | null {
  if (typeof value !== "string" || !value) return null;
  return (
    webWorkspaces.find((workspace) => workspace.root === value) ??
    webWorkspaces.find((workspace) => workspace.name === value) ??
    webWorkspaces.find((workspace) => workspace.id === value) ??
    webWorkspaces.find((workspace) => `workspace://${workspace.id}` === value) ??
    null
  );
}

export async function uploadWebFile(file: Blob, name: string): Promise<WebUploadedFile> {
  await webInit();
  if (!webLease) throw new Error("This browser is connected in read-only mode");
  const response = await fetch(`/api/files/upload?name=${encodeURIComponent(name)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      ...webMutationHeaders(),
      ...(file.type ? { "content-type": file.type } : {}),
    },
    body: file,
  });
  if (response.status === 409) reportInactiveWebController();
  const body = await readJsonResponse(response);
  const uploaded = body?.file;
  if (!uploaded || typeof uploaded.id !== "string") throw new Error("Upload returned no file id");
  if (body.image?.kind === "image" && /^[a-f0-9]{64}$/.test(body.image.id)) return {
    token: `jupiter-image:${body.image.id}`, id: body.image.id, name: body.image.name, mime: body.image.mime,
    size: body.image.bytes, previewUrl: `/api/images/${body.image.id}?thumbnail=1`,
  };
  return {
    token: `jupiter-file:${uploaded.id}`,
    id: uploaded.id,
    name: typeof uploaded.name === "string" ? uploaded.name : name,
    mime: typeof uploaded.mime === "string" ? uploaded.mime : undefined,
    size: typeof uploaded.size === "number" ? uploaded.size : file.size,
    previewUrl: `/api/files/${encodeURIComponent(uploaded.id)}`,
  };
}

export async function removeWebFile(fileId: string): Promise<void> {
  await webInit();
  const response = await fetch(`/api/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: webMutationHeaders(),
  });
  if (response.status === 409) reportInactiveWebController();
  await readJsonResponse(response);
}

export async function getWebWorkspaceChoices(): Promise<WebWorkspace[]> {
  await webInit();
  return webWorkspaces.map((workspace) => ({ ...workspace }));
}

function normalizeWebRpcPayload(payload: Record<string, any>): Record<string, any> {
  if (!["tab_open", "new_chat", "session_load"].includes(payload.cmd)) return payload;
  if (typeof payload.workspaceId === "string") return payload;
  const workspace = workspaceForLegacyPath(payload.workspaceDir);
  if (!workspace) return payload;
  const normalized: Record<string, any> = { ...payload, workspaceId: workspace.id };
  delete normalized.workspaceDir;
  return normalized;
}

function normalizeWebHostArgs(
  _command: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const fileId =
    typeof args.path === "string"
      ? /^jupiter-file:([0-9a-f-]{36})$/i.exec(args.path)?.[1]
      : undefined;
  if (fileId) {
    const normalized: Record<string, unknown> = { ...args, fileId };
    delete normalized.path;
    delete normalized.root;
    delete normalized.workspaceDir;
    return normalized;
  }
  if (typeof args.workspaceId === "string") return args;
  const workspace = workspaceForLegacyPath(args.root) ?? workspaceForLegacyPath(args.workspaceDir);
  if (!workspace) return args;
  const normalized: Record<string, unknown> = { ...args, workspaceId: workspace.id };
  delete normalized.root;
  delete normalized.workspaceDir;
  return normalized;
}

async function webRpc(payload: Record<string, any>): Promise<void> {
  await webInit();
  if (!webLease) throw new Error("This browser is connected in read-only mode");
  const commandId = makeBrowserId();
  const outgoing = prepareWebRpcPayload(normalizeWebRpcPayload(payload));
  try {
    const response = await fetch("/api/rpc", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...webMutationHeaders(),
      },
      body: JSON.stringify({ commandId, payload: outgoing }),
    });
    if (response.status === 409) reportInactiveWebController();
    await readJsonResponse(response);
  } catch (error) {
    if (typeof outgoing.requestId === "string") {
      pendingWebDownloads.delete(outgoing.requestId);
      pendingWebCopies.delete(outgoing.requestId);
    }
    throw error;
  }
}

function prepareWebRpcPayload(payload: Record<string, any>): Record<string, any> {
  if (payload.cmd === "session_export" && typeof payload.path === "string") {
    const match = /^jupiter-download:(.+)$/.exec(payload.path);
    if (match && typeof payload.requestId === "string") {
      pendingWebDownloads.set(payload.requestId, decodeURIComponent(match[1]!));
      pendingWebCopies.add(payload.requestId);
      const next: Record<string, any> = { ...payload, cmd: "session_copy" };
      delete next.path;
      return next;
    }
  }
  if (payload.cmd === "session_copy" && typeof payload.requestId === "string") {
    pendingWebCopies.add(payload.requestId);
  }
  return payload;
}

function terminalMutation(type: string, id: string, payload: Record<string, unknown> = {}) {
  if (!webLease) throw new Error("This browser is connected in read-only mode");
  return { type, id, leaseId: webLease.id, fence: webLease.fence, ...payload };
}

async function spawnWebTerminal(args: Record<string, unknown>): Promise<void> {
  await webInit();
  const id = String(args.id ?? "");
  const workspace = workspaceForLegacyPath(args.root) ?? workspaceForLegacyPath(args.workspaceId);
  if (!workspace) throw new Error("Choose an approved workspace before opening the terminal");
  closeWebTerminal(id);

  const endpoint = new URL("/api/terminal", window.location.href);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(endpoint);
  const connection: WebTerminalConnection = { socket, closing: false };
  webTerminalConnections.set(id, connection);

  socket.addEventListener("message", (event) => {
    let message: any;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message?.id && message.id !== id) return;
    if (message?.type === "output" && typeof message.data === "string") {
      broadcast("terminal:output", { id, data: message.data });
    } else if (message?.type === "exit") {
      broadcast("terminal:exit", {
        id,
        code: Number.isInteger(message.code) ? message.code : null,
      });
    } else if (message?.type === "error" && typeof message.message === "string") {
      broadcast("terminal:output", { id, data: `\r\n${message.message}\r\n` });
    }
  });
  socket.addEventListener("close", () => {
    if (webTerminalConnections.get(id) === connection) webTerminalConnections.delete(id);
    if (!connection.closing) broadcast("terminal:exit", { id, code: null });
  });

  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timeout = window.setTimeout(() => {
      socket.close();
      rejectOpen(new Error("Web terminal connection timed out"));
    }, 10_000);
    socket.addEventListener(
      "open",
      () => {
        window.clearTimeout(timeout);
        resolveOpen();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        window.clearTimeout(timeout);
        rejectOpen(new Error("Web terminal connection was rejected"));
      },
      { once: true },
    );
  });
  socket.send(
    JSON.stringify(
      terminalMutation("spawn", id, {
        workspaceId: workspace.id,
        cols: args.cols,
        rows: args.rows,
      }),
    ),
  );
}

function sendWebTerminal(type: "write" | "resize", args: Record<string, unknown>): void {
  const id = String(args.id ?? "");
  const connection = webTerminalConnections.get(id);
  if (!connection || connection.socket.readyState !== WebSocket.OPEN) return;
  const payload =
    type === "write" ? { data: args.data } : { cols: args.cols, rows: args.rows };
  connection.socket.send(JSON.stringify(terminalMutation(type, id, payload)));
}

function closeWebTerminal(id: string): void {
  const connection = webTerminalConnections.get(id);
  if (!connection) return;
  webTerminalConnections.delete(id);
  connection.closing = true;
  if (connection.socket.readyState === WebSocket.OPEN) {
    try {
      connection.socket.send(JSON.stringify(terminalMutation("kill", id)));
    } catch {
      // The server will kill the PTY when the socket closes.
    }
  }
  connection.socket.close();
}

function downloadBrowserText(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || "jupiter-export.md";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function writeBrowserClipboard(content: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(content);
      return;
    } catch {
      // Fall through to the legacy selection path for browsers requiring activation.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = content;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Browser clipboard permission was denied");
}

const webHostServices = createWebHostServices({
  ensureReady: webInit,
  getRequestHeaders: webMutationHeaders,
  onInactiveController: reportInactiveWebController,
  normalizeArgs: normalizeWebHostArgs,
  makeOperationId: makeBrowserId,
});

function notifyCliStatus(connected: boolean) {
  if (cliDisconnected !== connected) {
    cliDisconnected = !connected;
    if (!connected) {
      emitEvent({ type: "status", text: "正在重连…", tabId: "tab-1" });
    } else {
      emitEvent({ type: "status", text: "连接已恢复", tabId: "tab-1" });
    }
  }
}

// SSE DashboardEvent → IncomingEvent 转换
function sseToIncoming(ev: any): Record<string, any>[] {
  const results: Record<string, any>[] = [];

  switch (ev.kind) {
    case "assistant_delta": {
      if (!sseTurnStarted) {
        sseTurnStarted = true;
        currentTurn++;
        results.push({
          type: "model.turn.started",
          tabId: "tab-1",
          id: ev.id,
          turn: currentTurn,
          model: "deepseek-reasoner",
        });
      }
      if (ev.contentDelta) {
        results.push({
          type: "model.delta",
          tabId: "tab-1",
          channel: "content",
          text: ev.contentDelta,
          turn: currentTurn,
        });
      }
      if (ev.reasoningDelta) {
        results.push({
          type: "model.delta",
          tabId: "tab-1",
          channel: "reasoning",
          text: ev.reasoningDelta,
          turn: currentTurn,
        });
      }
      break;
    }
    case "assistant_final": {
      // Loop's `assistant_final` fires per model iteration (mid-turn it
      // precedes tool dispatch); the real turn end is signaled by
      // `busy-change` (busy=false), handled below.
      results.push({
        type: "model.final",
        tabId: "tab-1",
        turn: currentTurn,
        content: ev.text ?? "",
        reasoningContent: ev.reasoning ?? "",
        usage: ev.usage ?? undefined,
        costUsd: ev.costUsd ?? undefined,
      });
      break;
    }
    case "tool_start": {
      results.push({
        type: "tool.preparing",
        tabId: "tab-1",
        turn: currentTurn,
        callId: ev.id,
        name: ev.toolName,
      });
      results.push({
        type: "tool.intent",
        tabId: "tab-1",
        turn: currentTurn,
        callId: ev.id,
        name: ev.toolName,
        args: ev.args ?? "",
      });
      break;
    }
    case "tool": {
      results.push({
        type: "tool.result",
        tabId: "tab-1",
        turn: currentTurn,
        callId: ev.id,
        name: ev.toolName,
        output: ev.content,
        ok: true,
      });
      break;
    }
    case "user": {
      results.push({
        type: "user.message",
        tabId: "tab-1",
        id: ev.id,
        turn: currentTurn,
        text: ev.text,
      });
      break;
    }
    case "busy-change": {
      if (!ev.busy && sseTurnStarted) {
        results.push({ type: "$turn_complete", tabId: "tab-1" });
        sseTurnStarted = false;
      }
      break;
    }
    case "modal-up": {
      const m = ev.modal;
      if (m?.kind === "shell") {
        results.push({
          type: "$confirm_required",
          tabId: "tab-1",
          id: m.id ?? ++eventIdCounter,
          kind: "run_command",
          command: m.command,
        });
      } else if (m?.kind === "choice") {
        results.push({
          type: "$choice_required",
          tabId: "tab-1",
          id: m.id ?? ++eventIdCounter,
          question: m.question,
          options: m.options ?? [],
          allowCustom: m.allowCustom ?? false,
        });
      } else if (m?.kind === "plan") {
        results.push({
          type: "$plan_required",
          tabId: "tab-1",
          id: m.id ?? ++eventIdCounter,
          plan: m.plan ?? "",
          summary: m.summary,
          steps: m.steps,
        });
      } else if (m?.kind === "checkpoint") {
        results.push({
          type: "$checkpoint_required",
          tabId: "tab-1",
          id: m.id ?? ++eventIdCounter,
          stepId: m.stepId,
          title: m.title,
          result: m.result,
          notes: m.notes,
          completed: m.completed,
          total: m.total,
        });
      }
      break;
    }
    case "modal-down": {
      // Sync close from another surface (TUI or sibling tab).
      if (typeof ev.modalKind === "string") {
        results.push({ type: "$modal_dismissed", tabId: "tab-1", kind: ev.modalKind });
      }
      break;
    }
    case "warning":
    case "error": {
      results.push({
        type: "$error",
        tabId: "tab-1",
        message: ev.text,
      });
      break;
    }
    case "status": {
      results.push({
        type: "status",
        tabId: "tab-1",
        text: ev.text,
      });
      break;
    }
    case "ping":
      break; // keep-alive, no action needed
    default:
      console.warn("[tauri-bridge] unhandled SSE event kind:", ev.kind);
  }
  return results;
}

function connectSSE(): void {
  if (sse) sse.close();
  const token = document.querySelector('meta[name="jupiter-token"]')?.getAttribute("content") ?? "";
  const sseUrl =
    token && token !== "__JUPITER_TOKEN__"
      ? `/api/events?token=${encodeURIComponent(token)}`
      : "/api/events";
  sse = new EventSource(sseUrl);
  sse.onmessage = (msg: MessageEvent) => {
    try {
      const dashboardEvent = JSON.parse(msg.data);
      // Token 无效时显示过期提示
      if (dashboardEvent.kind === "error" && dashboardEvent.text?.includes("token")) {
        emitEvent({
          type: "$error",
          tabId: "tab-1",
          message: "链接已过期，请重新从 CLI 打开",
        });
        return;
      }
      const events = sseToIncoming(dashboardEvent);
      for (const evt of events) emitEvent(evt);
      // 成功收到事件，重置重连计数
      sseReconnectAttempts = 0;
      notifyCliStatus(true);
    } catch (err) {
      console.warn("[tauri-bridge] bad SSE event:", err);
    }
  };
  sse.onerror = () => {
    console.warn("[tauri-bridge] SSE connection lost, retrying…");
    sse?.close();
    sse = null;
    notifyCliStatus(false);

    sseReconnectAttempts++;
    if (sseReconnectAttempts > SSE_MAX_RECONNECT_ATTEMPTS) {
      emitEvent({
        type: "$error",
        tabId: "tab-1",
        message: "CLI 已停止，请重新启动",
      });
      return;
    }

    const delay = SSE_RECONNECT_BASE_DELAY * Math.pow(2, sseReconnectAttempts - 1);
    setTimeout(connectSSE, Math.min(delay, 30000));
  };

  // SSE 连接成功后，开始定期轮询 overview/sessions 更新右侧状态和会话列表
  startStatsPolling();
}

// 定期轮询 stats/balance/sessions
let statsPollTimer: ReturnType<typeof setInterval> | null = null;

function startStatsPolling(): void {
  if (statsPollTimer) clearInterval(statsPollTimer);
  // 每 5 秒轮询一次，补偿 SSE 重连、App remount、以及其他终端写入 session 文件的情况。
  statsPollTimer = setInterval(async () => {
    try {
      await refreshServerSnapshots();
    } catch {
      // 静默失败，等待下次轮询
    }
  }, 5000);
}

// REST API 辅助
async function apiFetch(endpoint: string, options?: RequestInit): Promise<any> {
  const token = document.querySelector('meta[name="jupiter-token"]')?.getAttribute("content");
  const headers: Record<string, string> = {
    ...((options?.headers as Record<string, string>) ?? {}),
  };
  if (token && token !== "__JUPITER_TOKEN__") {
    headers["x-jupiter-token"] = token;
  }
  if (options?.body && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`/api/${endpoint}`, { ...options, headers });
  if (res.status === 204) return null;
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function emitServerSettings(settings: any, overview?: any): void {
  emitEvent({
    type: "$settings",
    tabId: "tab-1",
    reasoningEffort: settings?.reasoningEffort ?? overview?.reasoningEffort ?? "high",
    editMode: settings?.editMode ?? overview?.editMode ?? "review",
    budgetUsd: settings?.budgetUsd ?? overview?.budgetUsd ?? null,
    workspaceDir: overview?.cwd ?? "",
    recentWorkspaces: [],
    model: overview?.model ?? settings?.model ?? "deepseek-flash",
    editor: "code",
    webSearchEngine: settings?.webSearchEngine ?? "bing",
    webSearchApiKeys: settings?.webSearchApiKeys ?? {},
    subagentModels: settings?.subagentModels ?? {},
    version: overview?.version ?? "",
    baseUrl: settings?.baseUrl ?? "",
    apiKeyPrefix: settings?.apiKey ?? "",
  });
}

function finiteNumber(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

interface ServerSessionItem {
  name: string;
  messageCount: number;
  mtime: number;
  summary?: string;
  workspaceStatus?: "matched" | "legacy_missing_meta";
}

interface ServerSessionsResponse {
  sessions?: ServerSessionItem[];
  currentSession?: string | null;
}

interface ServerBalanceEntry {
  currency: string;
  total_balance: string;
}

interface ServerOverviewStats {
  totalCostUsd?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  totalCompletionTokens?: number;
  balance?: ServerBalanceEntry[];
}

interface ServerOverviewResponse {
  stats?: ServerOverviewStats;
}

function mapSessionItem(s: ServerSessionItem) {
  return {
    name: s.name,
    messageCount: s.messageCount,
    mtime: new Date(s.mtime).toISOString(),
    summary: s.summary,
    workspaceStatus: s.workspaceStatus,
  };
}

function emitSessionsSnapshot(sessionsData: ServerSessionsResponse | null | undefined): void {
  if (!sessionsData?.sessions) return;
  emitEvent({
    type: "$sessions",
    tabId: "tab-1",
    currentSession:
      typeof sessionsData.currentSession === "string" ? sessionsData.currentSession : null,
    items: sessionsData.sessions.map(mapSessionItem),
  });
}

function emitOverviewSnapshot(overview: ServerOverviewResponse | null | undefined): void {
  const stats = overview?.stats;
  if (!stats) return;

  const cacheHitTokens = finiteNumber(stats.cacheHitTokens);
  const cacheMissTokens = finiteNumber(stats.cacheMissTokens);
  emitEvent({
    type: "$session_usage",
    tabId: "tab-1",
    totalCostUsd: finiteNumber(stats.totalCostUsd),
    totalPromptTokens: cacheHitTokens + cacheMissTokens,
    totalCompletionTokens: finiteNumber(stats.totalCompletionTokens),
    cacheHitTokens,
    cacheMissTokens,
  });

  const firstBalance = stats.balance?.[0];
  if (firstBalance) {
    emitEvent({
      type: "$balance",
      tabId: "tab-1",
      currency: firstBalance.currency,
      total: Number.parseFloat(firstBalance.total_balance) || 0,
      isAvailable: true,
    });
  }
}

async function refreshServerSnapshots(): Promise<void> {
  const [sessionsData, overview] = await Promise.all([apiFetch("sessions"), apiFetch("overview")]);
  emitSessionsSnapshot(sessionsData);
  emitOverviewSnapshot(overview);
}

// 初始化 Server 状态
function emitMcpSpecsFromServer(specs: any[] | undefined, bridged: any[] | undefined): void {
  const live = new Map<string, any>();
  for (const s of bridged ?? []) {
    if (typeof s?.spec === "string") live.set(s.spec, s);
  }
  const out = (specs ?? []).map((s: any) => {
    const liveEntry = live.get(s.raw);
    return {
      raw: s.raw,
      name: s.name ?? null,
      transport: s.transport,
      summary: s.summary,
      parseError: s.parseError,
      status: liveEntry ? "connected" : s.parseError ? "failed" : "configured",
      statusReason: liveEntry ? undefined : s.parseError,
      toolCount: liveEntry?.toolCount,
    };
  });
  emitEvent({
    type: "$mcp_specs",
    tabId: "tab-1",
    specs: out,
    bridged: out.length > 0 && out.every((s) => s.status === "connected"),
  });
}

function emitSkillsFromServer(data: any): void {
  const items: any[] = [];
  const tag = (rows: any[] | undefined, scope: string) => {
    for (const r of rows ?? []) {
      items.push({
        name: r.name,
        description: r.description ?? "",
        scope,
        path: r.path ?? "",
        runAs: r.runAs ?? "inline",
        model: r.model,
      });
    }
  };
  tag(data?.builtin, "builtin");
  tag(data?.global, "global");
  tag(data?.custom, "global");
  tag(data?.project, "project");
  emitEvent({ type: "$skills", tabId: "tab-1", items });
}

function emitMemoryEntriesFromServer(entries: any[] | undefined): void {
  emitEvent({ type: "$memory", tabId: "tab-1", entries: entries ?? [] });
}

async function loadAndEmitMcp(): Promise<void> {
  try {
    const [specsResp, liveResp] = await Promise.all([apiFetch("mcp/specs"), apiFetch("mcp")]);
    emitMcpSpecsFromServer(specsResp?.specs, liveResp?.servers);
  } catch (err) {
    console.warn("[tauri-bridge] mcp fetch failed:", err);
  }
}

async function loadAndEmitSkills(): Promise<void> {
  try {
    const data = await apiFetch("skills");
    if (data) emitSkillsFromServer(data);
  } catch (err) {
    console.warn("[tauri-bridge] skills fetch failed:", err);
  }
}

async function loadAndEmitMemory(): Promise<void> {
  try {
    const data = await apiFetch("memory/entries");
    emitMemoryEntriesFromServer(data?.entries);
  } catch (err) {
    console.warn("[tauri-bridge] memory fetch failed:", err);
  }
}

async function loadAndEmitMemoryDetail(path: string): Promise<void> {
  try {
    const data = await apiFetch(`memory/read?path=${encodeURIComponent(path)}`);
    if (data?.detail) emitEvent({ type: "$memory_detail", tabId: "tab-1", detail: data.detail });
  } catch (err) {
    console.warn("[tauri-bridge] memory read failed:", err);
  }
}

async function serverInit(): Promise<void> {
  document.documentElement.dataset.web = "true";

  // 加载初始设置和会话；overview 提供 workspace 等信息
  let wsDir = "";
  try {
    const [settings, sessionsData, overview] = await Promise.all([
      apiFetch("settings"),
      apiFetch("sessions"),
      apiFetch("overview"),
    ]);
    wsDir = overview?.cwd ?? "";
    if (settings) emitServerSettings(settings, overview);
    emitSessionsSnapshot(sessionsData);
    emitOverviewSnapshot(overview);
  } catch (err) {
    console.warn("[tauri-bridge] server init failed:", err);
  }

  // Sidebar/right-rail panels — desktop pushes these on tab open; web has
  // to pull them or every panel renders empty forever (#1715).
  void Promise.all([loadAndEmitMcp(), loadAndEmitSkills(), loadAndEmitMemory()]);

  emitEvent({ type: "$ready", tabId: "tab-1" });
  emitEvent({
    type: "$tab_opened",
    tabId: "tab-1",
    workspaceDir: wsDir,
    active: true,
  });

  // 连接 SSE
  connectSSE();
}

// RPC 命令 → REST API 映射
async function serverRpc(payload: Record<string, any>): Promise<void> {
  const cmd = payload.cmd;

  switch (cmd) {
    case "user_input": {
      const result = await apiFetch("submit", {
        method: "POST",
        body: JSON.stringify({ prompt: payload.text }),
      }).catch((err) => {
        console.warn("[tauri-bridge] submit failed:", err);
        return null;
      });
      // 提交失败时通知前端保留草稿
      if (!result?.accepted) {
        emitEvent({
          type: "$error",
          tabId: "tab-1",
          message: result?.reason ?? "提交失败，请重试",
        });
      }
      break;
    }
    case "abort": {
      await apiFetch("abort", { method: "POST" }).catch(() => {});
      break;
    }
    case "session_list": {
      try {
        const data = await apiFetch("sessions");
        emitSessionsSnapshot(data);
      } catch {
        /* ignore */
      }
      break;
    }
    case "session_load": {
      try {
        const switchData = await apiFetch(`sessions/${encodeURIComponent(payload.name)}/switch`, {
          method: "POST",
        });
        if (!switchData?.ok) {
          console.warn("[tauri-bridge] session switch failed:", payload.name, switchData);
          break;
        }
        const data = await apiFetch(`sessions/${encodeURIComponent(payload.name)}`);
        if (!Array.isArray(data?.messages)) {
          console.warn("[tauri-bridge] session_load: GET response missing messages", data);
          break;
        }
        const raw = data.messages as any[];
        // Pre-pass: map tool-result rows by their call id so we can stitch
        // them into the assistant message that issued the call. Without
        // this, every tool segment in the replay shows "(no result)".
        const toolResults = new Map<string, { content: string; name?: string }>();
        for (const m of raw) {
          if (m?.role === "tool" && typeof m.toolCallId === "string") {
            toolResults.set(m.toolCallId, {
              content: typeof m.content === "string" ? m.content : "",
              name: typeof m.toolName === "string" ? m.toolName : undefined,
            });
          }
        }
        const messages: any[] = [];
        for (const m of raw) {
          if (m?.role === "user") {
            messages.push({ kind: "user" as const, text: m.content ?? "" });
            continue;
          }
          if (m?.role === "assistant") {
            const segments: any[] = [];
            if (typeof m.reasoning === "string" && m.reasoning.length > 0) {
              segments.push({ kind: "reasoning" as const, text: m.reasoning });
            }
            if (typeof m.content === "string" && m.content.length > 0) {
              segments.push({ kind: "text" as const, text: m.content });
            }
            if (Array.isArray(m.toolCalls)) {
              for (const tc of m.toolCalls) {
                const result = toolResults.get(tc.id);
                segments.push({
                  kind: "tool" as const,
                  callId: tc.id,
                  name: tc.name || result?.name || "tool",
                  args: tc.arguments ?? "",
                  startedAt: 0,
                  result: result?.content,
                  ok: result != null,
                  durationMs: 0,
                });
              }
            }
            messages.push({
              kind: "assistant" as const,
              turn: m.turn ?? 0,
              segments,
              pending: false,
            });
          }
          // tool-role messages are absorbed into their matching assistant segment above.
        }
        emitEvent({
          type: "$session_loaded",
          tabId: "tab-1",
          name: payload.name,
          messages,
          carryover: { totalCostUsd: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
        });
      } catch (err) {
        console.warn("[tauri-bridge] session load failed:", err);
      }
      break;
    }
    case "session_delete": {
      try {
        await apiFetch(`sessions/${encodeURIComponent(payload.name)}`, { method: "DELETE" });
        // 删除后刷新列表
        const data = await apiFetch("sessions");
        emitSessionsSnapshot(data);
      } catch {
        /* ignore */
      }
      break;
    }
    case "new_chat": {
      try {
        const data = await apiFetch("sessions/new", { method: "POST" });
        if (data?.ok) {
          const newName = typeof data.name === "string" ? data.name : "default";
          // Treat a fresh session like a loaded-empty session so the reducer
          // resets state.currentSession + messages. `$session_empty` is for
          // "file exists but unparseable" and would render a scary error.
          emitEvent({
            type: "$session_loaded",
            tabId: "tab-1",
            name: newName,
            messages: [],
            carryover: { totalCostUsd: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
          });
          const listData = await apiFetch("sessions");
          emitSessionsSnapshot(listData);
          const overview = await apiFetch("overview");
          emitOverviewSnapshot(overview);
        }
      } catch {
        /* fallback */
      }
      break;
    }
    case "settings_get": {
      try {
        const [settings, overview] = await Promise.all([
          apiFetch("settings"),
          apiFetch("overview"),
        ]);
        if (settings) emitServerSettings(settings, overview);
      } catch {
        /* ignore */
      }
      break;
    }
    case "settings_save": {
      try {
        await apiFetch("settings", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        // 保存后主动拉取最新设置以同步 UI
        const [settings, overview] = await Promise.all([
          apiFetch("settings"),
          apiFetch("overview"),
        ]);
        if (settings) emitServerSettings(settings, overview);
      } catch {
        /* ignore */
      }
      break;
    }
    case "setup_save_key": {
      await apiFetch("settings", {
        method: "POST",
        body: JSON.stringify({ apiKey: payload.key }),
      }).catch(() => {});
      break;
    }
    case "confirm_response": {
      const kind = payload.kind === "path" ? "path" : "shell";
      await apiFetch("modal/resolve", {
        method: "POST",
        body: JSON.stringify({ kind, choice: payload.response.type }),
      }).catch(() => {});
      break;
    }
    case "choice_response": {
      const r = payload.response;
      let choice: Record<string, unknown>;
      if (r.type === "pick") choice = { kind: "pick", optionId: r.optionId };
      else if (r.type === "text") choice = { kind: "custom", text: r.text };
      else choice = { kind: "cancel" };
      await apiFetch("modal/resolve", {
        method: "POST",
        body: JSON.stringify({ kind: "choice", choice }),
      }).catch(() => {});
      break;
    }
    case "plan_response": {
      const r = payload.response;
      await apiFetch("modal/resolve", {
        method: "POST",
        body: JSON.stringify({ kind: "plan", choice: r.type, text: r.feedback }),
      }).catch(() => {});
      break;
    }
    case "checkpoint_response": {
      const r = payload.response;
      const text = r.type === "revise" ? r.feedback : undefined;
      await apiFetch("modal/resolve", {
        method: "POST",
        body: JSON.stringify({ kind: "checkpoint", choice: r.type, text }),
      }).catch(() => {});
      break;
    }
    case "revision_response": {
      const r = payload.response;
      // Server takes "accept" / "reject"; verdict uses past-participle.
      const choice = r.type === "accepted" ? "accept" : r.type === "rejected" ? "reject" : null;
      if (choice === null) break;
      await apiFetch("modal/resolve", {
        method: "POST",
        body: JSON.stringify({ kind: "revision", choice }),
      }).catch(() => {});
      break;
    }
    case "jobs_list": {
      try {
        const data = await apiFetch("usage");
        if (data?.jobs) {
          emitEvent({ type: "$jobs", tabId: "tab-1", items: data.jobs });
        }
      } catch {
        /* ignore */
      }
      break;
    }
    case "mention_query": {
      try {
        const data = await apiFetch(
          `files/search?q=${encodeURIComponent(payload.query)}&nonce=${payload.nonce}`,
        );
        if (data) {
          emitEvent({
            type: "$mention_results",
            tabId: "tab-1",
            nonce: payload.nonce,
            query: payload.query,
            results: data.results ?? [],
          });
        }
      } catch {
        /* ignore */
      }
      break;
    }
    case "mention_preview": {
      try {
        const data = await apiFetch(
          `file-read?path=${encodeURIComponent(payload.path)}&nonce=${payload.nonce}`,
        );
        if (data) {
          emitEvent({
            type: "$mention_preview",
            tabId: "tab-1",
            nonce: payload.nonce,
            path: payload.path,
            head: data.head ?? "",
            totalLines: data.totalLines ?? 0,
          });
        }
      } catch {
        /* ignore */
      }
      break;
    }
    // ── 桌面端特有操作（Web 版无操作或静默忽略） ──
    case "qq_status_get":
    case "qq_connect":
    case "qq_disconnect":
    case "qq_config_save":
    case "tab_activate":
    case "tab_open":
    case "tab_close":
    case "mention_picked":
    case "btw": {
      // 这些命令在 Web Server 模式下无对应 REST API，静默忽略
      break;
    }
    case "jobs_stop": {
      try {
        await apiFetch(`jobs/${payload.jobId}/stop`, { method: "POST" });
      } catch {}
      break;
    }
    case "jobs_stop_all": {
      try {
        await apiFetch("jobs/stop-all", { method: "POST" });
      } catch {}
      break;
    }
    case "compact_history": {
      try {
        await apiFetch("messages/compact", { method: "POST" });
      } catch {}
      break;
    }
    case "retry": {
      try {
        await apiFetch("submit", { method: "POST", body: JSON.stringify({ retry: true }) });
      } catch {}
      break;
    }
    case "skill_run": {
      const body: Record<string, any> = { name: payload.name };
      if (payload.args) body.args = payload.args;
      try {
        await apiFetch("skills/run", { method: "POST", body: JSON.stringify(body) });
      } catch {}
      break;
    }
    case "mcp_specs_get": {
      await loadAndEmitMcp();
      break;
    }
    case "skills_get": {
      await loadAndEmitSkills();
      break;
    }
    case "memory_get": {
      await loadAndEmitMemory();
      break;
    }
    case "memory_read": {
      if (typeof payload.path === "string") await loadAndEmitMemoryDetail(payload.path);
      break;
    }
    case "mcp_specs_add":
    case "mcp_specs_remove": {
      // MCP 操作通过 REST API 管理
      try {
        await apiFetch("mcp", {
          method: "POST",
          body: JSON.stringify({
            action: cmd === "mcp_specs_add" ? "add" : "remove",
            spec: payload.spec,
          }),
        });
        await loadAndEmitMcp();
      } catch {}
      break;
    }
    default:
      console.warn("[tauri-bridge] unhandled RPC cmd:", cmd);
  }
}

// // ═══ 导出接口（Mock + Server 双模式）
// Tauri core API
export async function invoke<T = unknown>(cmd: string, args?: any): Promise<T> {
  console.log(`[tauri-bridge] invoke -> cmd: ${cmd}`);

  if (MODE === "web") {
    if (cmd === "rpc_spawn") {
      await webInit();
      return undefined as T;
    }
    if (cmd === "rpc_send") {
      const payload = JSON.parse(args.line);
      await webRpc(payload);
      return undefined as T;
    }
    if (cmd === "read_clipboard_file_paths") return [] as T;
    if (cmd === "web_upload_file") {
      return (await uploadWebFile(args.file, args.file.name)).token as T;
    }
    if (cmd === "save_clipboard_image") {
      const bytes = args?.bytes;
      const body =
        bytes instanceof ArrayBuffer
          ? new Uint8Array(bytes)
          : ArrayBuffer.isView(bytes)
            ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            : new Uint8Array(Array.isArray(bytes) ? bytes : []);
      const extension = String(args?.extension || "png").replace(/[^a-z0-9]/gi, "") || "png";
      const copy = new ArrayBuffer(body.byteLength);
      new Uint8Array(copy).set(body);
      const uploaded = await uploadWebFile(
        new Blob([copy], { type: `image/${extension === "jpg" ? "jpeg" : extension}` }),
        `jupiter-pasted-image.${extension}`,
      );
      return uploaded.token as T;
    }
    if (cmd === "web_upload_remove") {
      const token = String(args?.path ?? "");
      const fileId = /^jupiter-file:([0-9a-f-]{36})$/i.exec(token)?.[1];
      if (fileId) await removeWebFile(fileId);
      return undefined as T;
    }
    if (cmd === "web_devices_get") {
      await webInit();
      const response = await fetch("/api/devices", { credentials: "same-origin" });
      const body = await readJsonResponse(response);
      return { ...body, currentDeviceId: webDeviceId } as T;
    }
    if (cmd === "web_pairing_create") {
      await webInit();
      const response = await fetch("/api/pairing", {
        method: "POST",
        credentials: "same-origin",
        headers: webMutationHeaders(),
      });
      if (response.status === 409) reportInactiveWebController();
      return (await readJsonResponse(response)) as T;
    }
    if (cmd === "web_device_revoke") {
      await webInit();
      const deviceId = encodeURIComponent(String(args?.deviceId ?? ""));
      const response = await fetch(`/api/devices/${deviceId}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: webMutationHeaders(),
      });
      if (response.status === 409) reportInactiveWebController();
      return (await readJsonResponse(response)) as T;
    }
    if (cmd === "web_take_control") {
      await acquireWebLease(true);
      return { lease: webLease } as T;
    }
    if (cmd === "write_text_file" && typeof args?.path === "string") {
      const match = /^jupiter-download:(.+)$/.exec(args.path);
      if (!match) throw new Error("write_text_file is not available in Jupiter Web Beta");
      downloadBrowserText(decodeURIComponent(match[1]!), String(args?.content ?? ""));
      return undefined as T;
    }
    if (cmd === "terminal_spawn") {
      await spawnWebTerminal((args ?? {}) as Record<string, unknown>);
      return undefined as T;
    }
    if (cmd === "terminal_write" || cmd === "terminal_resize") {
      sendWebTerminal(cmd === "terminal_write" ? "write" : "resize", args ?? {});
      return undefined as T;
    }
    if (cmd === "terminal_kill") {
      closeWebTerminal(String(args?.id ?? ""));
      return undefined as T;
    }
    if (webHostServices.supports(cmd))
      return webHostServices.invoke<T>(cmd, (args ?? {}) as Record<string, unknown>);
    throw new Error(`${cmd} is not available in Jupiter Web Beta`);
  }

  if (MODE === "server") {
    if (cmd === "rpc_spawn") {
      serverInit().catch(console.warn);
      return undefined as T;
    }
    if (cmd === "rpc_send") {
      const payload = JSON.parse(args.line);
      payload.tabId = payload.tabId ?? "tab-1";
      serverRpc(payload).catch(console.warn);
      return undefined as T;
    }
    if (cmd === "open_in_editor") {
      console.log("[tauri-bridge] open in editor:", args);
      return undefined as T;
    }
    return undefined as T;
  }

  // Mock mode
  if (cmd === "rpc_spawn") {
    mockSetupAndReady();
    return undefined as T;
  }

  if (cmd === "rpc_send") {
    const payload = JSON.parse(args.line);
    if (payload.cmd === "user_input") {
      emitEvent({
        type: "user.message",
        tabId: "tab-1",
        id: Date.now(),
        ts: new Date().toISOString(),
        turn: 2,
        text: payload.text,
      });
      mockAssistantTurn(payload.text);
    } else if (payload.cmd === "session_list") {
      emitEvent({ type: "$sessions", tabId: "tab-1", items: mockSessions });
    } else if (payload.cmd === "session_load") {
      emitEvent({
        type: "$session_loaded",
        tabId: "tab-1",
        name: payload.name,
        messages: mockMessages,
        carryover: { totalCostUsd: 0.045, cacheHitTokens: 2500, cacheMissTokens: 1400 },
      });
    } else if (payload.cmd === "new_chat") {
      emitEvent({
        type: "$session_empty",
        tabId: "tab-1",
        name: "desktop-new-session",
        sizeBytes: 0,
      });
    } else if (payload.cmd === "settings_get") {
      emitEvent({ type: "$settings", tabId: "tab-1", ...mockSettings });
    }
    return undefined as T;
  }

  if (cmd === "open_in_editor") {
    console.log("[tauri-bridge] open in editor simulation:", args);
    return undefined as T;
  }

  return undefined as T;
}

// 2. @tauri-apps/api/event
export async function listen<T = any>(
  eventName: string,
  callback: EventCallback<T>,
): Promise<UnlistenFn> {
  let bucket = listeners.get(eventName);
  if (!bucket) {
    bucket = new Set();
    listeners.set(eventName, bucket);
  }
  bucket.add(callback);
  return () => {
    const b = listeners.get(eventName);
    if (b) b.delete(callback);
  };
}

// // ═══ Mock 数据（仅 Vite 开发模式使用）
//
const mockSessions = [
  {
    name: "desktop-20260520-1",
    messageCount: 8,
    mtime: new Date().toISOString(),
    summary: "项目工程模块重构及自适应 UI 设计",
  },
  {
    name: "desktop-20260519-2",
    messageCount: 14,
    mtime: new Date(Date.now() - 86400000).toISOString(),
    summary: "编写 WebSocket 桥接与 RPC 行协议对接逻辑",
  },
  {
    name: "desktop-20260518-3",
    messageCount: 4,
    mtime: new Date(Date.now() - 172800000).toISOString(),
    summary: "测试移动端 TextArea 与 Dynamic Viewport",
  },
];

const mockSettings = {
  reasoningEffort: "high",
  editMode: "review",
  budgetUsd: null,
  workspaceDir: "",
  recentWorkspaces: [],
  model: "deepseek-flash",
  version: "0.47.2",
};

const mockMessages: any[] = [
  { kind: "user", text: "你好 Jupiter，帮我列出这个项目的主要技术栈以及前端架构体系。" },
  {
    kind: "assistant",
    turn: 1,
    segments: [
      { kind: "reasoning", text: "用户询问项目的技术栈和前端架构。" },
      { kind: "text", text: "你好！**Jupiter** 是一个以 DeepSeek 为内核的智能代码助手…" },
    ],
    pending: false,
  },
];

function mockAssistantTurn(_promptText: string) {
  emitEvent({ type: "status", text: "DeepSeek R1 思考中...", tabId: "tab-1" });
  setTimeout(() => {
    emitEvent({
      type: "model.turn.started",
      tabId: "tab-1",
      id: Date.now(),
      turn: 2,
      model: "deepseek-reasoner",
      reasoningEffort: "high",
    });
  }, 600);
  // reasoning deltas
  const lines = ["分析用户的输入内容。\n", "用户要求提供自适应 UI 重构的验证指令。\n"];
  let delay = 1200;
  lines.forEach((line) => {
    setTimeout(() => {
      emitEvent({ type: "model.delta", tabId: "tab-1", channel: "reasoning", text: line, turn: 2 });
    }, delay);
    delay += 800;
  });
  // tool call
  setTimeout(() => {
    emitEvent({ type: "tool.preparing", tabId: "tab-1", name: "list_dir", callId: "call_12345" });
  }, delay);
  delay += 500;
  setTimeout(() => {
    emitEvent({
      type: "tool.intent",
      tabId: "tab-1",
      name: "list_dir",
      args: JSON.stringify({ DirectoryPath: "d:/AI/workspace/dashboard" }),
      callId: "call_12345",
    });
  }, delay);
  delay += 1000;
  setTimeout(() => {
    emitEvent({
      type: "tool.result",
      tabId: "tab-1",
      name: "list_dir",
      ok: true,
      output: JSON.stringify([
        { name: "package.json", sizeBytes: 864 },
        { name: "src", isDir: true },
      ]),
      callId: "call_12345",
    });
  }, delay);
  delay += 800;
  // text response
  const chunks = [
    "您的 dashboard 目录结构已确认。在**独立 Mock 开发预览阶段**，\n",
    "您可以使用 `npm run dev` 启动 Vite 开发服务，\n",
    "配合 Chrome 设备模拟器或真实手机进行移动端自适应效果验证。\n",
    "手机端支持侧滑拉出会话抽屉，输入框紧贴虚拟键盘。",
  ];
  chunks.forEach((chunk) => {
    setTimeout(() => {
      emitEvent({ type: "model.delta", tabId: "tab-1", channel: "content", text: chunk, turn: 2 });
    }, delay);
    delay += 500;
  });
  setTimeout(() => {
    emitEvent({
      type: "model.final",
      tabId: "tab-1",
      turn: 2,
      content: chunks.join(""),
      reasoningContent: lines.join(""),
      costUsd: 0.002,
    });
    emitEvent({ type: "$turn_complete", tabId: "tab-1" });
  }, delay + 400);
}

function mockSetupAndReady() {
  document.documentElement.dataset.web = "true";
  setTimeout(() => emitEvent({ type: "$ready", tabId: "tab-1" }), 100);
  setTimeout(() => {
    emitEvent({
      type: "$tab_opened",
      tabId: "tab-1",
      workspaceDir: "d:\\AI\\workspace",
      active: true,
    });
  }, 150);
  setTimeout(() => emitEvent({ type: "$settings", tabId: "tab-1", ...mockSettings }), 200);
  setTimeout(() => emitEvent({ type: "$sessions", tabId: "tab-1", items: mockSessions }), 350);
}

export interface RuntimeTransport {
  invoke: typeof invoke;
  listen: typeof listen;
}

export const runtimeTransport: RuntimeTransport = Object.freeze({ invoke, listen });
