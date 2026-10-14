import { McpClient } from "../mcp/client.js";
import { StdioTransport } from "../mcp/stdio.js";
import { ComputerUseController } from "./controller.js";
import { ComputerUseLease } from "./lease.js";

export type ComputerUseRuntimeState = "stopped" | "starting" | "running" | "stopping" | "fault";

export interface ComputerUseDriverProcessOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  requestTimeoutMs?: number;
  workspaceDir?: string;
  shutdownTimeoutMs?: number;
  killTimeoutMs?: number;
  onDisconnect?: (error: Error) => void;
  onStateChange?: (state: ComputerUseRuntimeState, error?: Error) => void;
}

export class ComputerUseDriverUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerUseDriverUnavailableError";
  }
}

/** Owns the Cua Driver child process; the model never gets to choose its executable or mode. */
export class ComputerUseDriverProcess {
  private readonly options: Required<Pick<ComputerUseDriverProcessOptions, "command" | "args">> &
    Omit<ComputerUseDriverProcessOptions, "command" | "args">;
  private _client: McpClient | undefined;
  private starting: Promise<McpClient> | undefined;
  private closing: Promise<void> | undefined;
  private abort: AbortController | undefined;

  constructor(options: ComputerUseDriverProcessOptions = {}) {
    this.options = {
      ...options,
      command: options.command ?? "cua-driver",
      args: options.args ?? ["mcp"],
      cwd: options.cwd,
      requestTimeoutMs: options.requestTimeoutMs,
      workspaceDir: options.workspaceDir,
    };
  }

  get client(): McpClient {
    if (!this.running) throw new Error("Cua Driver is not running");
    return this._client!;
  }

  get running(): boolean {
    return !this.closing && (this._client?.connected ?? false);
  }

  async start(signal?: AbortSignal): Promise<McpClient> {
    signal?.throwIfAborted();
    if (this.closing) throw new Error("Cua Driver is stopping");
    if (this.starting) throw new Error("Cua Driver is already starting");
    if (this.running) return this._client!;
    if (this._client) throw new Error("Cua Driver requires confirmed shutdown before restarting");
    const abort = new AbortController();
    this.abort = abort;
    const cancel = () => abort.abort(signal?.reason);
    const transport = new StdioTransport({
      command: this.options.command,
      args: this.options.args,
      cwd: this.options.cwd,
      shell: false,
      shutdownTimeoutMs: this.options.shutdownTimeoutMs,
      killTimeoutMs: this.options.killTimeoutMs,
    });
    const client = new McpClient({
      transport,
      workspaceDir: this.options.workspaceDir,
      requestTimeoutMs: this.options.requestTimeoutMs,
      onDisconnect: this.options.onDisconnect,
      clientInfo: { name: "jupiter-computer-use", version: "1.0" },
    });
    // Retain the child during initialization so stop can terminate it.
    this._client = client;
    signal?.addEventListener("abort", cancel, { once: true });
    const task = (async () => {
      try {
        await client.initialize({ signal: abort.signal });
        abort.signal.throwIfAborted();
        if (!client.connected) throw new Error("Cua Driver disconnected during startup");
        return client;
      } catch (error) {
        // Local cancellation is not proof of exit. Propagate cleanup failures.
        await client.close();
        if (this._client === client) this._client = undefined;
        const message = error instanceof Error ? error.message : String(error);
        throw new ComputerUseDriverUnavailableError(
          `Unable to start Cua Driver using ${this.options.command}: ${message}`,
        );
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    })();
    this.starting = task;
    try {
      return await task;
    } finally {
      if (this.starting === task) this.starting = undefined;
    }
  }

  close(): Promise<void> {
    this.abort?.abort();
    if (this.closing) return this.closing;
    const client = this._client;
    const starting = this.starting;
    const task = (async () => {
      await client?.close();
      await starting?.catch(() => undefined);
      if (this._client === client) this._client = undefined;
    })();
    this.closing = task;
    void task
      .finally(() => {
        if (this.closing === task) this.closing = undefined;
      })
      .catch(() => undefined);
    return task;
  }
}

export class ComputerUseRuntime {
  private heartbeat: ReturnType<typeof setTimeout> | undefined;
  private stopping = true;
  private generation = 0;
  private starting: Promise<McpClient> | undefined;
  private closing: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private removeAbortListener: (() => void) | undefined;
  private _state: ComputerUseRuntimeState = "stopped";
  private shutdownError: Error | undefined;
  private _fault: Error | undefined;
  readonly controller: ComputerUseController;
  readonly driver: ComputerUseDriverProcess;

