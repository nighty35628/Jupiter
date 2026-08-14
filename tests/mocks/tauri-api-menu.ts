import { vi } from "vitest";

type MenuItemOptions = {
  id?: string;
  text: string;
  enabled?: boolean;
  action?: (id: string) => void;
};

type MenuOptions = {
  id?: string;
  items?: Array<MenuItem | PredefinedMenuItem>;
};

export const popupMock = vi.fn(
  (_at?: unknown, _window?: unknown): Promise<void> => Promise.resolve(),
);

export const menuMockState: {
  items: MenuItem[];
  separators: PredefinedMenuItem[];
  menus: Menu[];
} = {
  items: [],
  separators: [],
  menus: [],
};

export class MenuItem {
  static new = vi.fn(async (options: MenuItemOptions) => {
    const item = new MenuItem(options);
    menuMockState.items.push(item);
    return item;
  });

  readonly id: string;
  readonly close = vi.fn(() => Promise.resolve());
  readonly setText = vi.fn((text: string) => {
    this.textValue = text;
    return Promise.resolve();
  });
  readonly setEnabled = vi.fn((enabled: boolean) => {
    this.enabled = enabled;
    return Promise.resolve();
  });
  textValue: string;
  enabled: boolean;

  private constructor(private readonly options: MenuItemOptions) {
    this.id = options.id ?? "";
    this.textValue = options.text;
    this.enabled = options.enabled ?? true;
  }

  trigger(): void {
    this.options.action?.(this.id);
  }
}

export class PredefinedMenuItem {
  static new = vi.fn(async (_options?: { item: string }) => {
    const item = new PredefinedMenuItem(`separator-${menuMockState.separators.length + 1}`);
    menuMockState.separators.push(item);
    return item;
  });

  readonly close = vi.fn(() => Promise.resolve());

  private constructor(readonly id: string) {}
}

export class Menu {
  static new = vi.fn(async (options: MenuOptions = {}) => {
    const menu = new Menu(options.id ?? "", options.items ?? []);
    menuMockState.menus.push(menu);
    return menu;
  });

  readonly close = vi.fn(() => Promise.resolve());

  private constructor(
    readonly id: string,
    readonly items: Array<MenuItem | PredefinedMenuItem>,
  ) {}

  popup(at?: unknown, window?: unknown): Promise<void> {
    return popupMock(at, window);
  }
}

export function resetMenuMocks(): void {
  menuMockState.items.length = 0;
  menuMockState.separators.length = 0;
  menuMockState.menus.length = 0;
  MenuItem.new.mockClear();
  PredefinedMenuItem.new.mockClear();
  Menu.new.mockClear();
  popupMock.mockReset();
  popupMock.mockResolvedValue(undefined);
}
