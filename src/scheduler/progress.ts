import { createHash } from "node:crypto";
import { redactEventText } from "../core/event-redaction.js";
import type { ScheduledProgress } from "./types.js";

export class ScheduledProgressMonitor {
  readonly progress: ScheduledProgress;
  private lastResult = "";
  private repeats = 0;
  private failures = 0;
  private lastAdvance: number;
  private resultHistory: string[] = [];
  private callNames = new Map<string, string>();

  constructor(
    private readonly now = Date.now,
    previous?: ScheduledProgress,
  ) {
    this.lastAdvance = now();
    this.progress = {
      updatedAt: now(),
      currentStep: "Starting",
      recentActions: [],
      checkpoints: previous?.checkpoints ?? [],
    };
  }

  observe(event: {
    type: string;
    name?: string;
    callId?: string;
    result?: string;
    output?: string;
    ok?: boolean;
  }): boolean {
    if (
      !["tool.call", "tool.intent", "tool.result", "model.final", "model.turn.started"].includes(
        event.type,
      )
    )
      return false;
    if (event.type === "tool.intent" && event.callId && event.name)
      this.callNames.set(event.callId, event.name);
    const name = event.name ?? (event.callId ? this.callNames.get(event.callId) : undefined);
    const at = this.now();
    const text = redactEventText(name ? `${event.type}: ${name}` : event.type).slice(0, 2000);
    this.progress.updatedAt = at;
    this.progress.currentStep = text;
    this.progress.recentActions = [...this.progress.recentActions, { at, text }].slice(-50);
    if (event.type === "tool.result") {
      const fingerprint = createHash("sha256")
        .update(`${name}:${event.output ?? event.result ?? ""}`)
        .digest("hex");
      this.repeats = fingerprint === this.lastResult ? this.repeats + 1 : 1;
      if (fingerprint !== this.lastResult && event.ok !== false) this.lastAdvance = at;
      this.lastResult = fingerprint;
      this.resultHistory = [...this.resultHistory, fingerprint].slice(-12);
      this.failures = event.ok === false ? this.failures + 1 : 0;
      if (this.repeats >= 5)
        this.progress.pauseReason = "Repeated identical tool results without progress";
      if (this.failures >= 3) this.progress.pauseReason = "Three consecutive tool failures";
      if (this.resultHistory.length >= 8 && new Set(this.resultHistory).size <= 2)
        this.progress.pauseReason = "Repeated operation cycle without new results";
      if (event.callId) this.callNames.delete(event.callId);
    }
    return true;
  }

  checkStagnation(minutes: number): string | undefined {
    if (this.now() - this.lastAdvance >= minutes * 60_000)
      this.progress.pauseReason ??= "No verified progress within the configured time limit";
    return this.progress.pauseReason;
  }

  checkpoint(checkpoint: ScheduledProgress["checkpoints"][number]): void {
    const previous = this.progress.checkpoints.at(-1);
    if (
      checkpoint.evidence.length &&
      JSON.stringify(previous?.evidence) !== JSON.stringify(checkpoint.evidence)
    )
      this.lastAdvance = this.now();
    this.progress.checkpoints = [...this.progress.checkpoints, checkpoint].slice(-30);
    this.progress.currentStep = checkpoint.step;
    this.progress.updatedAt = this.now();
  }
}
