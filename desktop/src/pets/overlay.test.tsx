// @vitest-environment jsdom

import * as eventApi from "@tauri-apps/api/event";
import * as windowApi from "@tauri-apps/api/window";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_PETS } from "./catalog";
import { PetOverlayApp } from "./overlay";
import {
  PET_OVERLAY_OPEN_TASK_EVENT,
  PET_OVERLAY_SNAPSHOT_EVENT,
  type PetOverlaySnapshot,
} from "./overlay-protocol";

const eventMocks = eventApi as unknown as typeof eventApi & {
  emitMockEvent: (event: string, payload: unknown) => void;
  resetMockEvents: () => void;
};
const windowMocks = windowApi as unknown as typeof windowApi & {
  currentWindow: {
    outerPosition: ReturnType<typeof vi.fn>;
    setPosition: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
  };
};

class LoadedImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    if (value) this.onload?.();
  }
}

function snapshot(status: "waiting" | "thinking" = "waiting"): PetOverlaySnapshot {
  return {
    version: 1,
    enabled: true,
    pet: BUILTIN_PETS[0]!,
    activeTabId: "tab-main",
    activities: [
      {
        tabId: "tab-main",
        title: "Fix the desktop overlay",
        status,
        active: true,
        updatedAt: 20,
        completionSequence: 0,
        completionOutcome: null,
      },
    ],
    language: "en",
    theme: "dark",
    themeStyle: "graphite",
  };
}

beforeEach(() => {
  eventMocks.resetMockEvents();
  vi.clearAllMocks();
  vi.stubGlobal("Image", LoadedImage);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PetOverlayApp", () => {
  it("shows linked conversation status and opens that tab", async () => {
    render(<PetOverlayApp />);
    act(() => eventMocks.emitMockEvent(PET_OVERLAY_SNAPSHOT_EVENT, snapshot()));

    expect(await screen.findByText("Needs your input")).toBeTruthy();
    expect(screen.getByText("Fix the desktop overlay")).toBeTruthy();
    await waitFor(() => expect(windowMocks.currentWindow.show).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Fix the desktop overlay"));
    expect(eventApi.emitTo).toHaveBeenCalledWith("main", PET_OVERLAY_OPEN_TASK_EVENT, {
      tabId: "tab-main",
    });
  });

  it("plays directional movement without opening a task after a drag", async () => {
    const view = render(<PetOverlayApp />);
    act(() => eventMocks.emitMockEvent(PET_OVERLAY_SNAPSHOT_EVENT, snapshot("thinking")));
    const actor = await screen.findByRole("button", {
      name: "Open the conversation linked to this pet",
    });
    await waitFor(() => expect(windowMocks.currentWindow.outerPosition).toHaveBeenCalled());

    fireEvent.pointerDown(actor, { button: 0, pointerId: 7, screenX: 120, screenY: 120 });
    fireEvent.pointerMove(actor, { pointerId: 7, screenX: 90, screenY: 124 });
    expect(view.container.querySelector(".pet-overlay-root")?.getAttribute("data-activity")).toBe(
      "dragging-left",
    );
    expect(
      view.container
        .querySelector<HTMLElement>(".pet-overlay-root")
        ?.style.getPropertyValue("--companion-roll-angle"),
    ).toBe("-37.5deg");

    fireEvent.pointerMove(actor, { pointerId: 7, screenX: 140, screenY: 124 });
    expect(view.container.querySelector(".pet-overlay-root")?.getAttribute("data-activity")).toBe(
      "dragging-right",
    );
    expect(
      view.container
        .querySelector<HTMLElement>(".pet-overlay-root")
        ?.style.getPropertyValue("--companion-roll-angle"),
    ).toBe("25deg");
    fireEvent.pointerUp(actor, { pointerId: 7, screenX: 90, screenY: 124 });

    expect(windowMocks.currentWindow.setPosition).toHaveBeenCalled();
    expect(view.container.querySelector(".pet-overlay-root")?.getAttribute("data-activity")).toBe(
      "jumping",
    );
    expect(
      vi
        .mocked(eventApi.emitTo)
        .mock.calls.some(([, event]) => event === PET_OVERLAY_OPEN_TASK_EVENT),
    ).toBe(false);
  });

  it("uses the Companion Cube's own failure pose when a task is blocked", async () => {
    const view = render(<PetOverlayApp />);
    const blocked = snapshot();
    blocked.activities[0]!.status = "blocked";
    act(() => eventMocks.emitMockEvent(PET_OVERLAY_SNAPSHOT_EVENT, blocked));

    await screen.findByText("Needs attention");
    const root = view.container.querySelector(".pet-overlay-root");
    expect(root?.getAttribute("data-activity")).toBe("failure");
    expect(root?.getAttribute("data-status")).toBe("blocked");
    expect(view.container.querySelector(".companion-cube-scene")).toBeNull();
  });
});
