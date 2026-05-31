import { Box, Text } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React from "react";
import type { SessionInfo } from "../state/state.js";
import { FG } from "../theme/tokens.js";

export function SessionIntro({ session }: { session: SessionInfo }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={FG.faint}>
        ◈ {session.id} {SEP} {session.branch} {SEP} {session.workspace} {SEP} {session.model}
      </Text>
    </Box>
  );
}

const SEP = "·";
