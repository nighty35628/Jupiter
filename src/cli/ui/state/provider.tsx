import React from "react";
import type { Card } from "./cards.js";
import type { AgentEvent } from "./events.js";
import type { AgentState, SessionInfo } from "./state.js";
import { type AgentStore, createStore } from "./store.js";

const StoreCtx = React.createContext<AgentStore | null>(null);

export function AgentStoreProvider({
  session,
  initialCards,
  children,
}: {
  session: SessionInfo;
  initialCards?: ReadonlyArray<Card>;
  children: React.ReactNode;
}): React.ReactElement {
  // initialCards captured at first mount — parent uses `key=session` to force a fresh provider on switch.
  const initialCardsRef = React.useRef(initialCards);
  const store = React.useMemo(() => createStore(session, initialCardsRef.current), [session]);
  return <StoreCtx.Provider value={store}>{children}</StoreCtx.Provider>;
}

export function useAgentStore(): AgentStore {
  const store = React.useContext(StoreCtx);
  if (!store) throw new Error("useAgentStore must be used inside AgentStoreProvider");
  return store;
}

export function useAgentState<T>(selector: (state: AgentState) => T): T {
  const store = useAgentStore();
  const subscribe = React.useCallback((cb: () => void) => store.subscribe(cb), [store]);
  const getSnapshot = React.useCallback(() => selector(store.getState()), [store, selector]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useDispatch(): (event: AgentEvent) => void {
  return useAgentStore().dispatch;
}
