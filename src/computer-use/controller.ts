import { ComputerUseLease, type ComputerUseLeaseHandle } from "./lease.js";
import {
  type ComputerUseAction,
  type ComputerUseFence,
  type ComputerUseObservation,
  mapObservationPoint,
  newObservationId,
} from "./types.js";

export class ComputerUseStaleActionError extends Error {
  readonly executionOutcome = "unknown_after_cancel" as const;

  constructor(message: string) {
    super(message);
    this.name = "ComputerUseStaleActionError";
  }
}

export class ComputerUseRemoteInputUnsettledError extends Error {
  readonly manualRecoveryRequired = true;
  readonly leaseRetained = true;

  constructor(
    readonly pendingInputs: number,
    readonly unknownInputs: number,
  ) {
    super(
      `Computer Use retains its desktop lease: ${pendingInputs} pending and ${unknownInputs} unknown remote input request(s). Proxy exit does not prove shared-daemon input has stopped; manual recovery required: verify this owner's remote input has settled before removing its retained lock; do not retry input or kill the shared daemon.`,
    );
    this.name = "ComputerUseRemoteInputUnsettledError";
  }
}

export class ComputerUseController {
  private readonly lease: ComputerUseLease;
  private handle: ComputerUseLeaseHandle | undefined;
  private epoch = 0;
  private observation: ComputerUseObservation | undefined;
  private enabled = false;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private readonly remoteInputs = new Map<symbol, "pending" | "unknown">();
  private readonly remoteInputListeners = new Set<
    (error: ComputerUseRemoteInputUnsettledError) => void
  >();

  constructor(lease = new ComputerUseLease()) {
    this.lease = lease;
  }

  get active(): boolean {
    return this.enabled && this.handle !== undefined;
  }

  get remoteQuiescent(): boolean {
    return this.remoteInputs.size === 0;
  }

  get remoteInputStatus(): { pending: number; unknown: number } {
    let unknown = 0;
    for (const state of this.remoteInputs.values()) if (state === "unknown") unknown++;
    return { pending: this.remoteInputs.size - unknown, unknown };
  }

  get remoteInputFault(): ComputerUseRemoteInputUnsettledError | undefined {
    const { pending, unknown } = this.remoteInputStatus;
    return unknown > 0 ? new ComputerUseRemoteInputUnsettledError(pending, unknown) : undefined;
  }

  assertRemoteQuiescent(): void {
    if (this.remoteQuiescent) return;
    const { pending, unknown } = this.remoteInputStatus;
    throw new ComputerUseRemoteInputUnsettledError(pending, unknown);
  }

  onRemoteInputUncertain(
    listener: (error: ComputerUseRemoteInputUnsettledError) => void,
  ): () => void {
    this.remoteInputListeners.add(listener);
    return () => {
      this.remoteInputListeners.delete(listener);
    };
  }

  /** Track only dispatched input, never observations or pre-send policy rejections. */
  beginRemoteInput(fence: ComputerUseFence): { acknowledge(): void; markUnknown(): void } {
    this.assertFence(fence);
    const token = Symbol("remote-input");
    this.remoteInputs.set(token, "pending");
    return {
      acknowledge: () => {
        this.remoteInputs.delete(token);
      },
      markUnknown: () => {
        if (!this.remoteInputs.has(token) || this.remoteInputs.get(token) === "unknown") return;
        this.remoteInputs.set(token, "unknown");
        this.suspend();
        const error = this.remoteInputFault!;
        for (const listener of this.remoteInputListeners) {
          try {
            listener(error);
          } catch {
            /* observers cannot clear unsettled input */
          }
        }
      },
    };
  }

  async start(owner: string): Promise<void> {
    if (this.handle || this.starting || this.stopping)
      throw new Error("Computer Use session is already active or changing ownership");
    this.assertRemoteQuiescent();
    const epoch = ++this.epoch;
    const task = (async () => {
      const handle = await this.lease.acquire(owner);
      if (this.epoch !== epoch) {
        await handle.release();
        throw new Error("Computer Use startup was cancelled");
      }
      this.handle = handle;
      this.enabled = true;
      this.observation = undefined;
    })();
    this.starting = task;
    try {
      await task;
    } finally {
      if (this.starting === task) this.starting = undefined;
    }
  }

  /** Disable actions immediately while retaining ownership until the driver exits. */
  suspend(): void {
    this.enabled = false;
    this.epoch++;
    this.observation = undefined;
  }

  /** Primitive lease release; production Runtime must first assert remote quiescence. */
  stop(): Promise<void> {
    this.suspend();
    if (this.stopping) return this.stopping;
    const task = (async () => {
      await this.starting?.catch(() => undefined);
      const handle = this.handle;
      await handle?.release();
      if (this.handle === handle) this.handle = undefined;
    })();
    this.stopping = task;
    void task
      .finally(() => {
        if (this.stopping === task) this.stopping = undefined;
      })
      .catch(() => undefined);
    return task;
  }

  async renew(): Promise<void> {
    if (!this.active) throw new Error("Computer Use session is not active");
    const handle = this.handle!;
    const fence = this.fence();
    try {
      await handle.renew();
      this.assertFence(fence);
    } catch (error) {
      if (this.handle === handle && this.epoch === fence.epoch) this.suspend();
      throw error;
    }
  }

  invalidateObservation(): void {
    this.observation = undefined;
  }

  recordObservation(input: Omit<ComputerUseObservation, "id" | "epoch">): ComputerUseObservation {
    if (!this.active) throw new Error("Computer Use session is not active");
    const observation = { ...input, id: newObservationId(), epoch: this.epoch };
    this.observation = observation;
    return observation;
  }

  fence(): ComputerUseFence {
    const remoteFault = this.remoteInputFault;
    if (remoteFault) throw remoteFault;
    if (!this.active) throw new Error("Computer Use session is not active");
    return { owner: this.handle!.owner, epoch: this.epoch, leaseToken: this.handle!.token };
  }

  prepareAction(action: ComputerUseAction, fence: ComputerUseFence): ComputerUseAction {
    this.assertFence(fence);
    if (!this.observation || action.observationId !== this.observation.id) {
      throw new ComputerUseStaleActionError("The action refers to an old screen observation");
    }
    const observation = this.observation;
    this.observation = undefined;
    if (Date.now() - observation.capturedAt > 60_000) {
      throw new ComputerUseStaleActionError("The screen observation expired; capture again");
    }
    if (action.type === "type") return action;
    const point = mapObservationPoint(observation, { x: action.x, y: action.y });
    return { ...action, x: point.x, y: point.y };
  }

  assertFence(fence: ComputerUseFence): void {
    if (!this.active || this.epoch !== fence.epoch || this.handle!.token !== fence.leaseToken) {
      throw new ComputerUseStaleActionError("Computer Use control was stopped or handed off");
    }
  }
}
