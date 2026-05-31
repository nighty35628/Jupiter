import { describe, expect, it, vi } from "vitest";
import {
  checkJupiterUpdate,
  jupiterUpdatesEnabled,
  parseJupiterUpdatesEnabled,
} from "./update-policy";

const mocks = vi.hoisted(() => ({
  updaterCheck: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mocks.updaterCheck,
}));

describe("Jupiter update policy", () => {
  it("keeps updates disabled unless Jupiter explicitly enables its own channel", () => {
    expect(jupiterUpdatesEnabled()).toBe(false);
    expect(parseJupiterUpdatesEnabled(undefined)).toBe(false);
    expect(parseJupiterUpdatesEnabled("0")).toBe(false);
    expect(parseJupiterUpdatesEnabled("1")).toBe(true);
    expect(parseJupiterUpdatesEnabled("true")).toBe(true);
  });

  it("does not call the Tauri updater while Jupiter has no configured channel", async () => {
    await expect(checkJupiterUpdate()).resolves.toBeNull();
    expect(mocks.updaterCheck).not.toHaveBeenCalled();
  });
});
