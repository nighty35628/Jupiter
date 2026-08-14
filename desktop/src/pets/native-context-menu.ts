import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import type { Window } from "@tauri-apps/api/window";

export const PET_NATIVE_MENU_IDS = {
  menu: "jupiter.pet.context",
  openTask: "jupiter.pet.open-task",
  interact: "jupiter.pet.interact",
  resetPosition: "jupiter.pet.reset-position",
  settings: "jupiter.pet.settings",
  hide: "jupiter.pet.hide",
} as const;

export type PetNativeMenuLabels = {
  openTask: string;
  interact: string;
  resetPosition: string;
  settings: string;
  hide: string;
};

export type PetNativeMenuActions = {
  openTask: (tabId: string) => void;
  interact: () => void;
  resetPosition: () => void;
  openSettings: () => void;
  hide: () => void;
};

type Closable = { close(): Promise<void> };

type PetNativeMenuResources = {
  menu: Menu;
  openTask: MenuItem;
  interact: MenuItem;
  resetPosition: MenuItem;
  settings: MenuItem;
  hide: MenuItem;
  owned: Closable[];
};

export type PetNativeMenuRequest = {
  activeTabId: string;
  labels: PetNativeMenuLabels;
};

export class PetNativeContextMenu {
  private resourcesPromise: Promise<PetNativeMenuResources> | null = null;
  private popupPromise: Promise<void> | null = null;
  private activeTabId = "";
  private disposed = false;
  private resourcesClosed = false;

  constructor(
    private readonly window: Window,
    private readonly actions: PetNativeMenuActions,
  ) {}

  show(request: PetNativeMenuRequest): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.popupPromise) return this.popupPromise;

    const pending = this.showOnce(request).finally(() => {
      if (this.popupPromise === pending) this.popupPromise = null;
    });
    this.popupPromise = pending;
    return pending;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.popupPromise?.catch(() => undefined);
    const resources = await this.resourcesPromise?.catch(() => null);
    if (resources) await this.closeResources(resources);
  }

  private async showOnce(request: PetNativeMenuRequest): Promise<void> {
    this.activeTabId = request.activeTabId;
    const resources = await this.getResources();
    if (this.disposed) return;

    await Promise.all([
      resources.openTask.setText(request.labels.openTask),
      resources.interact.setText(request.labels.interact),
      resources.resetPosition.setText(request.labels.resetPosition),
      resources.settings.setText(request.labels.settings),
      resources.hide.setText(request.labels.hide),
      resources.openTask.setEnabled(Boolean(request.activeTabId)),
    ]);
    if (this.disposed) return;
    await resources.menu.popup(undefined, this.window);
  }

  private getResources(): Promise<PetNativeMenuResources> {
    this.resourcesPromise ??= this.createResources();
    return this.resourcesPromise;
  }

  private async createResources(): Promise<PetNativeMenuResources> {
    const owned: Closable[] = [];
    const own = <T extends Closable>(resource: T): T => {
      owned.push(resource);
      return resource;
    };

    try {
      const openTask = own(
        await MenuItem.new({
          id: PET_NATIVE_MENU_IDS.openTask,
          text: "",
          action: () => {
            if (!this.disposed && this.activeTabId) this.actions.openTask(this.activeTabId);
          },
        }),
      );
      const interact = own(
        await MenuItem.new({
          id: PET_NATIVE_MENU_IDS.interact,
          text: "",
          action: () => {
            if (!this.disposed) this.actions.interact();
          },
        }),
      );
      const firstSeparator = own(await PredefinedMenuItem.new({ item: "Separator" }));
      const resetPosition = own(
        await MenuItem.new({
          id: PET_NATIVE_MENU_IDS.resetPosition,
          text: "",
          action: () => {
            if (!this.disposed) this.actions.resetPosition();
          },
        }),
      );
      const settings = own(
        await MenuItem.new({
          id: PET_NATIVE_MENU_IDS.settings,
          text: "",
          action: () => {
            if (!this.disposed) this.actions.openSettings();
          },
        }),
      );
      const secondSeparator = own(await PredefinedMenuItem.new({ item: "Separator" }));
      const hide = own(
        await MenuItem.new({
          id: PET_NATIVE_MENU_IDS.hide,
          text: "",
          action: () => {
            if (!this.disposed) this.actions.hide();
          },
        }),
      );
      const menu = own(
        await Menu.new({
          id: PET_NATIVE_MENU_IDS.menu,
          items: [
            openTask,
            interact,
            firstSeparator,
            resetPosition,
            settings,
            secondSeparator,
            hide,
          ],
        }),
      );

      return { menu, openTask, interact, resetPosition, settings, hide, owned };
    } catch (error) {
      await Promise.allSettled([...owned].reverse().map((resource) => resource.close()));
      throw error;
    }
  }

  private async closeResources(resources: PetNativeMenuResources): Promise<void> {
    if (this.resourcesClosed) return;
    this.resourcesClosed = true;
    await Promise.allSettled([...resources.owned].reverse().map((resource) => resource.close()));
  }
}
