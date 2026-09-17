import { budgetTranscriptMessages } from "../../../src/desktop/transcript-budget";

/** Evict old replayable payloads only at turn boundaries, not on UI actions. */
export function retainRecentTranscript<T extends { kind: string; turn?: number }>(
  messages: T[],
  preserveTurns: ReadonlySet<number>,
): T[] {
  const preserved = new Set(preserveTurns);
  const latest = messages
    .filter((message) => message.kind === "user" || message.kind === "assistant")
    .at(-1)?.turn;
  if (latest !== undefined) preserved.add(latest);
  return budgetTranscriptMessages(messages, {
    preserveTurns: preserved,
    maxPayloadBytes: 4 * 1024 * 1024,
    maxChars: 2_000_000,
    maxSegments: 10_000,
    maxFieldChars: 1_000_000,
  });
}

export function elideTranscriptMessages<T extends { kind: string; turn?: number }>(
  messages: T[],
  preserveTurns: ReadonlySet<number> = new Set(),
): T[] {
  return createTranscriptProjector<T>()(messages, preserveTurns);
}

/** Stream deltas only replace the live tail; expensive history budgeting is cached. */
export function createTranscriptProjector<T extends { kind: string; turn?: number }>() {
  let previous: T[] = [];
  let projected: T[] = [];
  let previousPreserved = "";
  return (messages: T[], preserveTurns: ReadonlySet<number> = new Set()): T[] => {
    let latest: number | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind === "user" || messages[i].kind === "assistant") {
        latest = messages[i].turn;
        break;
      }
    }
    const boundary =
      latest === undefined
        ? messages.length
        : messages.findIndex(
            (message) =>
              (message.kind === "user" || message.kind === "assistant") && message.turn === latest,
          );
    const history = messages.slice(0, boundary);
    const preservedKey = [...preserveTurns].sort((a, b) => a - b).join(",");
    if (
      previousPreserved !== preservedKey ||
      history.length !== previous.length ||
      history.some((message, index) => message !== previous[index])
    ) {
      projected = budgetTranscriptMessages(history, { preserveTurns });
      previous = history;
      previousPreserved = preservedKey;
    }
    // Finishing a stream must not collapse the row the user is reading.
    return [...projected, ...messages.slice(boundary)];
  };
}
