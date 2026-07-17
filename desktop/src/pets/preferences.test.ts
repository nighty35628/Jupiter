import { describe, expect, it, vi } from "vitest";
import {
  loadDesktopPetPreferences,
  parseDesktopPetPreferences,
  saveDesktopPetPreferences,
} from "./preferences";
import { DEFAULT_PET_PREFERENCES, PET_PREFERENCES_STORAGE_KEY } from "./types";

describe("desktop pet preferences", () => {
  it("accepts namespaced ids and sanitizes invalid values", () => {
    expect(parseDesktopPetPreferences({ enabled: true, selectedId: "custom:paper-fox" })).toEqual({
      enabled: true,
      selectedId: "custom:paper-fox",
    });
    expect(parseDesktopPetPreferences({ enabled: "yes", selectedId: "../../escape" })).toEqual(
      DEFAULT_PET_PREFERENCES,
    );
  });

  it("falls back when storage is malformed and writes versioned preferences", () => {
    const malformed = { getItem: vi.fn(() => "not-json") };
    expect(loadDesktopPetPreferences(malformed)).toEqual(DEFAULT_PET_PREFERENCES);

    const setItem = vi.fn();
    saveDesktopPetPreferences({ setItem }, { enabled: true, selectedId: "builtin:companion-cube" });
    expect(setItem).toHaveBeenCalledWith(
      PET_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ enabled: true, selectedId: "builtin:companion-cube" }),
    );
  });
});
