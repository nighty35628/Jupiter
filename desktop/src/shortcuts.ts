import type { TKey } from "./i18n";
import type { ContextPanelMode } from "./ui/context-panel";
import type { ShortcutKey } from "./ui/shortcut";

export type DesktopShortcutAction =
  | "new-chat"
  | "new-tab"
  | "close-tab"
  | "command-palette"
  | "focus-composer"
  | "switch-next-tab"
  | "switch-prev-tab"
  | "previous-tab"
  | "next-tab"
  | "switch-tab-1"
  | "switch-tab-2"
  | "switch-tab-3"
  | "switch-tab-4"
  | "switch-tab-5"
  | "switch-tab-6"
  | "switch-tab-7"
  | "switch-tab-8"
  | "switch-tab-9"
  | "toggle-left-sidebar"
  | "toggle-right-sidebar"
  | "toggle-bottom-bar"
  | "pick-workspace"
  | "settings"
  | "jobs"
  | "keyboard-shortcuts"
  | "stop-current-run"
  | "abort-streaming"
  | "open-panel-files"
  | "open-panel-library"
  | "open-panel-browser"
  | "open-panel-terminal"
  | "open-panel-review"
  | "open-panel-sidechat";

export type DesktopShortcutGroup = "navigation" | "layout" | "panel" | "action";

export type DesktopShortcut = {
  readonly id: DesktopShortcutAction;
  readonly labelKey: TKey;
  readonly keys: readonly ShortcutKey[];
  readonly group: DesktopShortcutGroup;
};

type ShortcutEvent = {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
};

const MODIFIERS = new Set(["mod", "shift", "alt"]);
const SHIFTED_DIGITS: Record<string, string> = {
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
};

export const PANEL_SHORTCUT_MODES: Readonly<
  Partial<Record<DesktopShortcutAction, ContextPanelMode>>
> = {
  "open-panel-files": "files",
  "open-panel-library": "library",
  "open-panel-browser": "browser",
  "open-panel-terminal": "terminal",
  "open-panel-review": "review",
  "open-panel-sidechat": "sidechat",
};

export const DESKTOP_SHORTCUTS: readonly DesktopShortcut[] = [
  {
    id: "new-chat",
    labelKey: "settings.shortcutNewChat",
    keys: ["mod", "N"],
    group: "navigation",
  },
  {
    id: "new-tab",
    labelKey: "settings.shortcutNewTab",
    keys: ["mod", "T"],
    group: "navigation",
  },
  {
    id: "close-tab",
    labelKey: "settings.shortcutCloseTab",
    keys: ["mod", "W"],
    group: "navigation",
  },
  {
    id: "command-palette",
    labelKey: "settings.shortcutCommandPalette",
    keys: ["mod", "K"],
    group: "navigation",
  },
  {
    id: "focus-composer",
    labelKey: "settings.shortcutFocusComposer",
    keys: ["mod", "L"],
    group: "navigation",
  },
  {
    id: "switch-next-tab",
    labelKey: "settings.shortcutSwitchTab",
    keys: ["mod", "tab"],
    group: "navigation",
  },
  {
    id: "switch-prev-tab",
    labelKey: "settings.shortcutSwitchTabBack",
    keys: ["mod", "shift", "tab"],
    group: "navigation",
  },
  {
    id: "previous-tab",
    labelKey: "settings.shortcutPreviousTab",
    keys: ["mod", "shift", "["],
    group: "navigation",
  },
  {
    id: "next-tab",
    labelKey: "settings.shortcutNextTab",
    keys: ["mod", "shift", "]"],
    group: "navigation",
  },
  ...Array.from({ length: 9 }, (_, index) => {
    const n = index + 1;
    return {
      id: `switch-tab-${n}` as DesktopShortcutAction,
      labelKey: `settings.shortcutSwitchTab${n}` as TKey,
      keys: ["mod", String(n)] as const,
      group: "navigation" as const,
    };
  }),
  {
    id: "toggle-left-sidebar",
    labelKey: "settings.shortcutToggleLeftSidebar",
    keys: ["mod", "B"],
    group: "layout",
  },
  {
    id: "toggle-right-sidebar",
    labelKey: "settings.shortcutToggleRightSidebar",
    keys: ["mod", "alt", "B"],
    group: "layout",
  },
  {
    id: "toggle-bottom-bar",
    labelKey: "settings.shortcutToggleBottomBar",
    keys: ["mod", "shift", "B"],
    group: "layout",
  },
  {
    id: "pick-workspace",
    labelKey: "settings.shortcutPickWorkspace",
    keys: ["mod", "O"],
    group: "layout",
  },
  { id: "settings", labelKey: "settings.shortcutSettings", keys: ["mod", ","], group: "layout" },
  { id: "jobs", labelKey: "settings.shortcutJobs", keys: ["mod", "J"], group: "layout" },
  {
    id: "keyboard-shortcuts",
    labelKey: "settings.shortcutKeyboardShortcuts",
    keys: ["mod", "/"],
    group: "layout",
  },
  {
    id: "stop-current-run",
    labelKey: "settings.shortcutStopCurrentRun",
    keys: ["mod", "."],
    group: "action",
  },
  { id: "abort-streaming", labelKey: "settings.shortcutAbort", keys: ["esc"], group: "action" },
  {
    id: "open-panel-files",
    labelKey: "settings.shortcutOpenFilesPanel",
    keys: ["mod", "shift", "1"],
    group: "panel",
  },
  {
    id: "open-panel-library",
    labelKey: "settings.shortcutOpenLibraryPanel",
    keys: ["mod", "shift", "2"],
    group: "panel",
  },
  {
    id: "open-panel-browser",
    labelKey: "settings.shortcutOpenBrowserPanel",
    keys: ["mod", "shift", "3"],
    group: "panel",
  },
  {
    id: "open-panel-terminal",
    labelKey: "settings.shortcutOpenTerminalPanel",
    keys: ["mod", "shift", "4"],
    group: "panel",
  },
  {
    id: "open-panel-review",
    labelKey: "settings.shortcutOpenReviewPanel",
    keys: ["mod", "shift", "5"],
    group: "panel",
  },
  {
    id: "open-panel-sidechat",
    labelKey: "settings.shortcutOpenSideChatPanel",
    keys: ["mod", "shift", "6"],
    group: "panel",
  },
];

