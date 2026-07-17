import {
  DEFAULT_PET_PREFERENCES,
  type DesktopPetPreferences,
  PET_DEFAULT_ID,
  PET_PREFERENCES_STORAGE_KEY,
} from "./types";

const PET_ID_PATTERN = /^(?:builtin|custom):[a-z0-9][a-z0-9._-]{0,63}$/;

export function parseDesktopPetPreferences(value: unknown): DesktopPetPreferences {
  if (!value || typeof value !== "object") return DEFAULT_PET_PREFERENCES;
  const candidate = value as Partial<DesktopPetPreferences>;
  return {
    enabled: candidate.enabled === true,
    selectedId:
      typeof candidate.selectedId === "string" && PET_ID_PATTERN.test(candidate.selectedId)
        ? candidate.selectedId
        : PET_DEFAULT_ID,
  };
}

export function loadDesktopPetPreferences(
  storage: Pick<Storage, "getItem">,
): DesktopPetPreferences {
  try {
    const raw = storage.getItem(PET_PREFERENCES_STORAGE_KEY);
    return raw ? parseDesktopPetPreferences(JSON.parse(raw)) : DEFAULT_PET_PREFERENCES;
  } catch {
    return DEFAULT_PET_PREFERENCES;
  }
}

export function saveDesktopPetPreferences(
  storage: Pick<Storage, "setItem">,
  preferences: DesktopPetPreferences,
): void {
  try {
    storage.setItem(PET_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Desktop appearance preferences are best-effort.
  }
}
