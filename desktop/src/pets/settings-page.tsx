import { useEffect, useState } from "react";
import { t } from "../i18n";
import { I } from "../icons";
import { PetSprite } from "./runtime";
import type { DesktopPetUi, PetDefinition } from "./types";

const BUILTIN_TEXT_KEYS: Record<string, { name: string; description: string }> = {
  "companion-cube": {
    name: "pets.companionCubeName",
    description: "pets.companionCubeDescription",
  },
  "jupiter-sprout": {
    name: "pets.jupiterSproutName",
    description: "pets.jupiterSproutDescription",
  },
  "origami-fox": {
    name: "pets.origamiFoxName",
    description: "pets.origamiFoxDescription",
  },
  cloudsmith: { name: "pets.cloudsmithName", description: "pets.cloudsmithDescription" },
  "lantern-jelly": {
    name: "pets.lanternJellyName",
    description: "pets.lanternJellyDescription",
  },
  copperwing: { name: "pets.copperwingName", description: "pets.copperwingDescription" },
  "ink-dragon": { name: "pets.inkDragonName", description: "pets.inkDragonDescription" },
};

function translatedPetName(pet: PetDefinition): string {
  const key = BUILTIN_TEXT_KEYS[pet.packageId]?.name;
  return key ? t(key as never) : pet.displayName;
}

function translatedPetDescription(pet: PetDefinition): string {
  const key = BUILTIN_TEXT_KEYS[pet.packageId]?.description;
  return key ? t(key as never) : pet.description;
}

function PetChoice({
  pet,
  selected,
  onSelect,
}: {
  pet: PetDefinition;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label className="pet-choice" data-pet={pet.packageId} data-selected={selected || undefined}>
      <input
        type="radio"
        className="pet-choice-input"
        name="desktop-pet"
        value={pet.id}
        checked={selected}
        onChange={onSelect}
      />
      <span className="pet-choice-thumb">
        {pet.thumbnailUrl ? (
          <img src={pet.thumbnailUrl} alt="" loading="lazy" decoding="async" draggable={false} />
        ) : (
          <span className="pet-choice-placeholder">{I.paw({ size: 22 })}</span>
        )}
      </span>
      <span className="pet-choice-name">{translatedPetName(pet)}</span>
      <span className="pet-choice-check" aria-hidden="true">
        {selected ? <I.check size={12} /> : null}
      </span>
    </label>
  );
}

export function PagePets({ petUi, active = true }: { petUi: DesktopPetUi; active?: boolean }) {
  const [customOpen, setCustomOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const {
    preferences,
    builtins,
    catalog,
    selectedPet,
    selectedUnavailable,
    setEnabled,
    selectPet,
    refreshCustomPets,
    openCustomPetDirectory,
  } = petUi;

  useEffect(() => {
    if (!catalog.loaded && !catalog.loading) void refreshCustomPets();
  }, [catalog.loaded, catalog.loading, refreshCustomPets]);

  const runAction = async (action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="pet-settings-page">
      <section className="section pet-enable-section">
        <div className="setting-row pet-enable-row">
          <div className="l">
            <div className="n">{t("pets.enableTitle")}</div>
            <div className="h">{t("pets.enableHint")}</div>
          </div>
          <button
            type="button"
            className="pet-toggle"
            role="switch"
            aria-label={t("pets.enableTitle")}
            aria-checked={preferences.enabled}
            data-on={preferences.enabled || undefined}
            onClick={() => setEnabled(!preferences.enabled)}
          >
            <span className="pet-toggle-label">
              {preferences.enabled ? t("pets.enabled") : t("pets.disabled")}
            </span>
            <span className="pet-toggle-track" aria-hidden="true">
              <span />
            </span>
          </button>
        </div>
      </section>

      <section className="section pet-preview-section">
        <div className="stitle">{t("pets.previewTitle")}</div>
        <div className="pet-preview-stage">
          <PetSprite
            pet={selectedPet}
            activity="idle"
            lookAround
            animationEnabled={active}
            className="pet-preview-sprite"
          />
          <div className="pet-preview-copy">
            <div className="pet-preview-name">{translatedPetName(selectedPet)}</div>
            <div className="pet-preview-description">{translatedPetDescription(selectedPet)}</div>
            {selectedUnavailable ? (
              <output className="pet-inline-warning">
                <I.warn size={13} />
                <span>{t("pets.selectedUnavailable")}</span>
              </output>
            ) : null}
          </div>
        </div>
      </section>

      <fieldset className="pet-selector-fieldset">
        <legend>{t("pets.presetsTitle")}</legend>
        <section className="section">
          <div className="pet-section-heading">
            <div>
              <div className="stitle">{t("pets.presetsTitle")}</div>
              <div className="pet-section-hint">{t("pets.presetsHint")}</div>
            </div>
          </div>
          <div className="pet-choice-grid">
            {builtins.map((pet) => (
              <PetChoice
                key={pet.id}
                pet={pet}
                selected={preferences.selectedId === pet.id}
                onSelect={() => selectPet(pet.id)}
              />
            ))}
            <button
              type="button"
              className="pet-choice pet-custom-entry"
              data-selected={preferences.selectedId.startsWith("custom:") || undefined}
              aria-expanded={customOpen}
              onClick={() => setCustomOpen((open) => !open)}
            >
              <span className="pet-choice-thumb pet-custom-thumb">{I.folder({ size: 24 })}</span>
              <span className="pet-choice-name">{t("pets.customTitle")}</span>
              <span className="pet-custom-count">{catalog.customPets.length}</span>
            </button>
          </div>
        </section>

        {customOpen ? (
          <section className="section pet-custom-section">
            <div className="pet-section-heading">
              <div>
                <div className="stitle">{t("pets.customTitle")}</div>
                <div className="pet-section-hint">{t("pets.customHint")}</div>
              </div>
              <div className="pet-directory-actions">
                <button
                  type="button"
                  className="icon-btn"
                  title={t("pets.openFolder")}
                  aria-label={t("pets.openFolder")}
                  onClick={() => void runAction(openCustomPetDirectory)}
                >
                  <I.folder size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={t("pets.refresh")}
                  aria-label={t("pets.refresh")}
                  disabled={catalog.loading}
                  onClick={() => void runAction(refreshCustomPets)}
                >
                  <I.refresh size={14} />
                </button>
              </div>
            </div>

            {catalog.root ? <div className="pet-directory-path">{catalog.root}</div> : null}
            {catalog.customPets.length > 0 ? (
              <div className="pet-choice-grid pet-custom-grid">
                {catalog.customPets.map((pet) => (
                  <PetChoice
                    key={pet.id}
                    pet={pet}
                    selected={preferences.selectedId === pet.id}
                    onSelect={() => selectPet(pet.id)}
                  />
                ))}
              </div>
            ) : catalog.loading ? (
              <div className="pet-empty-state">{t("pets.scanning")}</div>
            ) : (
              <div className="pet-empty-state">{t("pets.noCustomPets")}</div>
            )}

            {catalog.errors.length > 0 ? (
              <output className="pet-package-errors">
                {catalog.errors.map((error) => (
                  <span key={`${error.packageId}:${error.message}`}>
                    <strong>{error.packageId}</strong>
                    <span>{error.message}</span>
                  </span>
                ))}
              </output>
            ) : null}
            {catalog.error || actionError ? (
              <div className="pet-inline-warning" role="alert">
                <I.warn size={13} />
                <span>{catalog.error ?? actionError}</span>
              </div>
            ) : null}
          </section>
        ) : null}
      </fieldset>
    </div>
  );
}
