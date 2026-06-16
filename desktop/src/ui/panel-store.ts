import { create } from "zustand";

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

function clampRightPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_RIGHT_PANEL_WIDTH;
  return Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(MAX_RIGHT_PANEL_WIDTH, Math.round(width)));
}

export const usePanelStore = create<PanelStoreState>((set) => ({
  rightPanel: "none",
  rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
  bottomPanelOpen: false,
  previewTabId: null,
  browserTabId: null,
  openSidePanel: () => set({ rightPanel: "side" }),
  openContextInfo: () => set({ rightPanel: "contextInfo" }),
  closeRightPanel: () => set({ rightPanel: "none" }),
  setRightPanelWidth: (width) => set({ rightPanelWidth: clampRightPanelWidth(width) }),
  setBottomPanelOpen: (bottomPanelOpen) => set({ bottomPanelOpen }),
  setPreviewTabId: (previewTabId) => set({ previewTabId }),
  setBrowserTabId: (browserTabId) => set({ browserTabId }),
}));
