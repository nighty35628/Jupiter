import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import { Card } from "../primitives/Card.js";
import { CardHeader } from "../primitives/CardHeader.js";
import { PULSE_CIRCLE, Pulse } from "../primitives/Pulse.js";
import type { WorkflowCard as WorkflowCardData } from "../state/cards.js";
import { useThemeTokens } from "../theme/context.js";

export function WorkflowCard({ card }: { card: WorkflowCardData }): React.ReactElement {
  const { fg, tone } = useThemeTokens();
  const run = card.run;
  const running = run.agents.filter((agent) => agent.status === "running").length;
  const completed = run.agents.filter((agent) => agent.status === "completed").length;
  const failed = run.agents.filter((agent) => agent.status === "failed").length;
  const color =
    run.status === "failed"
      ? tone.err
      : run.status === "canceled"
        ? tone.warn
        : run.status === "completed"
          ? tone.ok
          : tone.accent;
  const lastLog = run.logs.at(-1)?.message;
  return (
    <Card tone={color}>
      <CardHeader
        glyph={
          run.status === "running" ? (
            <Pulse active frames={PULSE_CIRCLE} settled="●" color={color} />
          ) : (
            "◆"
          )
        }
        tone={color}
        title="workflow"
        subtitle={run.title}
        meta={[
          run.status,
          run.phase ?? "-",
          `${run.tokenUsage.total.toLocaleString()}t`,
          `${running} running`,
          `${completed} done`,
          `${failed} failed`,
        ]}
      />
      <Box flexDirection="column">
        {lastLog ? <Text color={fg.body}>{lastLog}</Text> : null}
        {run.agents.slice(0, 5).map((agent) => (
          <Box key={agent.id} flexDirection="row" gap={1}>
            <Text color={agent.status === "failed" ? tone.err : fg.faint}>-</Text>
            <Text color={fg.body}>{agent.label}</Text>
            <Text color={fg.faint}>{agent.status}</Text>
            {agent.summary ? <Text color={fg.faint}>{agent.summary}</Text> : null}
          </Box>
        ))}
      </Box>
    </Card>
  );
}
