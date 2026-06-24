import { openUrl } from "@tauri-apps/plugin-opener";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeExternalUrl, openExternalUrl } from "./open-external";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

describe("openExternalUrl", () => {
  beforeEach(() => {
    vi.mocked(openUrl).mockClear();
  });

  it("opens normalized http and https URLs", async () => {
    expect(normalizeExternalUrl(" https://example.com/docs ")).toBe("https://example.com/docs");

    await expect(openExternalUrl("https://example.com/docs")).resolves.toBe(true);

    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("ignores empty, invalid, and non-web URLs", async () => {
    expect(normalizeExternalUrl("")).toBeNull();
    expect(normalizeExternalUrl("about:blank")).toBeNull();
    expect(normalizeExternalUrl("/relative/path")).toBeNull();
    expect(normalizeExternalUrl("mailto:test@example.com")).toBeNull();
    expect(normalizeExternalUrl(undefined)).toBeNull();

    await expect(openExternalUrl("")).resolves.toBe(false);
    await expect(openExternalUrl("about:blank")).resolves.toBe(false);
    await expect(openExternalUrl("not a url")).resolves.toBe(false);

    expect(openUrl).not.toHaveBeenCalled();
  });
});
