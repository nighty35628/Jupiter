export interface OperationResult<T> {
  duplicate: boolean;
  value: T;
}

interface StoredOperation<T> {
  createdAt: number;
  promise: Promise<T>;
}

/** Reserves an operation id before side effects begin, closing concurrent retry races. */
export class OperationJournal {
  private readonly operations = new Map<string, StoredOperation<unknown>>();

  constructor(private readonly capacity = 4096) {}

  async run<T>(id: string, operation: () => Promise<T>): Promise<OperationResult<T>> {
    const existing = this.operations.get(id) as StoredOperation<T> | undefined;
    if (existing) return { duplicate: true, value: await existing.promise };

    const promise = operation();
    this.operations.set(id, { createdAt: Date.now(), promise });
    this.trim();
    // The retained promise makes deterministic failures replayable during this process lifetime.
    return { duplicate: false, value: await promise };
  }

  private trim(): void {
    while (this.operations.size > this.capacity) {
      const oldest = this.operations.keys().next().value;
      if (typeof oldest !== "string") return;
      this.operations.delete(oldest);
    }
  }
}
