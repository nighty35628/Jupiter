// @vitest-environment jsdom

import * as eventApi from "@tauri-apps/api/event";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_PETS } from "./catalog";
import { usePetOverlayBridge } from "./overlay-bridge";
import {
  PET_OVERLAY_ACTION_EVENT,
  type PetOverlayAction,
  type PetOverlaySnapshot,
} from "./overlay-protocol";

const eventMocks = eventApi as unknown as typeof eventApi & {
  emitMockEvent: (event: string, payload: unknown) => void;
  resetMockEvents: () => void;
};

const snapshot: PetOverlaySnapshot = {
  version: 1,
  enabled: true,
  pet: BUILTIN_PETS[0]!,
  activeTabId: "tab-main",
  activities: [],
  language: "en",
  theme: "dark",
  themeStyle: "graphite",
};

function BridgeHarness({ handlers }: { handlers: Parameters<typeof usePetOverlayBridge>[1] }) {
  usePetOverlayBridge(snapshot, handlers);
  return null;
}

beforeEach(() => {
  eventMocks.resetMockEvents();
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("usePetOverlayBridge", () => {
  it("routes settings and hide requests back to the main window", () => {
    const handlers = {
      onOpenTask: vi.fn(),
      onOpenSettings: vi.fn(),
      onHide: vi.fn(),
    };
    render(<BridgeHarness handlers={handlers} />);

    act(() =>
      eventMocks.emitMockEvent(PET_OVERLAY_ACTION_EVENT, {
        action: "open-settings",
      } satisfies PetOverlayAction),
    );
    act(() =>
      eventMocks.emitMockEvent(PET_OVERLAY_ACTION_EVENT, {
        action: "hide",
      } satisfies PetOverlayAction),
    );

    expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(handlers.onHide).toHaveBeenCalledTimes(1);
  });
});
