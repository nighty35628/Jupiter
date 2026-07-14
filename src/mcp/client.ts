import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { VERSION } from "../version.js";
import type { McpTransport } from "./stdio.js";
import {
  type CallToolParams,
  type CallToolResult,
  type GetPromptParams,
  type GetPromptResult,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ListPromptsParams,
  type ListPromptsResult,
  type ListResourcesParams,
  type ListResourcesResult,
  type ListToolsParams,
  type ListToolsResult,
  MCP_PROTOCOL_VERSION,
  type McpClientInfo,
  type McpProgressHandler,
  type McpRoot,
  type McpTool,
  type ProgressNotificationParams,
  type ReadResourceParams,
  type ReadResourceResult,
  isJsonRpcError,
} from "./types.js";

export interface McpClientOptions {
  transport: McpTransport;
  clientInfo?: McpClientInfo;
  workspaceDir?: string;
  /** Per-request timeout. Default 60s. */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

export const DEFAULT_MAX_TOOL_LIST_PAGES = 100;
export const DEFAULT_MAX_LISTED_TOOLS = 10_000;

export interface ListAllToolsOptions {
  signal?: AbortSignal;
  maxPages?: number;
  maxTools?: number;
}

function positiveIntegerOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`MCP tools/list ${name} must be a positive integer`);
  }
  return resolved;
}

export class McpClient {
  private readonly transport: McpTransport;
  private readonly clientInfo: McpClientInfo;
  private readonly workspaceDir: string | undefined;
  private readonly workspaceRoot: McpRoot | undefined;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private readerStarted = false;
  private initialized = false;
  private _serverCapabilities: InitializeResult["capabilities"] = {};
  private _serverInfo: InitializeResult["serverInfo"] = { name: "", version: "" };
  private _protocolVersion = "";
  private _instructions: string | undefined;
  // Progress-token → handler for notifications/progress routing. Tokens
  // are minted per call when the caller supplies an onProgress
  // callback; cleared when the final response lands (or the pending
  // request rejects). No leaks — the `try/finally` in callTool
  // guarantees cleanup even on timeout.
  private readonly progressHandlers = new Map<string | number, McpProgressHandler>();
  private nextProgressToken = 1;

  constructor(opts: McpClientOptions) {
    this.transport = opts.transport;
    this.clientInfo = opts.clientInfo ?? { name: "jupiter", version: VERSION };
    const workspaceDir = opts.workspaceDir?.trim();
    if (workspaceDir) {
      this.workspaceDir = resolve(workspaceDir);
      this.workspaceRoot = {
        uri: pathToFileURL(this.workspaceDir).href,
        name: basename(this.workspaceDir) || this.workspaceDir,
      };
    }
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
  }

  /** Server's advertised capabilities, available after initialize(). */
  get serverCapabilities(): InitializeResult["capabilities"] {
    return this._serverCapabilities;
  }

  /** Server's self-reported name + version, available after initialize(). */
  get serverInfo(): InitializeResult["serverInfo"] {
    return this._serverInfo;
  }

  /** Protocol version the server agreed to during the handshake. */
  get protocolVersion(): string {
    return this._protocolVersion;
  }

  /** Optional free-form instructions the server provides at handshake. */
  get serverInstructions(): string | undefined {
    return this._instructions;
  }

  get workspaceRootDir(): string | undefined {
    return this.workspaceDir;
  }

