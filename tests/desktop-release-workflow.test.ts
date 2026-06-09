import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
const linuxInstaller = readFileSync("install-linux.sh", "utf8");
const readme = readFileSync("README.md", "utf8");
const desktopReleaseNotesPath = ".github/release-notes/desktop-v0.99.2.md";

describe("desktop release packaging", () => {
  it("publishes platform installers for the Jupiter desktop release", () => {
    expect(releaseWorkflow).toContain("tagName: ${{ steps.tag.outputs.name }}");
    expect(releaseWorkflow).toContain("releaseName: Jupiter");
    expect(releaseWorkflow).toContain("releaseDraft: false");
    expect(releaseWorkflow).toContain('"label":"linux-x64"');
    expect(releaseWorkflow).toContain('"label":"linux-arm64"');
    expect(releaseWorkflow).toContain('"label":"windows-arm64"');
    expect(releaseWorkflow).toContain("ubuntu-24.04-arm");
    expect(releaseWorkflow).toContain("aarch64-unknown-linux-gnu");
    expect(releaseWorkflow).toContain("windows-11-arm");
    expect(releaseWorkflow).toContain("aarch64-pc-windows-msvc");
    expect(releaseWorkflow).toContain('"bundles":"--bundles deb"');
    expect(releaseWorkflow).toContain('"bundles":"--bundles dmg"');
    expect(releaseWorkflow).toContain('"bundles":"--bundles nsis"');
    expect(releaseWorkflow).toContain(
      "assetNamePattern: Jupiter_${{ steps.tag.outputs.name }}_${{ matrix.target.label }}[ext]",
    );
    expect(releaseWorkflow).not.toContain("releaseAssetNamePattern");
  });

  it("supports single-target manual dispatches for release asset backfills", () => {
    expect(releaseWorkflow).toContain("target_label:");
    expect(releaseWorkflow).toContain("Resolve target matrix");
    expect(releaseWorkflow).toContain("TARGET_LABEL:");
    expect(releaseWorkflow).toContain("jq -c --arg label");
    expect(releaseWorkflow).toContain("Unknown target_label");
    expect(releaseWorkflow).toContain("fromJSON(needs.resolve-matrix.outputs.targets)");
  });

  it("verifies the bundled Node architecture for Linux packages", () => {
    expect(releaseWorkflow).toContain("Verify bundled Node matches host arch (Linux)");
    expect(releaseWorkflow).toContain("bundled_arch=");
  });

  it("verifies the bundled Node architecture for Windows packages", () => {
    expect(releaseWorkflow).toContain("Verify bundled Node matches host arch (Windows)");
    expect(releaseWorkflow).toContain("src-tauri/binaries/node.exe");
  });

  it("skips root lifecycle scripts for ARM64 targets to avoid native tree-sitter binding builds", () => {
    expect(releaseWorkflow).toContain("shell: bash");
    expect(releaseWorkflow).toContain(
      'if [ "${{ matrix.target.label }}" = "linux-arm64" ] || [ "${{ matrix.target.label }}" = "windows-arm64" ]; then',
    );
    expect(releaseWorkflow).toContain("npm ci --ignore-scripts");
    expect(releaseWorkflow).toContain("npm --prefix dashboard ci --ignore-scripts");
  });

  it("does not require Windows Authenticode signing for unsigned releases", () => {
    expect(releaseWorkflow).not.toContain("Require Windows code signing certificate");
    expect(releaseWorkflow).not.toContain("HAS_WIN_CERT");
    expect(releaseWorkflow).not.toContain("WINDOWS_CERTIFICATE");
    expect(releaseWorkflow).not.toContain("signtool.FullName sign");
    expect(releaseWorkflow).not.toContain("Verify Windows Authenticode signatures");
    expect(releaseWorkflow).toContain('"bundles":"--bundles nsis"');
  });

  it("does not require macOS signing verification for unsigned builds", () => {
    expect(releaseWorkflow).toContain(
      "if: startsWith(matrix.target.os, 'macos-') && env.HAS_APPLE_CERT == 'true'",
    );
  });

  it("documents release triggering against the Jupiter remote", () => {
    expect(releaseWorkflow).toContain("git push jupiter desktop-vX.Y.Z");
    expect(releaseWorkflow).not.toContain("git push origin desktop-vX.Y.Z");
  });

  it("requires bilingual release notes before publishing a desktop release", () => {
    expect(releaseWorkflow).toContain("release-notes:");
    expect(releaseWorkflow).toContain("needs: bundle");
    expect(releaseWorkflow).toContain(".github/release-notes/${TAG}.md");
    expect(releaseWorkflow).toContain("gh release edit");
    expect(releaseWorkflow).toContain("--notes-file");

    expect(existsSync(desktopReleaseNotesPath)).toBe(true);
    const releaseNotes = readFileSync(desktopReleaseNotesPath, "utf8");
    expect(releaseNotes).toContain("## 中文");
    expect(releaseNotes).toContain("## English");
  });
});

describe("Linux installer", () => {
  it("targets the Jupiter GitHub releases and handles Debian plus Arch-family systems", () => {
    expect(linuxInstaller).toContain('REPO="${JUPITER_REPO:-nighty35628/Jupiter}"');
    expect(linuxInstaller).toContain("install_debian_deb");
    expect(linuxInstaller).toContain("install_arch_from_deb");
    expect(linuxInstaller).toContain("deb_arch_regex");
    expect(linuxInstaller).toContain("aarch64|arm64");
    expect(linuxInstaller).toMatch(/\*debian\*\|\*ubuntu\*\|\*linuxmint\*\|\*pop\*/);
    expect(linuxInstaller).toMatch(/\*arch\*\|\*endeavouros\*\|\*manjaro\*/);
  });
});

describe("README installer guidance", () => {
  it("documents platform-specific release names, unsigned Windows, and the macOS quarantine command", () => {
    expect(readme).toContain("Jupiter_<version>_windows-x64.exe");
    expect(readme).toContain("Jupiter_<version>_windows-arm64.exe");
    expect(readme).toContain("Jupiter_<version>_macos-arm64.dmg");
    expect(readme).toContain("Jupiter_<version>_linux-arm64.deb");
    expect(readme).toContain("current Windows installers are unsigned");
    expect(readme).toContain("More info");
    expect(readme).toContain("Run anyway");
    expect(readme).toContain("sudo xattr -rd com.apple.quarantine /Applications/Jupiter.app");
  });
});
