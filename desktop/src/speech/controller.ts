export type SpeechEvent = {
  sessionId: string;
  state: "preparing" | "recording" | "transcribing" | "result" | "error" | "cancelled";
  text?: string;
  error?: string;
};
export type SpeechMode = "local" | "system";
export type SpeechCapabilities = {
  available: boolean; backend: "whisper" | "android";
  localAvailable: boolean; networkAvailable: boolean; autoLanguage: boolean;
  modelReady: boolean; modelBytes: number; modelDownloading?: boolean; modelProgress?: number;
};
export interface SpeechHost {
  listen(callback: (event: SpeechEvent) => void): Promise<() => void>;
  start(sessionId: string, language: string, mode: SpeechMode): Promise<unknown>;
  finish(sessionId: string): Promise<unknown>;
  cancel(sessionId: string): Promise<unknown>;
}
type Binding = {
  current(): boolean;
  revision(): number;
  composing(): boolean;
  insert(text: string, start: number, end: number, revision: number): boolean;
};
export type DictationState = {
  phase: "idle" | "preparing" | "recording" | "transcribing";
  preview: string; candidate: string; error: string;
};
const empty: DictationState = { phase: "idle", preview: "", candidate: "", error: "" };

/** One draft-bound request; the native host arbitrates microphone ownership. */
export class DictationController {
  sessionId?: string;
  private state = empty;
  private listeners = new Set<() => void>();
  private unlisten?: () => void;
  private revision = 0;
  private startAt = 0;
  private endAt = 0;
  constructor(private host: SpeechHost, private binding: Binding) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<DictationState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  async start(language: string, mode: SpeechMode, start: number, end: number) {
    if (this.sessionId || this.state.candidate || !this.binding.current() || this.binding.composing()) return;
    const id = crypto.randomUUID();
    this.sessionId = id;
    this.revision = this.binding.revision();
    this.startAt = start; this.endAt = end;
    this.publish({ ...empty, phase: "preparing" });
    try {
      const unlisten = await this.host.listen(event => this.receive(event));
      if (this.sessionId !== id) { unlisten(); return; }
      this.unlisten = unlisten;
      await this.host.start(id, language, mode);
    } catch {
      if (this.sessionId === id) {
        this.retire();
        this.publish({ phase: "idle", error: "start" });
      }
    }
  }
  async finish() {
    const id = this.sessionId;
    if (!id || this.state.phase !== "recording") return;
    this.publish({ phase: "transcribing" });
    try { await this.host.finish(id); }
    catch {
      if (this.sessionId === id) {
        void this.host.cancel(id).catch(() => {});
        this.retire();
        this.publish({ phase: "idle", preview: "", error: "finish" });
      }
    }
  }
  cancel = () => {
    const id = this.sessionId;
    this.retire();
    this.publish(empty);
    if (id) void this.host.cancel(id).catch(() => {});
  };
  discard = () => this.publish({ candidate: "", error: "" });
  insertCandidate(start: number, end: number) {
    const text = this.state.candidate;
    if (text && this.binding.current() && !this.binding.composing() &&
        this.binding.insert(text, start, end, this.binding.revision())) this.discard();
  }
  private retire() {
    this.sessionId = undefined;
    this.unlisten?.(); this.unlisten = undefined;
  }
  private receive(event: SpeechEvent) {
    if (!this.sessionId || event.sessionId !== this.sessionId) return;
    if (!this.binding.current()) { this.cancel(); return; }
    if (event.state === "result") {
      const text = typeof event.text === "string" && event.text.trim() ? event.text.slice(0, 32000) : "";
      this.retire(); // Consume before writing: synchronous store notifications may re-enter.
      const inserted = text && !this.binding.composing() &&
        this.binding.insert(text, this.startAt, this.endAt, this.revision);
      this.publish({ ...empty, candidate: inserted ? "" : text });
    } else if (event.state === "error" || event.state === "cancelled") {
      this.retire();
      this.publish({ ...empty, error: event.state === "error" ? (event.error || "recognition") : "" });
    } else {
      // Partial hypotheses replace one another; they never append to the draft.
      this.publish({ phase: event.state,
        preview: typeof event.text === "string" ? event.text.slice(0, 32000) : this.state.preview });
    }
  }
}
