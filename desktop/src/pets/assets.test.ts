import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_PETS } from "./catalog";

function uint24le(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function webpDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (payload + size > bytes.length) break;
    if (kind === "VP8X" && size >= 10) {
      return {
        width: uint24le(bytes, payload + 4) + 1,
        height: uint24le(bytes, payload + 7) + 1,
      };
    }
    if (
      kind === "VP8 " &&
      size >= 10 &&
      bytes.subarray(payload + 3, payload + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    ) {
      return {
        width: bytes.readUInt16LE(payload + 6) & 0x3fff,
        height: bytes.readUInt16LE(payload + 8) & 0x3fff,
      };
    }
    if (kind === "VP8L" && size >= 5 && bytes[payload] === 0x2f) {
      const bits = bytes.readUInt32LE(payload + 1);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    offset = payload + size + (size % 2);
  }
  throw new Error(`could not read WebP dimensions: ${path}`);
}

describe("built-in pet assets", () => {
  it.each(BUILTIN_PETS)("packages $packageId with the v2 built-in contract", (pet) => {
    const root = new URL(`../assets/pets/${pet.packageId}/`, import.meta.url);
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("pet.json", root)), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest.id).toBe(pet.packageId);
    expect(manifest.spriteVersionNumber).toBe(2);
    expect(webpDimensions(fileURLToPath(new URL("spritesheet.webp", root)))).toEqual({
      width: pet.atlasWidth,
      height: pet.atlasHeight,
    });
    expect(webpDimensions(fileURLToPath(new URL("thumbnail.webp", root)))).toEqual({
      width: 128,
      height: 128,
    });
    expect(readFileSync(fileURLToPath(new URL("PROVENANCE.md", root)), "utf8").trim()).not.toBe("");
  });
});

describe("custom pet asset isolation", () => {
  it("keeps the static scope empty and grants one process-private validated cache root", () => {
    const config = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../src-tauri/tauri.conf.json", import.meta.url)),
        "utf8",
      ),
    ) as { app: { security: { assetProtocol: { scope: string[] } } } };
    const scanner = readFileSync(
      fileURLToPath(new URL("../../src-tauri/src/pets.rs", import.meta.url)),
      "utf8",
    );

    expect(config.app.security.assetProtocol.scope).toEqual([]);
    expect(scanner).toContain("asset_protocol_scope");
    expect(scanner).toContain(".allow_directory(");
    expect(scanner).not.toContain(".allow_file(");
    expect(scanner).toContain('join("pet-assets-v2")');
    expect(scanner).toContain("cache_validated_asset");
  });
});
