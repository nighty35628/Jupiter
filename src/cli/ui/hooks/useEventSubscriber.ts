import { useEffect } from "react";
import type { AgentEvent } from "../state/events.js";
import { useAgentStore } from "../state/provider.js";

export function useEventSubscriber(handler: (event: AgentEvent) => void): void {
  const store = useAgentStore();
  useEffect(() => store.onEvent(handler), [store, handler]);
}
