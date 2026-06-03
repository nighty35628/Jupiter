// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const opener = vi.hoisted(() => ({
  openPath: vi.fn(),
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  ...opener,
}));

vi.mock("./CommandPalette", () => ({
  CommandPalette: () => null,
  Toast: () => null,
  buildCommands: vi.fn(() => []),
  useCommandPalette: vi.fn(() => ({ open: false, setOpen: vi.fn() })),
}));

vi.mock("./Markdown", () => ({
  WorkspaceProvider: ({ children }: { children?: unknown }) => children ?? null,
}));

vi.mock("./theme", () => ({
  FONT_FAMILY: "sans-serif",
  FONT_FAMILY_STACK: "sans-serif",
  FONT_SCALE: 1,
  FONT_SCALE_ZOOM: 1,
  THEME: "dark",
  defaultStyleForTheme: vi.fn(() => ({
    bg: "#000",
    surface: "#111",
    border: "#222",
    text: "#fff",
    muted: "#888",
    accent: "#0af",
    danger: "#f00",
    warn: "#fa0",
    success: "#0f0",
    brand: "#0af",
  })),
  isFontFamily: vi.fn(() => true),
  isFontScale: vi.fn(() => true),
  isTheme: vi.fn(() => true),
  isThemeStyle: vi.fn(() => true),
  themeForStyle: vi.fn(() => "dark"),
}));

import { NeedsSetupView } from "./App";

afterEach(() => {
  cleanup();
  opener.openUrl.mockClear();
});

describe("NeedsSetupView", () => {
  it("explains where to get the API key and opens the DeepSeek key page", () => {
    render(
      <NeedsSetupView
        workspaceDir="/Users/jrc/Documents/code/Jupiter"
        onPickWorkspace={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText("Get an API key")).toBeTruthy();
    expect(screen.getByText(/Create a key in DeepSeek Platform/)).toBeTruthy();
    expect(screen.getByText(/store it locally/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open DeepSeek API keys" }));

    expect(opener.openUrl).toHaveBeenCalledWith("https://platform.deepseek.com/api_keys");
  });
});
