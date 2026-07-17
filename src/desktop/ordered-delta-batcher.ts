export interface OrderedWireEvent {
  type: string;
  tabId?: string;
  turn?: number;
  channel?: string;
  text?: string;
  batchCount?: number;
  [key: string]: unknown;
}

export interface OrderedDeltaBatcherOptions {
  delayMs?: number;
  maxChars?: number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Coalesces only adjacent compatible deltas. Every non-delta event is a FIFO barrier. */
export class OrderedDeltaBatcher<T extends OrderedWireEvent> {
  private pending: T | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly delayMs: number;
  private readonly maxChars: number;
  private readonly schedule: NonNullable<OrderedDeltaBatcherOptions["schedule"]>;
  private readonly cancel: NonNullable<OrderedDeltaBatcherOptions["cancel"]>;

  constructor(
    private readonly write: (event: T) => void,
    opts: OrderedDeltaBatcherOptions = {},
  ) {
    this.delayMs = opts.delayMs ?? 24;
    this.maxChars = opts.maxChars ?? 32 * 1024;
    this.schedule = opts.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancel = opts.cancel ?? ((timer) => clearTimeout(timer));
  }

  push(event: T): void {
    if (event.type !== "model.delta" || typeof event.text !== "string") {
      this.flush();
      this.write(event);
      return;
    }
    if (this.pending && this.compatible(this.pending, event)) {
      const combined = `${this.pending.text ?? ""}${event.text}`;
      if (combined.length <= this.maxChars) {
        this.pending = {
          ...this.pending,
          text: combined,
          batchCount: (this.pending.batchCount ?? 1) + (event.batchCount ?? 1),
        };
        return;
      }
      this.flush();
    } else if (this.pending) {
      this.flush();
    }
    this.pending = event;
    this.arm();
  }

  flush(): void {
    if (this.timer) {
      this.cancel(this.timer);
      this.timer = null;
    }
    const pending = this.pending;
    this.pending = null;
    if (pending) this.write(pending);
  }

  private compatible(left: T, right: T): boolean {
    return left.tabId === right.tabId && left.turn === right.turn && left.channel === right.channel;
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      const pending = this.pending;
      this.pending = null;
      if (pending) this.write(pending);
    }, this.delayMs);
    this.timer.unref?.();
  }
}
