import { randomUUID } from "node:crypto";

export interface PredictionIdentity {
  sessionId: string;
  bindingId: number;
  revision: number;
  providerId: string;
  model: string;
}

export function predictionTurnSucceeded(result: {
  done: boolean;
  failed: boolean;
  aborted: boolean;
  forced: boolean;
  text: string;
}): boolean {
  return result.done && !result.failed && !result.aborted && !result.forced && !!result.text.trim();
}

function sameIdentity(left: PredictionIdentity, right: PredictionIdentity): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.bindingId === right.bindingId &&
    left.revision === right.revision &&
    left.providerId === right.providerId &&
    left.model === right.model
  );
}

/** One live completion slot; version changes invalidate results, never reopen attempts. */
export class PromptPredictionState {
  private identity?: PredictionIdentity;
  private controller?: AbortController;
  private attempted = false;
  private settled = false;
  private valid = false;
  private text: string | null = null;
  completionId?: string;

  offer(identity: PredictionIdentity): string {
    this.invalidate();
    this.identity = { ...identity };
    this.completionId = randomUUID();
    this.attempted = false;
    this.settled = false;
    this.valid = true;
    this.text = null;
    return this.completionId;
  }

  invalidate(id?: string): void {
    if (id !== undefined && id !== this.completionId) return;
    this.valid = false;
    this.controller?.abort();
  }

  current(identity: PredictionIdentity): string | null {
    if (!this.valid || !this.identity || !sameIdentity(this.identity, identity)) return null;
    return this.completionId ?? null;
  }

  replay(identity: PredictionIdentity): string | null {
    return this.attempted ? this.current(identity) : null;
  }

  claim(
    id: string,
    identity: PredictionIdentity,
  ):
    | { kind: "start"; signal: AbortSignal }
    | { kind: "pending" }
    | { kind: "cached"; text: string | null }
    | null {
    if (id !== this.completionId || this.current(identity) === null) return null;
    if (this.attempted)
      return this.settled ? { kind: "cached", text: this.text } : { kind: "pending" };
    this.attempted = true;
    this.controller = new AbortController();
    return { kind: "start", signal: this.controller.signal };
  }

  finish(id: string, identity: PredictionIdentity, text: string | null): boolean {
    if (id !== this.completionId) return false;
    if (this.current(identity) === null) {
      this.invalidate();
      return false;
    }
    this.text = text;
    this.settled = true;
    return true;
  }
}
