// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_PETS } from "./catalog";
import { PagePets } from "./settings-page";
import type { DesktopPetUi, PetDefinition } from "./types";

vi.mock("./runtime", () => ({
  PetSprite: ({ pet, animationEnabled }: { pet: PetDefinition; animationEnabled: boolean }) => (
    <span data-testid="animated-preview" data-id={pet.id} data-active={animationEnabled} />
  ),
}));

afterEach(cleanup);

function ui(selectedPet: PetDefinition = BUILTIN_PETS[0]!): DesktopPetUi {
  return {
    preferences: { enabled: false, selectedId: selectedPet.id },
    builtins: BUILTIN_PETS,
    catalog: { root: null, customPets: [], errors: [], loading: false, loaded: true, error: null },
    selectedPet,
    selectedUnavailable: false,
    setEnabled: vi.fn(),
    selectPet: vi.fn(),
    refreshCustomPets: vi.fn(async () => undefined),
    openCustomPetDirectory: vi.fn(async () => undefined),
  };
}

describe("pet settings portrait", { retry: 0 }, () => {
  it("uses a separate high-density portrait for the Companion Cube, not an enlarged atlas frame", () => {
    const view = render(<PagePets petUi={ui()} />);
    const image = view.container.querySelector<HTMLImageElement>(".pet-preview-portrait");
    expect(image).not.toBeNull();
    expect(image!.getAttribute("src")).toBe(BUILTIN_PETS[0]!.previewUrl);
    expect(image!.getAttribute("src")).toContain("preview.webp");
    expect(view.queryByTestId("animated-preview")).toBeNull();
  });

  it("preserves other presets' animated preview and pause behavior", () => {
    const view = render(<PagePets petUi={ui(BUILTIN_PETS[1]!)} active={false} />);
    expect(view.container.querySelector(".pet-preview-portrait")).toBeNull();
    expect(view.getByTestId("animated-preview").dataset.active).toBe("false");
    view.rerender(<PagePets petUi={ui(BUILTIN_PETS[1]!)} active />);
    expect(view.getByTestId("animated-preview").dataset.active).toBe("true");
  });

  it("falls back on image failure and resets the fallback for a different portrait", () => {
    const view = render(<PagePets petUi={ui()} />);
    fireEvent.error(view.container.querySelector(".pet-preview-portrait")!);
    expect(view.container.querySelector(".pet-preview-portrait")).toBeNull();
    expect(view.getByTestId("animated-preview").dataset.id).toBe(BUILTIN_PETS[0]!.id);
    const refreshed = { ...BUILTIN_PETS[0]!, previewUrl: "/portrait-new.webp" };
    view.rerender(<PagePets petUi={ui(refreshed)} />);
    expect(view.container.querySelector(".pet-preview-portrait")!.getAttribute("src")).toBe(
      "/portrait-new.webp",
    );
  });

  it("keeps custom pets on their existing animation contract", () => {
    const custom: PetDefinition = {
      ...BUILTIN_PETS[1]!,
      id: "custom:companion-cube",
      packageId: "companion-cube",
      source: "custom",
    };
    const view = render(<PagePets petUi={ui(custom)} />);
    expect(view.container.querySelector(".pet-preview-portrait")).toBeNull();
    expect(view.getByTestId("animated-preview").dataset.id).toBe(custom.id);
    view.rerender(<PagePets petUi={ui()} />);
    expect(view.container.querySelector(".pet-preview-portrait")).not.toBeNull();
  });
});
