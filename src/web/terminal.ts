import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import * as pty from "node-pty";
import { type RawData, WebSocket, WebSocketServer } from "ws";

const MAX_TERMINALS_PER_CONNECTION = 2;
const MAX_SOCKET_BUFFER_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;

type TerminalMutation = {
  type: "spawn" | "write" | "resize" | "kill";
  id: string;
  leaseId: string;
  fence: number;
  workspaceId?: string;
  cols?: number;
  rows?: number;
  data?: string;
};

export interface WebTerminalAuthorization {
  deviceId: string;
  validateLease(leaseId: string, fence: number): boolean;
  resolveWorkspace(workspaceId: string): Promise<string>;
}

type TerminalConnection = {
  socket: WebSocket;
  authorization: WebTerminalAuthorization;
  terminals: Map<string, pty.IPty>;
};

/** Owns browser terminal PTYs. Every connection is fenced to one paired device. */
export class WebTerminalManager {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_INPUT_BYTES,
    perMessageDeflate: false,
  });
  private readonly connectionsByDevice = new Map<string, Set<TerminalConnection>>();

  accept(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    authorization: WebTerminalAuthorization,
  ): void {
    this.server.handleUpgrade(request, socket, head, (webSocket) => {
      this.bind(webSocket, authorization);
    });
  }

  closeDevice(deviceId: string): void {
    const connections = this.connectionsByDevice.get(deviceId);
    if (!connections) return;
    for (const connection of [...connections])
      this.closeConnection(connection, 4003, "access revoked");
  }

  close(): void {
    for (const connections of this.connectionsByDevice.values()) {
      for (const connection of [...connections])
        this.closeConnection(connection, 1001, "server closing");
    }
    this.connectionsByDevice.clear();
    this.server.close();
  }

  private bind(socket: WebSocket, authorization: WebTerminalAuthorization): void {
    const connection: TerminalConnection = { socket, authorization, terminals: new Map() };
    const existing = this.connectionsByDevice.get(authorization.deviceId) ?? new Set();
    existing.add(connection);
    this.connectionsByDevice.set(authorization.deviceId, existing);

    let queue = Promise.resolve();
    socket.on("message", (raw, isBinary) => {
      queue = queue
        .then(() => this.handleMessage(connection, raw, isBinary))
        .catch((error) => this.sendError(connection, "terminal", terminalError(error)));
    });
    socket.on("close", () => this.removeConnection(connection));
    socket.on("error", () => this.removeConnection(connection));
    this.send(connection, { type: "connected" });
  }

  private async handleMessage(
    connection: TerminalConnection,
    raw: RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) throw new Error("binary terminal messages are not supported");
    const input = parseMutation(raw);
    if (!connection.authorization.validateLease(input.leaseId, input.fence)) {
      this.sendError(connection, input.id, "Terminal control lease expired or was superseded");
      this.closeConnection(connection, 4003, "writer lease changed");
      return;
    }

    if (input.type === "spawn") {
      await this.spawn(connection, input);
      return;
    }
    const terminal = connection.terminals.get(input.id);
    if (!terminal) throw new Error("terminal not found");
    if (input.type === "write") {
      if (typeof input.data !== "string" || Buffer.byteLength(input.data) > MAX_INPUT_BYTES) {
        throw new Error("terminal input is too large");
      }
      terminal.write(input.data);
    } else if (input.type === "resize") {
      terminal.resize(clampCols(input.cols), clampRows(input.rows));
    } else {
      connection.terminals.delete(input.id);
      terminal.kill();
    }
  }

  private async spawn(connection: TerminalConnection, input: TerminalMutation): Promise<void> {
    if (!input.workspaceId) throw new Error("workspaceId is required");
    if (
      !connection.terminals.has(input.id) &&
      connection.terminals.size >= MAX_TERMINALS_PER_CONNECTION
    ) {
      throw new Error("terminal connection limit reached");
    }
    const root = await connection.authorization.resolveWorkspace(input.workspaceId);
    connection.terminals.get(input.id)?.kill();

    const shell =
      process.platform === "win32"
        ? process.env.COMSPEC || "cmd.exe"
        : process.env.SHELL || "/bin/sh";
    const terminal = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: clampCols(input.cols),
      rows: clampRows(input.rows),
      cwd: root,
      env: terminalEnvironment(),
    });
    connection.terminals.set(input.id, terminal);
    terminal.onData((data) => {
      if (connection.terminals.get(input.id) !== terminal) return;
      if (connection.socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
        this.closeConnection(connection, 1013, "terminal output backpressure");
        return;
      }
      this.send(connection, { type: "output", id: input.id, data });
    });
    terminal.onExit(({ exitCode }) => {
      if (connection.terminals.get(input.id) !== terminal) return;
      connection.terminals.delete(input.id);
      this.send(connection, { type: "exit", id: input.id, code: exitCode });
    });
    this.send(connection, { type: "ready", id: input.id });
  }

  private sendError(connection: TerminalConnection, id: string, message: string): void {
    this.send(connection, { type: "error", id, message });
  }

  private send(connection: TerminalConnection, payload: Record<string, unknown>): void {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    connection.socket.send(JSON.stringify(payload));
  }

  private closeConnection(connection: TerminalConnection, code: number, reason: string): void {
    this.removeConnection(connection);
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.close(code, reason);
  }

  private removeConnection(connection: TerminalConnection): void {
    const connections = this.connectionsByDevice.get(connection.authorization.deviceId);
    if (!connections?.delete(connection)) return;
    for (const terminal of connection.terminals.values()) terminal.kill();
    connection.terminals.clear();
    if (connections.size === 0) this.connectionsByDevice.delete(connection.authorization.deviceId);
  }
}

function parseMutation(raw: RawData): TerminalMutation {
  const text = Array.isArray(raw)
    ? Buffer.concat(raw).toString("utf8")
    : Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : Buffer.from(raw).toString("utf8");
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES) throw new Error("terminal message is too large");
  const value = JSON.parse(text) as Partial<TerminalMutation>;
  if (!value || !["spawn", "write", "resize", "kill"].includes(value.type ?? "")) {
    throw new Error("invalid terminal message type");
  }
  if (typeof value.id !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(value.id)) {
    throw new Error("invalid terminal id");
  }
  if (typeof value.leaseId !== "string" || !value.leaseId || !Number.isSafeInteger(value.fence)) {
    throw new Error("terminal writer lease is required");
  }
  return value as TerminalMutation;
}

function clampCols(value: number | undefined): number {
  return Number.isFinite(value) ? Math.min(400, Math.max(20, Math.floor(value!))) : 80;
}

function clampRows(value: number | undefined): number {
  return Number.isFinite(value) ? Math.min(200, Math.max(4, Math.floor(value!))) : 24;
}

function terminalEnvironment(): Record<string, string> {
  const environment: Record<string, string> = { TERM: "xterm-256color" };
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      name === "JUPITER_WEB_PROXY_SECRET" ||
      name === "JUPITER_WEB_PROXY_SECRET_FILE"
    ) {
      continue;
    }
    environment[name] = value;
  }
  return environment;
}

function terminalError(error: unknown): string {
  if (error instanceof SyntaxError) return "Invalid terminal message";
  return error instanceof Error ? error.message : String(error);
}
