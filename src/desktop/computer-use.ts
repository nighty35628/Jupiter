import { basename } from "node:path";
import {
  ComputerUseLeaseBusyError,
  ComputerUseRuntime,
  ComputerUseToolAdapter,
  registerComputerUseTools,
  unregisterComputerUseTools,
} from "../computer-use/index.js";
import type { ComputerUseStatus } from "../computer-use/status.js";
import type { ComputerUsePermissionMode } from "../computer-use/types.js";
import type { McpClient } from "../mcp/client.js";
import type { ToolRegistry } from "../tools.js";
import { parseCommandChain } from "../tools/shell-chain.js";
import { tokenizeCommand } from "../tools/shell/parse.js";

export function isNativeAppLaunch(command: string): boolean {
  try {
    const segments = parseCommandChain(command)?.segments ?? [{ argv: tokenizeCommand(command) }];
    return segments.some(({ argv }) => {
      let args = argv;
      if (basename(args[0] ?? "") === "env") {
        args = args.slice(1);
        while (
          args.length &&
          (args[0] === "-i" ||
            args[0] === "--ignore-environment" ||
            /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]!))
        )
          args = args.slice(1);
        if (args[0] === "--") args = args.slice(1);
      }
      return (
        basename(args[0] ?? "") === "open" &&
        args.slice(1).some((arg) => arg === "-a" || arg === "-b" || arg.endsWith(".app"))
      );
    });
  } catch {
    return false;
  }
}

type Surface = Pick<
  ComputerUseToolAdapter,
  "getDesktopState" | "getScreenSize" | "getCursorPosition" | "click" | "move" | "scroll" | "type"
>;
export interface DesktopComputerUsePolicy {
  enabled: boolean;
  surface: string;
  supportsImages: boolean;
  permissionMode: ComputerUsePermissionMode;
}
export interface DesktopComputerUseOptions {
  owner: string;
  workspaceDir: string;
  policy: () => DesktopComputerUsePolicy;
  detectDriver: () => string | undefined;
  onChange?: () => void;
  createRuntime?: (command: string, onDisconnect: (error: Error) => void) => ComputerUseRuntime;
  createAdapter?: (client: McpClient, runtime: ComputerUseRuntime, check: () => void) => Surface;
}

/** One tab's control session. Configuration and tool registration never acquire desktop input. */
export class DesktopComputerUse {
  private runtime: ComputerUseRuntime | null = null;
  private adapter: Surface | null = null;
  private starting: Promise<Surface> | null = null;
  private pausing: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private generation = 0;
  private turn: { id: number; signal: AbortSignal } | null = null;
  private state: ComputerUseStatus["state"] = "idle";
  private reason: string | undefined;
  private busyOwner: string | undefined;
  private readonly permissions: ComputerUseStatus["permissions"] = {
    screen: "unknown",
    input: "unknown",
  };

  constructor(private readonly options: DesktopComputerUseOptions) {}

  status(): ComputerUseStatus {
    const policy = this.options.policy();
    let state = this.state;
    let reason = this.reason;
    if (policy.surface !== "desktop") {
      state = "unsupported-surface";
      reason =
        "Built-in Computer Use controls the local Desktop app only, not a Web visitor's computer.";
    } else if (!policy.enabled) {
      state = "disabled";
      reason = "Computer Use is disabled. Enable it in Settings > Computer Use.";
    } else if (!policy.supportsImages) {
      state = "unsupported-model";
      reason =
        "The effective model/provider does not support screenshots. Select an image-capable model.";
    } else if (!this.options.detectDriver()) {
      state = "driver-missing";
      reason = "Cua Driver was not found. Install it and refresh optional components.";
    }
    return {
      state,
      ...(reason ? { reason } : {}),
      ...(state === "busy" && this.busyOwner ? { owner: this.busyOwner } : {}),
      permissions: { ...this.permissions },
    };
  }

  register(registry: ToolRegistry): void {
    unregisterComputerUseTools(registry);
    const state = this.status().state;
    if (["disabled", "unsupported-surface", "unsupported-model", "driver-missing"].includes(state))
      return;
    const invoke = async (
      method: keyof Surface,
      args: unknown[],
      input = false,
    ): Promise<string> => {
      const turn = this.turn;
      this.checkPolicy();
      const adapter = await this.ensureAdapter();
      if (!turn || this.turn !== turn) throw new Error("Computer Use turn has ended");
      this.checkPolicy();
      const generation = this.generation;
      const runtime = this.runtime;
      const isCurrent = () =>
        this.turn === turn && this.generation === generation && this.runtime === runtime;
      try {
        const result = await (adapter[method] as (...args: unknown[]) => Promise<string>).apply(
          adapter,
          args,
        );
        if (!isCurrent()) return result;
        const data = JSON.parse(result) as {
          error?: string;
          isError?: boolean;
          executionOutcome?: string;
          observationId?: string;
          effect?: string;
        };
        if (data.isError || data.executionOutcome || data.error)
          this.markFault(data.error ?? result);
        else {
          this.state = "ready";
          this.reason = undefined;
          if (method === "getDesktopState" && data.observationId)
            this.permissions.screen = "verified";
          if (input && data.effect !== "unverifiable") this.permissions.input = "verified";
          this.options.onChange?.();
        }
        return result;
      } catch (error) {
        if (isCurrent()) this.markFault(error);
        throw error;
      }
    };
    registerComputerUseTools(registry, {
      getDesktopState: (signal, reportImage) => invoke("getDesktopState", [signal, reportImage]),
      getScreenSize: (signal) => invoke("getScreenSize", [signal]),
      getCursorPosition: (signal) => invoke("getCursorPosition", [signal]),
      click: (args, signal) => invoke("click", [args, signal], true),
      move: (args, signal) => invoke("move", [args, signal], true),
      scroll: (args, signal) => invoke("scroll", [args, signal], true),
      type: (args, signal) => invoke("type", [args, signal], true),
    });
  }

