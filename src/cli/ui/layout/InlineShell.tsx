import { Box, Static } from "ink";
import React from "react";
import { CardRenderer } from "../cards/CardRenderer.js";
import type { Card } from "../state/cards.js";
import { useAgentState } from "../state/provider.js";
import { Composer } from "./Composer.js";
import { SessionIntro } from "./SessionIntro.js";

export function InlineShell(): React.ReactElement {
  const session = useAgentState((s) => s.session);
  const cards = useAgentState((s) => s.cards);

  const { committed, live } = React.useMemo(() => splitCards(cards), [cards]);
  const staticItems = React.useMemo<Array<IntroItem | CardItem>>(
    () => [
      { kind: "intro" as const },
      ...committed.map((c) => ({ kind: "card" as const, card: c })),
    ],
    [committed],
  );

  return (
    <>
      <Static items={staticItems}>
        {(item, idx) =>
          item.kind === "intro" ? (
            <SessionIntro key="intro" session={session} />
          ) : (
            <Box key={item.card.id} marginBottom={1}>
              <CardRenderer card={item.card} />
            </Box>
          )
        }
      </Static>
      {live.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {live.map((card) => (
            <Box key={card.id} marginBottom={1}>
              <CardRenderer card={card} />
            </Box>
          ))}
        </Box>
      )}
      <Composer />
    </>
  );
}

type IntroItem = { kind: "intro" };
type CardItem = { kind: "card"; card: Card };

function splitCards(cards: ReadonlyArray<Card>): { committed: Card[]; live: Card[] } {
  const committed: Card[] = [];
  const live: Card[] = [];
  for (const card of cards) {
    if (isLive(card)) live.push(card);
    else committed.push(card);
  }
  return { committed, live };
}

function isLive(card: Card): boolean {
  if (card.kind === "streaming") return !card.done;
  if (card.kind === "reasoning") return card.streaming;
  if (card.kind === "live" && card.variant === "thinking") return true;
  return false;
}
