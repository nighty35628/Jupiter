import { describe, expect, test } from "vitest";

import {
  normalizeDesktopTag,
  renderPkgbuild,
  versionFromDesktopTag,
} from "../scripts/render-arch-pkgbuild.mjs";

describe("Arch PKGBUILD rendering", () => {
  test("normalizes desktop release tags", () => {
    expect(normalizeDesktopTag("1.2.3")).toBe("desktop-v1.2.3");
    expect(normalizeDesktopTag("v1.2.3")).toBe("desktop-v1.2.3");
    expect(normalizeDesktopTag("desktop-v1.2.3")).toBe("desktop-v1.2.3");
    expect(versionFromDesktopTag("desktop-v1.2.3")).toBe("1.2.3");
  });

  test("renders a single-arch release PKGBUILD", () => {
    const text = renderPkgbuild({
      pkgver: "1.2.3",
      pkgrel: "1",
      sources: {
        x86_64: {
          url: "file:///tmp/Jupiter_desktop-v1.2.3_linux-x64.deb",
          sha256: "a".repeat(64),
        },
      },
    });

    expect(text).toContain("pkgname=jupiter-bin");
    expect(text).toContain("pkgver=1.2.3");
    expect(text).toContain("arch=('x86_64')");
    expect(text).toContain(
      'source_x86_64=("Jupiter-${pkgver}-linux-x64.deb::file:///tmp/Jupiter_desktop-v1.2.3_linux-x64.deb")',
    );
    expect(text).toContain(`sha256sums_x86_64=('${"a".repeat(64)}')`);
    expect(text).not.toContain("source_aarch64=");
  });

  test("renders the multi-arch AUR source shape", () => {
    const text = renderPkgbuild({
      pkgver: "1.2.3",
      pkgrel: "1",
      sources: {
        x86_64: {
          url: "https://github.com/nighty35628/Jupiter/releases/download/desktop-v1.2.3/Jupiter_desktop-v1.2.3_linux-x64.deb",
          sha256: "b".repeat(64),
        },
        aarch64: {
          url: "https://github.com/nighty35628/Jupiter/releases/download/desktop-v1.2.3/Jupiter_desktop-v1.2.3_linux-arm64.deb",
          sha256: "c".repeat(64),
        },
      },
    });

    expect(text).toContain("arch=('x86_64' 'aarch64')");
    expect(text).toContain("source_x86_64=");
    expect(text).toContain("source_aarch64=");
    expect(text).toContain(`sha256sums_aarch64=('${"c".repeat(64)}')`);
  });
});
