import * as menuApi from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PET_NATIVE_MENU_IDS,
  PetNativeContextMenu,
  type PetNativeMenuActions,
  type PetNativeMenuLabels,
} from "./native-context-menu";

type MockResource = { close: ReturnType<typeof vi.fn> };
type MockMenuItem = MockResource & {
  id: string;
  textValue: string;
  enabled: boolean;
  trigger(): void;
};
type MockMenu = MockResource & { id: string };
const menuMocks = menuApi as unknown as {
  Menu: typeof menuApi.Menu;
  MenuItem: typeof menuApi.MenuItem;
  menuMockState: {
    items: MockMenuItem[];
    separators: MockResource[];
    menus: MockMenu[];
  };
  popupMock: ReturnType<typeof vi.fn>;
  resetMenuMocks(): void;
};
const { Menu, MenuItem, menuMockState, popupMock, resetMenuMocks } = menuMocks;

const labels: PetNativeMenuLabels = {
  openTask: "Open current conversation",
  interact: "Say hello",
  resetPosition: "Reset position",
  settings: "Pet settings",
  hide: "Hide pet",
};

function actions(): PetNativeMenuActions {
  return {
    openTask: vi.fn(),
    interact: vi.fn(),
    resetPosition: vi.fn(),
    openSettings: vi.fn(),
    hide: vi.fn(),
  };
}

beforeEach(() => {
  resetMenuMocks();
});

describe("PetNativeContextMenu", () => {
  it("creates one native menu, updates labels, and routes every action", async () => {
    const callbacks = actions();
    const window = getCurrentWindow();
    const controller = new PetNativeContextMenu(window, callbacks);

    await controller.show({ activeTabId: "tab-main", labels });

    expect(Menu.new).toHaveBeenCalledTimes(1);
    expect(MenuItem.new).toHaveBeenCalledTimes(5);
    expect(popupMock).toHaveBeenCalledWith(undefined, window);
    expect(menuMockState.menus[0]?.id).toBe(PET_NATIVE_MENU_IDS.menu);
    expect(menuMockState.items.map((item) => [item.id, item.textValue, item.enabled])).toEqual([
      [PET_NATIVE_MENU_IDS.openTask, labels.openTask, true],
      [PET_NATIVE_MENU_IDS.interact, labels.interact, true],
      [PET_NATIVE_MENU_IDS.resetPosition, labels.resetPosition, true],
      [PET_NATIVE_MENU_IDS.settings, labels.settings, true],
      [PET_NATIVE_MENU_IDS.hide, labels.hide, true],
    ]);

    for (const item of menuMockState.items) item.trigger();
    expect(callbacks.openTask).toHaveBeenCalledWith("tab-main");
    expect(callbacks.interact).toHaveBeenCalledTimes(1);
    expect(callbacks.resetPosition).toHaveBeenCalledTimes(1);
    expect(callbacks.openSettings).toHaveBeenCalledTimes(1);
    expect(callbacks.hide).toHaveBeenCalledTimes(1);

    const translated = Object.fromEntries(
      Object.entries(labels).map(([key, value]) => [key, `translated ${value}`]),
    ) as PetNativeMenuLabels;
    await controller.show({ activeTabId: "", labels: translated });

    expect(Menu.new).toHaveBeenCalledTimes(1);
    expect(menuMockState.items[0]?.textValue).toBe(translated.openTask);
    expect(menuMockState.items[0]?.enabled).toBe(false);
    await controller.dispose();
    for (const resource of [
      ...menuMockState.items,
      ...menuMockState.separators,
      ...menuMockState.menus,
    ]) {
      expect(resource.close).toHaveBeenCalledTimes(1);
    }
  });

  it("serializes overlapping popups and unlocks after an error", async () => {
    let resolvePopup: (() => void) | undefined;
    popupMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePopup = resolve;
        }),
    );
    const controller = new PetNativeContextMenu(getCurrentWindow(), actions());

    const first = controller.show({ activeTabId: "tab-main", labels });
    await vi.waitFor(() => expect(popupMock).toHaveBeenCalledTimes(1));
    const second = controller.show({ activeTabId: "tab-other", labels });
    expect(second).toBe(first);
    expect(popupMock).toHaveBeenCalledTimes(1);
    resolvePopup?.();
    await first;

    popupMock.mockRejectedValueOnce(new Error("popup failed"));
    await expect(controller.show({ activeTabId: "tab-main", labels })).rejects.toThrow(
      "popup failed",
    );
    await controller.show({ activeTabId: "tab-main", labels });
    expect(popupMock).toHaveBeenCalledTimes(3);
    await controller.dispose();
  });

  it("reuses the same resources across 100 popup cycles", async () => {
    const controller = new PetNativeContextMenu(getCurrentWindow(), actions());
    for (let index = 0; index < 100; index += 1) {
      await controller.show({ activeTabId: `tab-${index}`, labels });
    }

    expect(Menu.new).toHaveBeenCalledTimes(1);
    expect(MenuItem.new).toHaveBeenCalledTimes(5);
    expect(popupMock).toHaveBeenCalledTimes(100);
    await controller.dispose();
  });
});
