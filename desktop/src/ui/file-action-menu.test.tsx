import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));

import { positionFileActionMenu } from "./file-action-menu";

describe("positionFileActionMenu", () => {
  it("keeps the menu inside the viewport when opened near the right edge", () => {
    expect(
      positionFileActionMenu(
        { left: 610, top: 40 },
        { width: 236, height: 180 },
        { width: 640, height: 480 },
      ),
    ).toEqual({ left: 396, top: 40 });
  });

  it("keeps the menu inside the viewport when opened near the bottom edge", () => {
    expect(
      positionFileActionMenu(
        { left: 120, top: 460 },
        { width: 236, height: 180 },
        { width: 640, height: 480 },
      ),
    ).toEqual({ left: 120, top: 292 });
  });
});