export function shortcutForAction(action: DesktopShortcutAction): DesktopShortcut | undefined {
  return DESKTOP_SHORTCUTS.find((shortcut) => shortcut.id === action);
}

export function shortcutKeys(action: DesktopShortcutAction): ShortcutKey[] {
  return [...(shortcutForAction(action)?.keys ?? [])];
}

export function shortcutMatches(
  event: ShortcutEvent,
  keys: readonly ShortcutKey[],
): boolean {
  const wantsMod = keys.includes("mod");
  const wantsShift = keys.includes("shift");
  const wantsAlt = keys.includes("alt");
  const hasMod = event.ctrlKey || event.metaKey;
  if (hasMod !== wantsMod) return false;
  if (Boolean(event.shiftKey) !== wantsShift) return false;
  if (Boolean(event.altKey) !== wantsAlt) return false;

  const keyTokens = keys.filter((key) => !MODIFIERS.has(String(key)));
  if (keyTokens.length !== 1) return false;
  const expected = String(keyTokens[0]);
  const actual = event.key;
  if (expected === "tab") return actual === "Tab";
  if (expected === "esc") return actual === "Escape";
  if (/^[1-9]$/.test(expected)) {
    return (
      actual === expected ||
      event.code === `Digit${expected}` ||
      actual === SHIFTED_DIGITS[expected]
    );
  }
  if (expected === "[") return actual === "[" || actual === "{";
  if (expected === "]") return actual === "]" || actual === "}";
  return actual.toLowerCase() === expected.toLowerCase();
}

export function matchesDesktopShortcut(
  event: ShortcutEvent,
  action: DesktopShortcutAction,
): boolean {
  const shortcut = shortcutForAction(action);
  return shortcut ? shortcutMatches(event, shortcut.keys) : false;
}

export function matchDesktopShortcut(event: ShortcutEvent): DesktopShortcutAction | null {
  return DESKTOP_SHORTCUTS.find((shortcut) => shortcutMatches(event, shortcut.keys))?.id ?? null;
}

export function tabIndexFromShortcutAction(action: DesktopShortcutAction): number | null {
  const match = /^switch-tab-(\d)$/.exec(action);
  return match ? Number(match[1]) - 1 : null;
}