  constructor(
    private readonly options: ComputerUseDriverProcessOptions = {},
    controller = new ComputerUseController(new ComputerUseLease()),
  ) {
    this.controller = controller;
    controller.onRemoteInputUncertain((error) => this.handleFault(error));
    this.driver = new ComputerUseDriverProcess({
      ...options,
      onDisconnect: (error) => this.handleFault(error),
    });
  }

  get state(): ComputerUseRuntimeState {
    return this._state;
  }

  get fault(): Error | undefined {
    return this._fault;
  }

  async start(owner: string, signal?: AbortSignal): Promise<McpClient> {
    signal?.throwIfAborted();
    if (this.starting || this.closing || this._state !== "stopped")
      throw new Error("Computer Use runtime is already active or stopping");
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.stopping = false;
    const cancel = () => {
      void this.stop().catch((error: unknown) => this.notifyCleanupFailure(error));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    this.removeAbortListener = () => signal?.removeEventListener("abort", cancel);
    const assertCurrent = () => {
      abort.signal.throwIfAborted();
      signal?.throwIfAborted();
      if (generation !== this.generation || this.stopping)
        throw new Error("Computer Use startup was cancelled");
    };
    const task = (async () => {
      let acquired = false;
      try {
        await this.controller.start(owner);
        acquired = true;
        assertCurrent();
        const client = await this.driver.start(abort.signal);
        assertCurrent();
        this.setState("running");
        assertCurrent();
        this.scheduleHeartbeat();
        return client;
      } catch (error) {
        if (generation === this.generation) {
          this.stopping = true;
          if (acquired) this.controller.suspend();
          this.removeAbortListener?.();
        }
        try {
          if (acquired) {
            await this.driver.close();
            this.controller.assertRemoteQuiescent();
            await this.controller.stop();
          }
        } catch (cleanupError) {
          this.setState("fault", asError(cleanupError));
          throw cleanupError;
        }
        if (generation === this.generation) this.setState("stopped", asError(error));
        throw error;
      }
    })();
    this.starting = task;
    this.setState("starting");
    try {
      return await task;
    } finally {
      if (this.starting === task) this.starting = undefined;
    }
  }

  stop(): Promise<void> {
    return this.shutdown();
  }

  private shutdown(error?: Error): Promise<void> {
    this.shutdownError = error;
    this.stopping = true;
    ++this.generation;
    clearTimeout(this.heartbeat);
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    this.controller.suspend();
    this.abort?.abort();
    if (this.closing) return this.closing;
    const starting = this.starting;
    const task = (async () => {
      try {
        await this.driver.close();
        await starting?.catch(() => undefined);
        await this.driver.close();
        this.controller.assertRemoteQuiescent();
        await this.controller.stop();
        this.setState(this.shutdownError ? "fault" : "stopped", this.shutdownError);
      } catch (error) {
        this.setState("fault", asError(error));
        throw error;
      }
    })();
    this.closing = task;
    this.setState(error ? "fault" : "stopping", error);
    void task
      .finally(() => {
        if (this.closing === task) this.closing = undefined;
      })
      .catch(() => undefined);
    return task;
  }

  private handleFault(error: Error): void {
    if (this.stopping) return;
    const cleanup = this.shutdown(error);
    try {
      this.options.onDisconnect?.(error);
    } catch {
      /* notification only */
    }
    void cleanup.catch((failure: unknown) => this.notifyCleanupFailure(failure));
  }

  private notifyCleanupFailure(error: unknown): void {
    this.setState("fault", asError(error));
  }

  private setState(state: ComputerUseRuntimeState, error?: Error): void {
    this._state = state;
    this._fault = state === "fault" ? error : undefined;
    try {
      this.options.onStateChange?.(state, error);
    } catch {
      /* notification only */
    }
  }

  private scheduleHeartbeat(): void {
    if (this.stopping) return;
    const generation = this.generation;
    this.heartbeat = setTimeout(async () => {
      if (this.stopping || generation !== this.generation) return;
      try {
        await this.controller.renew();
        if (generation === this.generation) this.scheduleHeartbeat();
      } catch (error) {
        if (generation === this.generation) this.handleFault(asError(error));
      }
    }, 10_000);
    this.heartbeat.unref();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
