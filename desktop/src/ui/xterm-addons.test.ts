// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalAddons } from "./xterm-addons";

const originalOpen = window.open;
const originalClipboard = navigator.clipboard;

afterEach(() => {
  Object.defineProperty(window, "open", {
    configurable: true,
    value: originalOpen,
    writable: true,
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
});

describe("createTerminalAddons", () => {
  it("returns fit, web links, and clipboard addons when browser APIs exist", async () => {
    Object.defineProperty(window, "open", {
      configurable: true,
      value: vi.fn(),
      writable: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn(), writeText: vi.fn() },
    });

    const { addons, fitAddon } = await createTerminalAddons();

    expect(fitAddon).toBeTruthy();
    expect(addons).toHaveLength(3);
  });

  it("omits web links when window.open is unavailable", async () => {
    Object.defineProperty(window, "open", {
      configurable: true,
      value: undefined,
      writable: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn(), writeText: vi.fn() },
    });

    const { addons } = await createTerminalAddons();

    expect(addons).toHaveLength(2);
  });

  it("omits clipboard when navigator.clipboard is unavailable", async () => {
    Object.defineProperty(window, "open", {
      configurable: true,
      value: vi.fn(),
      writable: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });

    const { addons } = await createTerminalAddons();

    expect(addons).toHaveLength(2);
  });
});