  beginTurn(signal: AbortSignal): number {
    if (this.turn) throw new Error("Computer Use turn is already active");
    const id = ++this.generation;
    this.turn = { id, signal };
    return id;
  }

  async endTurn(id: number): Promise<void> {
    if (this.turn?.id !== id) return;
    await this.stop();
  }

  pauseForApproval(): Promise<void> {
    if (!this.turn || !this.runtime) return Promise.resolve();
    if (this.pausing) return this.pausing;
    const turn = this.turn;
    const stopping = this.stop();
    this.turn = turn;
    const operation = stopping.finally(() => {
      if (this.pausing === operation) this.pausing = null;
    });
    this.pausing = operation;
    return operation;
  }

  async prepareNativeLaunch(): Promise<void> {
    await this.ensureAdapter();
    this.checkPolicy();
    this.runtime?.controller.invalidateObservation();
  }

  async stop(): Promise<void> {
    this.generation++;
    this.turn = null;
    this.adapter = null;
    if (this.stopping) return this.stopping;
    const runtime = this.runtime;
    // Keep the runtime visible until stop confirms that the old process cannot input.
    const operation = (async () => {
      try {
        await runtime?.stop();
        if (this.runtime === runtime) {
          this.runtime = null;
          if (this.state !== "fault" && this.state !== "busy") {
            this.state = "idle";
            this.reason = undefined;
          }
        }
      } catch (error) {
        this.markFault(error);
        throw error;
      } finally {
        this.options.onChange?.();
      }
    })();
    this.stopping = operation;
    try {
      await operation;
    } finally {
      if (this.stopping === operation) this.stopping = null;
    }
  }

  private checkPolicy(): void {
    const policy = this.options.policy();
    if (policy.surface !== "desktop")
      throw new Error("Built-in Computer Use is unavailable on this surface");
    if (!policy.enabled) throw new Error("Computer Use is disabled");
    if (!policy.supportsImages)
      throw new Error("Computer Use requires an image-capable model/provider");
    if (!this.turn) throw new Error("Computer Use is available only during an Agent turn");
    this.turn.signal.throwIfAborted();
  }

  private async ensureAdapter(): Promise<Surface> {
    await this.pausing;
    await this.stopping;
    this.checkPolicy();
    if (this.adapter && this.runtime?.driver.running) return this.adapter;
    if (this.starting) return this.starting;
    if (this.runtime) {
      const previous = this.runtime;
      try {
        await previous.stop();
      } catch (error) {
        this.markFault(error);
        throw error;
      }
      if (this.runtime === previous) this.runtime = null;
      this.checkPolicy();
      if (this.starting) return this.starting;
    }
    const command = this.options.detectDriver();
    if (!command) throw new Error("Cua Driver was not found");
    const turn = this.turn!;
    const generation = this.generation;
    this.state = "starting";
    this.reason = undefined;
    this.busyOwner = undefined;
    this.options.onChange?.();
    const runtime =
      this.options.createRuntime?.(command, (error) => {
        if (this.runtime === runtime) this.markFault(error);
      }) ??
      new ComputerUseRuntime({
        command,
        workspaceDir: this.options.workspaceDir,
        onDisconnect: (error) => {
          if (this.runtime === runtime) this.markFault(error);
        },
      });
    this.runtime = runtime;
    const operation = (async () => {
      try {
        const client = await runtime.start(
          `${process.pid}:${this.options.owner}:${turn.id}`,
          turn.signal,
        );
        if (this.turn !== turn || this.generation !== generation)
          throw new Error("Computer Use initialization was cancelled");
        this.checkPolicy();
        const adapter =
          this.options.createAdapter?.(client, runtime, () => this.checkPolicy()) ??
          new ComputerUseToolAdapter(
            client,
            runtime.controller,
            () => this.options.policy().permissionMode,
            () => this.checkPolicy(),
          );
        this.adapter = adapter;
        this.state = "ready";
        this.options.onChange?.();
        return adapter;
      } catch (error) {
        await runtime.stop();
        if (this.runtime === runtime) this.runtime = null;
        if (this.turn !== turn || this.generation !== generation) throw error;
        if (error instanceof ComputerUseLeaseBusyError) {
          this.state = "busy";
          this.busyOwner = error.owner;
          this.reason = error.message;
        } else this.markFault(error);
        this.options.onChange?.();
        throw error;
      }
    })();
    this.starting = operation;
    void operation
      .finally(() => {
        if (this.starting === operation) this.starting = null;
      })
      .catch(() => undefined);
    return operation;
  }

  private markFault(error: unknown): void {
    this.state = "fault";
    this.reason = error instanceof Error ? error.message : String(error);
    this.permissions.screen = "unknown";
    this.permissions.input = "unknown";
    if (/screen recording.*(?:denied|permission)|screen.*permission denied/i.test(this.reason))
      this.permissions.screen = "denied";
    if (/accessibility.*(?:denied|permission)|input.*permission denied/i.test(this.reason))
      this.permissions.input = "denied";
    this.options.onChange?.();
  }
}
