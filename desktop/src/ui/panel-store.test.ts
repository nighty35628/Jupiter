import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RIGHT_PANEL_WIDTH, usePanelStore } from "./panel-store";

describe("panel-store", () => {
  beforeEach(() => {
    usePanelStore.setState({
      rightPanel: "none",
      rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
      bottomPanelOpen: false,
      previewTabId: null,
      browserTabId: null,
    });
  });

  it("opens only one right-side surface at a time", () => {
    usePanelStore.getState().openSidePanel();
    expect(usePanelStore.getState().rightPanel).toBe("side");

    usePanelStore.getState().openContextInfo();
    expect(usePanelStore.getState().rightPanel).toBe("contextInfo");

    usePanelStore.getState().closeRightPanel();
    expect(usePanelStore.getState().rightPanel).toBe("none");
  });

  it("keeps side and context info width on the same bounded value", () => {
    usePanelStore.getState().setRightPanelWidth(120);
    expect(usePanelStore.getState().rightPanelWidth).toBe(260);

    usePanelStore.getState().setRightPanelWidth(900);
    expect(usePanelStore.getState().rightPanelWidth).toBe(560);

    usePanelStore.getState().setRightPanelWidth(420);
    expect(usePanelStore.getState().rightPanelWidth).toBe(420);
  });

  it("keeps bottom panel state independent from the right panel", () => {
    usePanelStore.getState().setBottomPanelOpen(true);
    usePanelStore.getState().openSidePanel();

    expect(usePanelStore.getState().bottomPanelOpen).toBe(true);
    expect(usePanelStore.getState().rightPanel).toBe("side");

    usePanelStore.getState().closeRightPanel();
    expect(usePanelStore.getState().bottomPanelOpen).toBe(true);
  });

  it("preserves preview and browser tab ids when the right panel is collapsed", () => {
    usePanelStore.getState().setPreviewTabId("preview-1");
    usePanelStore.getState().setBrowserTabId("browser-1");
    usePanelStore.getState().openSidePanel();
    usePanelStore.getState().closeRightPanel();

    expect(usePanelStore.getState().previewTabId).toBe("preview-1");
    expect(usePanelStore.getState().browserTabId).toBe("browser-1");
  });
});
