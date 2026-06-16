import { useSyncExternalStore } from "react";

export type PanelKind = "none" | "side" | "contextInfo";

export const MIN_RIGHT_PANEL_WIDTH = 260;
export const MAX_RIGHT_PANEL_WIDTH = 560;
export const DEFAULT_RIGHT_PANEL_WIDTH = 306;

export type PanelStoreState = {
  rightPanel: PanelKind;
  rightPanelWidth: number;
  bottomPanelOpen: boolean;
  previewTabId: string | null;
  browserTabId: string | null;
  openSidePanel: () => void;
  openContextInfo: () => void;
  closeRightPanel: () => void;
  setRightPanelWidth: (width: number) => void;
  setBottomPanelOpen: (open: boolean) => void;
  setPreviewTabId: (id: string | null) => void;
  setBrowserTabId: (id: string | null) => void;
};

const listeners = new Set<() => void>();

function clampRightPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_RIGHT_PANEL_WIDTH;
  return Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(MAX_RIGHT_PANEL_WIDTH, Math.round(width)));
}

function setPanelState(
  patch: Partial<PanelStoreState> | ((state: PanelStoreState) => Partial<PanelStoreState>),
): void {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const listener of listeners) listener();
}

const initialState: PanelStoreState = {
  rightPanel: "none",
  rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
  bottomPanelOpen: false,
  previewTabId: null,
  browserTabId: null,
  openSidePanel: () => setPanelState({ rightPanel: "side" }),
  openContextInfo: () => setPanelState({ rightPanel: "contextInfo" }),
  closeRightPanel: () => setPanelState({ rightPanel: "none" }),
  setRightPanelWidth: (width) => setPanelState({ rightPanelWidth: clampRightPanelWidth(width) }),
  setBottomPanelOpen: (bottomPanelOpen) => setPanelState({ bottomPanelOpen }),
  setPreviewTabId: (previewTabId) => setPanelState({ previewTabId }),
  setBrowserTabId: (browserTabId) => setPanelState({ browserTabId }),
};

let state = initialState;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type PanelStoreHook = {
  (): PanelStoreState;
  <T>(selector: (state: PanelStoreState) => T): T;
  getState: () => PanelStoreState;
  setState: (
    patch: Partial<PanelStoreState> | ((state: PanelStoreState) => Partial<PanelStoreState>),
  ) => void;
  subscribe: (listener: () => void) => () => void;
};

export const usePanelStore = ((selector?: (state: PanelStoreState) => unknown) =>
  useSyncExternalStore(
    subscribe,
    () => (selector ? selector(state) : state),
    () => (selector ? selector(state) : state),
  )) as PanelStoreHook;

usePanelStore.getState = () => state;
usePanelStore.setState = setPanelState;
usePanelStore.subscribe = subscribe;
