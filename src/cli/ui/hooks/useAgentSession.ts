import { useMemo } from "react";
import type { SessionInfo } from "../state/state.js";

export interface UseAgentSessionInput {
  readonly sessionId: string | undefined;
  readonly model: string;
  readonly workspace: string;
  readonly branch?: string;
}

export function useAgentSession({
  sessionId,
  model,
  workspace,
  branch,
}: UseAgentSessionInput): SessionInfo {
  return useMemo(
    () => ({
      id: sessionId ?? "default",
      branch: branch ?? "main",
      workspace,
      model,
    }),
    [sessionId, branch, workspace, model],
  );
}