  /** Compliant servers reject other methods until this completes. */
  async initialize(opts: { signal?: AbortSignal } = {}): Promise<InitializeResult> {
    if (this.initialized) throw new Error("MCP client already initialized");
    this.startReaderIfNeeded();
    const capabilities: InitializeParams["capabilities"] = {
      tools: {},
      resources: {},
      prompts: {},
      ...(this.workspaceRoot ? { roots: {} } : {}),
    };
    const params: InitializeParams = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities,
      clientInfo: this.clientInfo,
    };
    const result = await this.request<InitializeResult>("initialize", params, opts.signal);
    this._serverCapabilities = result.capabilities ?? {};
    this._serverInfo = result.serverInfo ?? { name: "", version: "" };
    this._protocolVersion = result.protocolVersion ?? "";
    this._instructions = result.instructions;
    // Per spec: client sends notifications/initialized after receiving the
    // initialize response. Only then is the connection live for other
    // methods.
    await this.transport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    this.initialized = true;
    return result;
  }

  /** List one page of tools the server exposes. Cursors are opaque, including an empty string. */
  async listTools(cursor?: string, opts: { signal?: AbortSignal } = {}): Promise<ListToolsResult> {
    this.assertInitialized();
    return this.request<ListToolsResult>(
      "tools/list",
      {
        ...(cursor !== undefined ? { cursor } : {}),
      } satisfies ListToolsParams,
      opts.signal,
    );
  }

  /** Collect a complete tools/list catalog before exposing any tools to callers. */
  async listAllTools(opts: ListAllToolsOptions = {}): Promise<McpTool[]> {
    this.assertInitialized();
    const maxPages = positiveIntegerOption(opts.maxPages, DEFAULT_MAX_TOOL_LIST_PAGES, "maxPages");
    const maxTools = positiveIntegerOption(opts.maxTools, DEFAULT_MAX_LISTED_TOOLS, "maxTools");
    const tools: McpTool[] = [];
    const seenNames = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    while (true) {
      if (opts.signal?.aborted) throw new Error("MCP tools/list pagination aborted by user");
      if (pages >= maxPages) {
        throw new Error(`MCP tools/list exceeded the ${maxPages}-page limit`);
      }

      const result = await this.listTools(cursor, { signal: opts.signal });
      pages++;
      if (!result || !Array.isArray(result.tools)) {
        throw new Error("MCP tools/list returned a non-array tools field");
      }

      for (const tool of result.tools) {
        if (!tool || typeof tool.name !== "string" || tool.name.length === 0) {
          throw new Error("MCP tools/list returned a tool with an empty name");
        }
        if (seenNames.has(tool.name)) {
          throw new Error(`MCP tools/list returned duplicate tool name: ${tool.name}`);
        }
        if (tools.length >= maxTools) {
          throw new Error(`MCP tools/list exceeded the ${maxTools}-tool limit`);
        }
        seenNames.add(tool.name);
        tools.push(tool);
      }

      const nextCursor = result.nextCursor;
      if (nextCursor === undefined) return tools;
      if (typeof nextCursor !== "string") {
        throw new Error("MCP tools/list returned a non-string nextCursor");
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error(`MCP tools/list returned a repeated cursor: ${JSON.stringify(nextCursor)}`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  /** Abort sends `notifications/cancelled` and rejects immediately; late server responses are dropped. */
  async callTool(
    name: string,
    args?: Record<string, unknown>,
    opts: { onProgress?: McpProgressHandler; signal?: AbortSignal } = {},
  ): Promise<CallToolResult> {
    this.assertInitialized();
    const params: CallToolParams = { name, arguments: args ?? {} };
    let token: number | undefined;
    if (opts.onProgress) {
      token = this.nextProgressToken++;
      this.progressHandlers.set(token, opts.onProgress);
      params._meta = { progressToken: token };
    }
    try {
      return await this.request<CallToolResult>("tools/call", params, opts.signal);
    } finally {
      if (token !== undefined) this.progressHandlers.delete(token);
    }
  }

  /** Throws on method-not-found; callers should gate on `serverCapabilities.resources` first. */
  async listResources(cursor?: string): Promise<ListResourcesResult> {
    this.assertInitialized();
    return this.request<ListResourcesResult>("resources/list", {
      ...(cursor ? { cursor } : {}),
    } satisfies ListResourcesParams);
  }

  /** Read the contents of a resource by URI. */
  async readResource(uri: string): Promise<ReadResourceResult> {
    this.assertInitialized();
    return this.request<ReadResourceResult>("resources/read", {
      uri,
    } satisfies ReadResourceParams);
  }

  /** List prompt templates the server exposes. */
  async listPrompts(cursor?: string): Promise<ListPromptsResult> {
    this.assertInitialized();
    return this.request<ListPromptsResult>("prompts/list", {
      ...(cursor ? { cursor } : {}),
    } satisfies ListPromptsParams);
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    this.assertInitialized();
    return this.request<GetPromptResult>("prompts/get", {
      name,
      ...(args ? { arguments: args } : {}),
    } satisfies GetPromptParams);
  }

  /** Close the transport and reject any outstanding requests. */
  async close(): Promise<void> {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("MCP client closed"));
    }
    this.pending.clear();
    await this.transport.close();
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("MCP client not initialized — call initialize() first");
  }

  private async request<R>(method: string, params: unknown, signal?: AbortSignal): Promise<R> {
    const id = this.nextId++;
    const frame: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    let abortHandler: (() => void) | null = null;
    const promise = new Promise<R>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
        reject(
          new Error(`MCP request ${method} (id=${id}) timed out after ${this.requestTimeoutMs}ms`),
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
      // Wire up cancellation: when signal fires, send an MCP cancellation
      // notification to the server (so it can stop whatever it was doing)
      // and reject the caller immediately — no need to wait for the
      // subprocess to finish its in-flight work. Late responses from the
      // server are dropped by `dispatch` because the id is gone from
      // `pending`.
      if (signal) {
        if (signal.aborted) {
          this.pending.delete(id);
          clearTimeout(timeout);
          reject(new Error(`MCP request ${method} (id=${id}) aborted before send`));
          return;
        }
        abortHandler = () => {
          this.pending.delete(id);
          clearTimeout(timeout);
          void this.transport
            .send({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: id, reason: "aborted by user" },
            })
            .catch(() => {
              // Transport may already be closing — swallow; we still
              // reject the caller below so they unblock.
            });
          reject(new Error(`MCP request ${method} (id=${id}) aborted by user`));
        };
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
    promise.catch(() => undefined);
    // Swallow rejection on the race-leg derivative too — if `send` wins the race,
    // a late-rejecting `promise.then(...)` would otherwise be orphaned (#742).
    const promiseSettled = promise.then(
      () => undefined,
      () => undefined,
    );
    try {
      await Promise.race([this.transport.send(frame), promiseSettled]);
    } catch (err) {
      const pending = this.pending.get(id);
      if (pending) clearTimeout(pending.timeout);
      this.pending.delete(id);
      if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
      throw err;
    }
    try {
      return await promise;
    } finally {
      if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
    }
  }

  private startReaderIfNeeded(): void {
    if (this.readerStarted) return;
    this.readerStarted = true;
    // Fire-and-forget: the reader runs for the lifetime of the client.
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const msg of this.transport.messages()) {
        this.dispatch(msg);
      }
    } catch (err) {
      // Surface as rejections on all pending requests so nobody hangs.
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(err as Error);
      }
      this.pending.clear();
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    // Notifications (no `id`): route by method. Progress notifications
    // go to the per-call handler if one was registered; everything
    // else is dropped silently (we don't yet handle tools/list_changed
    // or resources/list_changed).
    if (!("id" in msg) || msg.id === null || msg.id === undefined) {
      if ("method" in msg && msg.method === "notifications/progress") {
        const p = msg.params as ProgressNotificationParams | undefined;
        if (!p || p.progressToken === undefined) return;
        const handler = this.progressHandlers.get(p.progressToken);
        if (!handler) return; // late notification after the call resolved
        handler({ progress: p.progress, total: p.total, message: p.message });
      }
      return;
    }
    if (!("result" in msg) && !("error" in msg)) {
      this.handleServerRequest(msg as JsonRpcRequest);
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return; // late response after timeout; drop
    this.pending.delete(msg.id);
    clearTimeout(pending.timeout);
    const resp = msg as JsonRpcResponse;
    if (isJsonRpcError(resp)) {
      pending.reject(new Error(`MCP ${resp.error.code}: ${resp.error.message}`));
    } else {
      pending.resolve(resp.result);
    }
  }

  private handleServerRequest(req: JsonRpcRequest): void {
    if (req.method === "roots/list" && this.workspaceRoot) {
      void this.transport
        .send({
          jsonrpc: "2.0",
          id: req.id,
          result: { roots: [this.workspaceRoot] },
        })
        .catch(() => undefined);
      return;
    }
    void this.transport
      .send({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `method not found: ${req.method}` },
      })
      .catch(() => undefined);
  }
}
