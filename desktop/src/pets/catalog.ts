import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadDesktopPetPreferences, saveDesktopPetPreferences } from "./preferences";
import {
  type CustomPetScanResult,
  DEFAULT_PET_PREFERENCES,
  type DesktopPetPreferences,
  type DesktopPetUi,
  PET_DEFAULT_ID,
  type PetCatalogState,
  type PetDefinition,
} from "./types";

const BUILTIN_ATLAS_WIDTH = 768;
const BUILTIN_ATLAS_HEIGHT = 1144;
const CUSTOM_ASSET_EPOCH = Date.now().toString(36);
let customAssetRevision = 0;

function builtin(
  packageId: string,
  displayName: string,
  description: string,
  pixelated: boolean,
): PetDefinition {
  const assets: Record<
    string,
    { spriteUrl: string; thumbnailUrl: string; atlasWidth?: number; atlasHeight?: number }
  > = {
    "companion-cube": {
      spriteUrl: new URL("../assets/pets/companion-cube/spritesheet.webp", import.meta.url).href,
      thumbnailUrl: new URL("../assets/pets/companion-cube/thumbnail.webp", import.meta.url).href,
    },
    "jupiter-sprout": {
      spriteUrl: new URL("../assets/pets/jupiter-sprout/spritesheet.webp", import.meta.url).href,
      thumbnailUrl: new URL("../assets/pets/jupiter-sprout/thumbnail.webp", import.meta.url).href,
    },
    "origami-fox": {
      spriteUrl: new URL("../assets/pets/origami-fox/spritesheet.webp", import.meta.url).href,
      thumbnailUrl: new URL("../assets/pets/origami-fox/thumbnail.webp", import.meta.url).href,
    },
    cloudsmith: {
      spriteUrl: new URL("../assets/pets/cloudsmith/spritesheet.webp", import.meta.url).href,
      thumbnailUrl: new URL("../assets/pets/cloudsmith/thumbnail.webp", import.meta.url).href,
    },
    "lantern-jelly": {
      spriteUrl: new URL("../assets/pets/lantern-jelly/spritesheet.webp", import.meta.url).href,
      thumbnailUrl: new URL("../assets/pets/lantern-jelly/thumbnail.webp", import.meta.url).href,
    },
    copperwing: {
      spriteUrl: new URL("../assets/pets/copperwing/spritesheet.webp", import.meta.url).href,
      thumbnailUrl: new URL("../assets/pets/copperwing/thumbnail.webp", import.meta.url).href,
    },
    "ink-dragon": {
      spriteUrl: new URL("../assets/pets/ink-dragon/spritesheet.webp", import.meta.url).href,
      thumbnailUrl: new URL("../assets/pets/ink-dragon/thumbnail.webp", import.meta.url).href,
    },
  };
  const asset = assets[packageId];
  if (!asset) throw new Error(`missing built-in pet assets for ${packageId}`);
  return {
    id: `builtin:${packageId}`,
    packageId,
    displayName,
    description,
    source: "builtin",
    spriteUrl: asset.spriteUrl,
    thumbnailUrl: asset.thumbnailUrl,
    atlasWidth: asset.atlasWidth ?? BUILTIN_ATLAS_WIDTH,
    atlasHeight: asset.atlasHeight ?? BUILTIN_ATLAS_HEIGHT,
    pixelated,
    spriteVersionNumber: 2,
  };
}

export const BUILTIN_PETS: readonly PetDefinition[] = [
  builtin(
    "companion-cube",
    "Companion Cube",
    "A sturdy, softly pixelated companion with clear and playful reactions.",
    true,
  ),
  builtin("jupiter-sprout", "Jupiter Sprout", "A bright orbital seedling.", true),
  builtin("origami-fox", "Origami Fox", "A precise paper-folded scout.", false),
  builtin("cloudsmith", "Cloudsmith", "A tiny cloud engineer with sunny tools.", false),
  builtin("lantern-jelly", "Lantern Jelly", "A calm floating light for long sessions.", false),
  builtin("copperwing", "Copperwing", "A careful brass-and-teal mechanical beetle.", true),
  builtin("ink-dragon", "Ink Dragon", "A small graphite dragon with an emerald spark.", false),
];

function initialCatalog(): PetCatalogState {
  return {
    root: null,
    customPets: [],
    errors: [],
    loading: false,
    loaded: false,
    error: null,
  };
}

