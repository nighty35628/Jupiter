import type { ChatMessage } from "../types.js";
import type { SessionMeta } from "./session.js";
import type { ToolExecutionJournal } from "./tool-execution-journal.js";

/** Per-run working history. The owner coordinates shared commits, leases and recovery. */
export interface LoopSessionStorage {
  loadMessages(): ChatMessage[];
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
