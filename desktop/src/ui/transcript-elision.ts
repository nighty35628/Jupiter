import { budgetTranscriptMessages } from "../../../src/desktop/transcript-budget";

export function elideTranscriptMessages<T extends { kind: string }>(
  messages: T[],
  preserveTurns: ReadonlySet<number> = new Set(),
): T[] {
  return budgetTranscriptMessages(messages, { preserveTurns });
}