function nextCustomAssetRevision(): string {
  customAssetRevision += 1;
  return `${CUSTOM_ASSET_EPOCH}-${customAssetRevision}`;
}

function versionedAssetUrl(path: string, revision: string): string {
  const url = new URL(convertFileSrc(path));
  url.searchParams.set("v", String(revision));
  return url.href;
}

function customDefinition(
  record: CustomPetScanResult["pets"][number],
  revision: string,
): PetDefinition {
  return {
    id: `custom:${record.id}`,
    packageId: record.id,
    displayName: record.displayName,
    description: record.description ?? "Custom Jupiter pet",
    source: "custom",
    spriteUrl: versionedAssetUrl(record.spritePath, revision),
    thumbnailUrl: record.thumbnailPath
      ? versionedAssetUrl(record.thumbnailPath, revision)
      : undefined,
    atlasWidth: 1536,
    atlasHeight: 2288,
    pixelated: false,
    spriteVersionNumber: 2,
  };
}

export function resolveSelectedPet(
  selectedId: string,
  customPets: readonly PetDefinition[],
): { pet: PetDefinition; unavailable: boolean } {
  const selected = [...BUILTIN_PETS, ...customPets].find((pet) => pet.id === selectedId);
  return {
    pet: selected ?? BUILTIN_PETS.find((pet) => pet.id === PET_DEFAULT_ID) ?? BUILTIN_PETS[0]!,
    unavailable: !selected,
  };
}

export function useDesktopPets(): DesktopPetUi {
  const [preferences, setPreferences] = useState<DesktopPetPreferences>(() =>
    typeof localStorage === "undefined"
      ? DEFAULT_PET_PREFERENCES
      : loadDesktopPetPreferences(localStorage),
  );
  const [catalog, setCatalog] = useState<PetCatalogState>(initialCatalog);
  const catalogRefreshRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      saveDesktopPetPreferences(localStorage, preferences);
    }
  }, [preferences]);

  const setEnabled = useCallback((enabled: boolean) => {
    setPreferences((current) => ({ ...current, enabled }));
  }, []);
  const selectPet = useCallback((selectedId: string) => {
    setPreferences((current) => ({ ...current, selectedId }));
  }, []);

  const refreshCustomPets = useCallback(() => {
    if (catalogRefreshRef.current) return catalogRefreshRef.current;
    const task = (async () => {
      setCatalog((current) => ({ ...current, loading: true, error: null }));
      try {
        const result = await invoke<CustomPetScanResult>("pet_catalog_scan");
        const revision = nextCustomAssetRevision();
        setCatalog({
          root: result.root,
          customPets: result.pets.map((record) => customDefinition(record, revision)),
          errors: result.errors,
          loading: false,
          loaded: true,
          error: null,
        });
      } catch (error) {
        setCatalog((current) => ({
          ...current,
          loading: false,
          loaded: true,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    })();
    catalogRefreshRef.current = task;
    void task.finally(() => {
      if (catalogRefreshRef.current === task) catalogRefreshRef.current = null;
    });
    return task;
  }, []);

  const openCustomPetDirectory = useCallback(async () => {
    const root = await invoke<string>("pet_directory_prepare");
    await openPath(root);
  }, []);

  useEffect(() => {
    if (
      preferences.enabled &&
      preferences.selectedId.startsWith("custom:") &&
      !catalog.loaded &&
      !catalog.loading
    ) {
      void refreshCustomPets();
    }
  }, [
    catalog.loaded,
    catalog.loading,
    preferences.enabled,
    preferences.selectedId,
    refreshCustomPets,
  ]);

  const selected = useMemo(
    () => resolveSelectedPet(preferences.selectedId, catalog.customPets),
    [catalog.customPets, preferences.selectedId],
  );

  return useMemo(
    () => ({
      preferences,
      builtins: BUILTIN_PETS,
      catalog,
      selectedPet: selected.pet,
      selectedUnavailable: selected.unavailable,
      setEnabled,
      selectPet,
      refreshCustomPets,
      openCustomPetDirectory,
    }),
    [
      catalog,
      openCustomPetDirectory,
      preferences,
      refreshCustomPets,
      selectPet,
      selected.pet,
      selected.unavailable,
      setEnabled,
    ],
  );
}
