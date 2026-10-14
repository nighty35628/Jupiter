import type { TurnStats } from "../../../telemetry/stats.js";
import type { Scrollback } from "../hooks/useScrollback.js";

export class TurnTranslator {
  private reasoningCardId: string | null = null;
  private streamingCardId: string | null = null;
  private toolCardId: string | null = null;
  private toolCards = new Map<string, { cardId: string; startedAt: number }>();
  private terminalToolIds = new Set<string>();

  constructor(private readonly log: Scrollback) {}

  flushBuffers(reasoningChunk: string, contentChunk: string, model?: string): void {
    if (reasoningChunk) {
      if (!this.reasoningCardId) this.reasoningCardId = this.log.startReasoning(model);
      this.log.appendReasoning(this.reasoningCardId, reasoningChunk);
    }
    if (contentChunk) {
      if (!this.streamingCardId) this.streamingCardId = this.log.startStreaming(model);
      this.log.appendStreaming(this.streamingCardId, contentChunk);
    }
  }

  toolStart(name: string, args: unknown, callId?: string): void {
    if (callId && (this.toolCards.has(callId) || this.terminalToolIds.has(callId))) return;
    // callId from the loop event is the inflight-set key — using it as
    // the card id lets the UI derive `running` from `loop.inflight.has(card.id)`.
    const cardId = this.log.startTool(name, args, callId);
    this.toolCardId = callId ?? cardId;
    this.toolCards.set(this.toolCardId, { cardId, startedAt: Date.now() });
  }

  toolEnd(output: string, callId?: string): void {
    this.closeTool(output, callId, false);
  }

  toolAbort(output?: string, callId?: string): void {
    if (callId === undefined) {
      for (const key of this.toolCards.keys()) this.closeTool(output, key, true);
      return;
    }
    this.terminalToolIds.add(callId);
    this.closeTool(output, callId, true);
  }

  isTerminalTool(callId: string): boolean {
    return this.terminalToolIds.has(callId);
  }

  isActiveTool(callId: string): boolean {
    return this.toolCardId === callId;
  }

  private closeTool(
    output: string | undefined,
    callId: string | undefined,
    aborted: boolean,
  ): void {
    const key = callId ?? this.toolCardId;
    if (!key) return;
    const card = this.toolCards.get(key);
    if (!card) return;
    this.log.endTool(card.cardId, {
      output,
      elapsedMs: Date.now() - card.startedAt,
      ...(aborted ? { aborted: true } : {}),
    });
    this.toolCards.delete(key);
    this.terminalToolIds.add(key);
    if (this.toolCardId === key) this.toolCardId = [...this.toolCards.keys()].at(-1) ?? null;
  }

  toolRetry(attempt: number, max: number, callId?: string): void {
    const key = callId ?? this.toolCardId;
    const card = key ? this.toolCards.get(key) : undefined;
    if (card) this.log.retryTool(card.cardId, attempt, max);
  }

  reasoningDone(reasoningText: string): void {
    if (!this.reasoningCardId) return;
    const paragraphs = reasoningText ? reasoningText.split(/\n\s*\n/).length : 0;
    const tokens = Math.round(reasoningText.length / 4);
    this.log.endReasoning(this.reasoningCardId, paragraphs, tokens);
    this.reasoningCardId = null;
  }

  streamingDone(): void {
    if (!this.streamingCardId) return;
    this.log.endStreaming(this.streamingCardId);
    this.streamingCardId = null;
  }

  turnEnd(
    stats: TurnStats,
    reasoningText: string,
    extras?: { promptCap?: number; elapsedMs?: number; sessionCacheHit?: number },
  ): void {
    this.log.endTurn(
      {
        prompt: stats.usage.promptTokens,
        reason: Math.round(reasoningText.length / 4),
        output: stats.usage.completionTokens,
        cacheHit: stats.cacheHitRatio,
        cost: stats.cost,
      },
      extras,
    );
  }

  abort(): void {
    if (this.streamingCardId) {
      this.log.endStreaming(this.streamingCardId, true);
      this.streamingCardId = null;
    }
    if (this.reasoningCardId) {
      this.log.endReasoning(this.reasoningCardId, 0, 0, true);
      this.reasoningCardId = null;
    }
    for (const key of this.toolCards.keys()) this.toolAbort(undefined, key);
    this.log.abortTurn();
  }
}
