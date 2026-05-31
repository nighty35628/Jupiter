import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
const linuxInstaller = readFileSync("install-linux.sh", "utf8");

describe("desktop release packaging", () => {
  it("publishes platform installers for the Jupiter desktop release", () => {
    expect(releaseWorkflow).toContain("tagName: ${{ steps.tag.outputs.name }}");
    expect(releaseWorkflow).toContain("releaseName: Jupiter");
    expect(releaseWorkflow).toContain("releaseDraft: false");
    expect(releaseWorkflow).toContain('label: "linux-x64"');
    expect(releaseWorkflow).toContain('bundles: "--bundles deb"');
    expect(releaseWorkflow).toContain('bundles: "--bundles dmg"');
    expect(releaseWorkflow).toContain('bundles: "--bundles nsis"');
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
});

describe("Linux installer", () => {
  it("targets the Jupiter GitHub releases and handles Debian plus Arch-family systems", () => {
    expect(linuxInstaller).toContain('REPO="${JUPITER_REPO:-nighty35628/Jupiter}"');
    expect(linuxInstaller).toContain("install_debian_deb");
    expect(linuxInstaller).toContain("install_arch_from_deb");
    expect(linuxInstaller).toMatch(/\*debian\*\|\*ubuntu\*\|\*linuxmint\*\|\*pop\*/);
    expect(linuxInstaller).toMatch(/\*arch\*\|\*endeavouros\*\|\*manjaro\*/);
  });
});
