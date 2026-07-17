// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
  invoke: tauri.invoke,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));

import { BUILTIN_PETS, resolveSelectedPet, useDesktopPets } from "./catalog";

beforeEach(() => {
  localStorage.clear();
  tauri.invoke.mockReset();
});
afterEach(cleanup);

describe("pet catalog selection", () => {
  it("ships the Companion Cube as a lightweight softly pixelated atlas", () => {
    expect(BUILTIN_PETS[0]).toMatchObject({
      id: "builtin:companion-cube",
      atlasWidth: 768,
      atlasHeight: 1144,
      pixelated: true,
    });
  });

  it("resolves built-ins and temporarily falls back without changing the selected id", () => {
    expect(resolveSelectedPet("builtin:ink-dragon", []).pet.packageId).toBe("ink-dragon");
    const missing = resolveSelectedPet("custom:missing", []);
    expect(missing.unavailable).toBe(true);
    expect(missing.pet).toBe(BUILTIN_PETS[0]);
  });

  it("merges rapid enable and selection updates without losing either preference", () => {
    const view = renderHook(() => useDesktopPets());

    act(() => {
      view.result.current.setEnabled(true);
      view.result.current.selectPet("builtin:ink-dragon");
    });

    expect(view.result.current.preferences).toEqual({
      enabled: true,
      selectedId: "builtin:ink-dragon",
    });
  });

  it("cache-busts custom pet assets every time the directory is refreshed", async () => {
    tauri.invoke.mockResolvedValue({
      root: "/home/test/.jupiter/pets",
      pets: [
        {
          id: "qa-cube",
          displayName: "QA Cube",
          spriteVersionNumber: 2,
          spritePath: "/home/test/.jupiter/pets/qa-cube/spritesheet.webp",
          thumbnailPath: "/home/test/.jupiter/pets/qa-cube/thumbnail.webp",
        },
      ],
      errors: [],
    });
    const view = renderHook(() => useDesktopPets());

    await act(async () => view.result.current.refreshCustomPets());
    const first = view.result.current.catalog.customPets[0];
    const firstVersion = new URL(first!.spriteUrl).searchParams.get("v");
    expect(firstVersion).toBeTruthy();
    expect(new URL(first!.thumbnailUrl!).searchParams.get("v")).toBe(firstVersion);

    await act(async () => view.result.current.refreshCustomPets());
    const second = view.result.current.catalog.customPets[0];
    expect(new URL(second!.spriteUrl).searchParams.get("v")).not.toBe(firstVersion);
    expect(second?.spriteUrl).not.toBe(first?.spriteUrl);
  });

  it("keeps the last valid custom catalog when a later scan fails", async () => {
    tauri.invoke.mockResolvedValueOnce({
      root: "/home/test/.jupiter/pets",
      pets: [
        {
          id: "qa-cube",
          displayName: "QA Cube",
          spriteVersionNumber: 2,
          spritePath: "/home/test/.jupiter/pets/qa-cube/spritesheet.webp",
        },
      ],
      errors: [],
    });
    const view = renderHook(() => useDesktopPets());
    await act(async () => view.result.current.refreshCustomPets());
    const lastGoodPet = view.result.current.catalog.customPets[0];

    tauri.invoke.mockRejectedValueOnce(new Error("scan failed"));
    await act(async () => view.result.current.refreshCustomPets());

    expect(view.result.current.catalog.customPets[0]).toBe(lastGoodPet);
    expect(view.result.current.catalog.error).toBe("scan failed");
    expect(view.result.current.catalog.loaded).toBe(true);
    expect(view.result.current.catalog.loading).toBe(false);
  });

  it("uses a new asset revision after the pet hook remounts", async () => {
    tauri.invoke.mockResolvedValue({
      root: "/home/test/.jupiter/pets",
      pets: [
        {
          id: "qa-cube",
          displayName: "QA Cube",
          spriteVersionNumber: 2,
          spritePath: "/cache/content-hash.webp",
        },
      ],
      errors: [],
    });
    const firstView = renderHook(() => useDesktopPets());
    await act(async () => firstView.result.current.refreshCustomPets());
    const firstUrl = firstView.result.current.catalog.customPets[0]!.spriteUrl;
    firstView.unmount();

    const secondView = renderHook(() => useDesktopPets());
    await act(async () => secondView.result.current.refreshCustomPets());
    const secondUrl = secondView.result.current.catalog.customPets[0]!.spriteUrl;
    expect(secondUrl).not.toBe(firstUrl);
  });

  it("coalesces concurrent refreshes so the native busy guard cannot replace a valid scan", async () => {
    let resolveScan!: (value: unknown) => void;
    tauri.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        }),
    );
    const view = renderHook(() => useDesktopPets());

    let firstRefresh!: Promise<void>;
    let duplicateRefresh!: Promise<void>;
    act(() => {
      firstRefresh = view.result.current.refreshCustomPets();
      duplicateRefresh = view.result.current.refreshCustomPets();
    });
    expect(duplicateRefresh).toBe(firstRefresh);
    expect(tauri.invoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveScan({
        root: "/home/test/.jupiter/pets",
        pets: [
          {
            id: "new-pet",
            displayName: "New Pet",
            spriteVersionNumber: 2,
            spritePath: "/home/test/.jupiter/pets/new-pet/spritesheet.webp",
          },
        ],
        errors: [],
      });
      await Promise.all([firstRefresh, duplicateRefresh]);
    });

    expect(view.result.current.catalog.customPets.map((pet) => pet.packageId)).toEqual(["new-pet"]);
    expect(
      new URL(view.result.current.catalog.customPets[0]!.spriteUrl).searchParams.get("v"),
    ).toBeTruthy();
  });
});
