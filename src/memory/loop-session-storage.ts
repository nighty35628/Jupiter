import type { ChatMessage } from "../types.js";
import type { SessionMeta } from "./session.js";
import type { ToolExecutionJournal } from "./tool-execution-journal.js";

export interface SemanticFold {
  before: readonly ChatMessage[];
  head: readonly ChatMessage[];
  summary: ChatMessage;
  /** Keep the acceptance signal live until deferred publication at raw commit. */
  signal?: AbortSignal;
}

/** Per-run working history. The owner coordinates shared commits, leases and recovery. */
export interface LoopSessionStorage {
  /** Configure stable system-rule identity before loading the per-turn projection. */
  beginRules?(fingerprint: string): void;
  /** Only call for an accepted semantic fold, after rewriting the working projection. */
  recordFold?(fold: SemanticFold): boolean;
  /** Raw user messages, including this run, never the compressed projection's count. */
  readonly rawUserTurns?: number;
  /** Explicit manual publication; shared stores route through their coordinator. */
  publishCompaction?(signal?: AbortSignal): boolean;
  loadMessages(): ChatMessage[];
  /** Raw history for explicit history operations only, never for model request assembly. */
  loadRawMessages?(): ChatMessage[];
  /** Return the identity-stamped record to retain the same identity in the model log. */
  // biome-ignore lint/suspicious/noConfusingVoidType: Writers may return an identity-stamped record.
  appendMessage(message: ChatMessage): ChatMessage | void;
  /** Context changes only the projection; history reconciles raw records by identity, not base length. */
  rewriteMessages(messages: ChatMessage[], reason: "context" | "history"): void;
  loadMeta(): SessionMeta;
  patchMeta(patch: Partial<SessionMeta>): void;
  journal: ToolExecutionJournal | null;
  /** Update the raw assistant tail as well as its possibly compressed projection. */
  // biome-ignore lint/suspicious/noConfusingVoidType: Match the optional identity-returning append contract.
  replaceTailMessage?(message: ChatMessage): ChatMessage | void;
  /** Discard the raw current turn even if compaction changed projection indices. */
  discardCurrentTurn?(): void;
}
