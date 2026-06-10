import { describe, expect, it } from "vitest";
import {
  matchDesktopShortcut,
  matchesDesktopShortcut,
  shortcutKeys,
  tabIndexFromShortcutAction,
} from "./shortcuts";

function key(
  value: string,
  opts: Partial<Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">> = {},
): Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"> {
  return {
    key: value,
    code: opts.code ?? "",
    ctrlKey: Boolean(opts.ctrlKey),
    metaKey: Boolean(opts.metaKey),
    shiftKey: Boolean(opts.shiftKey),
    altKey: Boolean(opts.altKey),
  };
}

describe("desktop shortcut registry", () => {
  it("declares reusable shortcut keys for command surfaces", () => {
    expect(shortcutKeys("new-chat")).toEqual(["mod", "N"]);
    expect(shortcutKeys("toggle-bottom-bar")).toEqual(["mod", "shift", "B"]);
    expect(shortcutKeys("open-panel-terminal")).toEqual(["mod", "shift", "4"]);
  });

  it("matches exact modifiers so tab switching and panel switching do not conflict", () => {
    expect(matchDesktopShortcut(key("1", { ctrlKey: true }))).toBe("switch-tab-1");
    expect(tabIndexFromShortcutAction("switch-tab-1")).toBe(0);
    const shiftedDigit = key("!", { ctrlKey: true, shiftKey: true, code: "Digit1" });
    expect(matchDesktopShortcut(shiftedDigit)).toBe("open-panel-files");
    expect(matchesDesktopShortcut(shiftedDigit, "switch-tab-1")).toBe(false);
  });

  it("matches bracket tab navigation and stop/help shortcuts", () => {
    expect(matchDesktopShortcut(key("{", { metaKey: true, shiftKey: true }))).toBe(
      "previous-tab",
    );
    expect(matchDesktopShortcut(key("}", { metaKey: true, shiftKey: true }))).toBe("next-tab");
    expect(matchDesktopShortcut(key(".", { ctrlKey: true }))).toBe("stop-current-run");
    expect(matchDesktopShortcut(key("/", { ctrlKey: true }))).toBe("keyboard-shortcuts");
  });
});
