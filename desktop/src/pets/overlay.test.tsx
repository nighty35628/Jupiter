// @vitest-environment jsdom

import * as eventApi from "@tauri-apps/api/event";
import * as menuApi from "@tauri-apps/api/menu";
import * as windowApi from "@tauri-apps/api/window";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_PETS } from "./catalog";
import { PET_NATIVE_MENU_IDS } from "./native-context-menu";
import { PetOverlayApp, clampPetContextMenuPosition } from "./overlay";
import {
  PET_OVERLAY_ACTION_EVENT,
  PET_OVERLAY_OPEN_TASK_EVENT,
  PET_OVERLAY_SNAPSHOT_EVENT,
  type PetOverlaySnapshot,
} from "./overlay-protocol";

const eventMocks = eventApi as unknown as typeof eventApi & {
  emitMockEvent: (event: string, payload: unknown) => void;
  resetMockEvents: () => void;
};
const menuMocks = menuApi as unknown as {
  menuMockState: { items: Array<{ id: string; trigger(): void }> };
  popupMock: ReturnType<typeof vi.fn>;
  resetMenuMocks(): void;
};
const { menuMockState, popupMock, resetMenuMocks } = menuMocks;
const windowMocks = windowApi as unknown as typeof windowApi & {
  currentWindow: {
    outerPosition: ReturnType<typeof vi.fn>;
    setPosition: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
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
  resetMenuMocks();
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

  it("only changes native visibility when the enabled state changes", async () => {
    render(<PetOverlayApp />);

    act(() => eventMocks.emitMockEvent(PET_OVERLAY_SNAPSHOT_EVENT, snapshot("waiting")));
    await waitFor(() => expect(windowMocks.currentWindow.show).toHaveBeenCalledTimes(1));

    act(() => eventMocks.emitMockEvent(PET_OVERLAY_SNAPSHOT_EVENT, snapshot("thinking")));
    await screen.findByText("Thinking");
    expect(windowMocks.currentWindow.show).toHaveBeenCalledTimes(1);
    expect(windowMocks.currentWindow.hide).not.toHaveBeenCalled();

    act(() =>
      eventMocks.emitMockEvent(PET_OVERLAY_SNAPSHOT_EVENT, {
        ...snapshot("thinking"),
        enabled: false,
      }),
    );
    await waitFor(() => expect(windowMocks.currentWindow.hide).toHaveBeenCalledTimes(1));

    act(() =>
      eventMocks.emitMockEvent(PET_OVERLAY_SNAPSHOT_EVENT, {
        ...snapshot("waiting"),
        enabled: false,
      }),
    );
    expect(windowMocks.currentWindow.hide).toHaveBeenCalledTimes(1);

    act(() => eventMocks.emitMockEvent(PET_OVERLAY_SNAPSHOT_EVENT, snapshot("waiting")));
    await waitFor(() => expect(windowMocks.currentWindow.show).toHaveBeenCalledTimes(2));
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

  it("opens a bounded pet menu and routes its useful actions", async () => {
    popupMock.mockRejectedValueOnce(new Error("native menu unavailable"));
    const view = render(<PetOverlayApp />);
    act(() => eventMocks.emitMockEvent(PET_OVERLAY_SNAPSHOT_EVENT, snapshot("thinking")));
    const actor = await screen.findByRole("button", {
      name: "Open the conversation linked to this pet",
    });

    fireEvent.contextMenu(actor, { clientX: 230, clientY: 210 });
    expect(await screen.findByRole("menu", { name: "Pet menu" })).toBeTruthy();
    expect(screen.getByText("Open current conversation")).toBeTruthy();
    expect(screen.getByText("Say hello")).toBeTruthy();
    expect(screen.getByText("Reset position")).toBeTruthy();
    expect(screen.getByText("Pet settings")).toBeTruthy();
    expect(screen.getByText("Hide pet")).toBeTruthy();

    const openItem = screen.getByRole("menuitem", { name: "Open current conversation" });
    const settingsItem = screen.getByRole("menuitem", { name: "Pet settings" });
    await waitFor(() => expect(document.activeElement).toBe(openItem));
    expect(openItem.getAttribute("data-highlighted")).toBeNull();
    fireEvent.mouseMove(settingsItem);
    expect(settingsItem.getAttribute("data-highlighted")).toBe("true");
    expect(openItem.getAttribute("data-highlighted")).toBeNull();
    fireEvent.pointerLeave(screen.getByRole("menu", { name: "Pet menu" }));
    expect(settingsItem.getAttribute("data-highlighted")).toBeNull();

    fireEvent.click(screen.getByText("Say hello"));
    expect(view.container.querySelector(".pet-overlay-root")?.getAttribute("data-activity")).toBe(
      "waving",
    );

    fireEvent.contextMenu(actor, { clientX: 230, clientY: 210 });
    fireEvent.click(screen.getByText("Reset position"));
    await waitFor(() =>
      expect(windowMocks.currentWindow.setPosition).toHaveBeenCalledWith(
        expect.objectContaining({ x: 1652, y: 802 }),
      ),
    );

    fireEvent.contextMenu(actor, { clientX: 230, clientY: 210 });
    fireEvent.click(screen.getByText("Pet settings"));
    expect(eventApi.emitTo).toHaveBeenCalledWith("main", PET_OVERLAY_ACTION_EVENT, {
      action: "open-settings",
    });

    fireEvent.contextMenu(actor, { clientX: 230, clientY: 210 });
    fireEvent.click(screen.getByText("Hide pet"));
    expect(eventApi.emitTo).toHaveBeenCalledWith("main", PET_OVERLAY_ACTION_EVENT, {
      action: "hide",
    });
  });

  it("keeps the pet menu inside its fixed overlay window", () => {
    expect(clampPetContextMenuPosition(230, 210, 248, 220)).toEqual({ x: 52, y: 32 });
    expect(clampPetContextMenuPosition(-20, -10, 248, 220)).toEqual({ x: 8, y: 8 });
  });

  it("opens the active conversation instead of a background busy task", async () => {
    render(<PetOverlayApp />);
    const current = snapshot("thinking");
    current.activeTabId = "tab-active";
    current.activities = [
      {
        ...current.activities[0]!,
        tabId: "tab-background",
        title: "Background task",
        active: false,
      },
      {
        ...current.activities[0]!,
        tabId: "tab-active",
        title: "Current conversation",
        status: "idle",
        active: true,
      },
    ];
    act(() => eventMocks.emitMockEvent(PET_OVERLAY_SNAPSHOT_EVENT, current));
    const actor = await screen.findByRole("button", {
      name: "Open the conversation linked to this pet",
    });

    fireEvent.contextMenu(actor, { clientX: 100, clientY: 100 });
    await waitFor(() => expect(popupMock).toHaveBeenCalledTimes(1));
    menuMockState.items.find((item) => item.id === PET_NATIVE_MENU_IDS.openTask)?.trigger();

    expect(eventApi.emitTo).toHaveBeenCalledWith("main", PET_OVERLAY_OPEN_TASK_EVENT, {
      tabId: "tab-active",
    });
  });

  it("supports keyboard selection and dismissal", async () => {
    popupMock.mockRejectedValueOnce(new Error("native menu unavailable"));
    render(<PetOverlayApp />);
    act(() => eventMocks.emitMockEvent(PET_OVERLAY_SNAPSHOT_EVENT, snapshot()));
    const actor = await screen.findByRole("button", {
      name: "Open the conversation linked to this pet",
    });

    fireEvent.contextMenu(actor, { clientX: 100, clientY: 100 });
    const menu = await screen.findByRole("menu", { name: "Pet menu" });
    const openItem = screen.getByRole("menuitem", { name: "Open current conversation" });
    const interactItem = screen.getByRole("menuitem", { name: "Say hello" });

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(openItem.getAttribute("data-highlighted")).toBe("true");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(interactItem.getAttribute("data-highlighted")).toBe("true");
    expect(document.activeElement).toBe(interactItem);

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Pet menu" })).toBeNull();
  });

  it("survives repeated open and cancel cycles", async () => {
    popupMock.mockRejectedValueOnce(new Error("native menu unavailable"));
    render(<PetOverlayApp />);
    act(() => eventMocks.emitMockEvent(PET_OVERLAY_SNAPSHOT_EVENT, snapshot()));
    const actor = await screen.findByRole("button", {
      name: "Open the conversation linked to this pet",
    });

    fireEvent.contextMenu(actor, { clientX: 100, clientY: 100 });
    expect(await screen.findByRole("menu", { name: "Pet menu" })).toBeTruthy();
    fireEvent.pointerDown(document.body);

    for (let index = 1; index < 100; index += 1) {
      fireEvent.contextMenu(actor, { clientX: 100, clientY: 100 });
      expect(screen.getByRole("menu", { name: "Pet menu" })).toBeTruthy();
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("menu", { name: "Pet menu" })).toBeNull();
    }
  });
});
