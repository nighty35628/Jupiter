import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Web UI ownership", () => {
  it("renders the current Desktop app and stylesheet directly", () => {
    const entry = readFileSync("dashboard/src/main.tsx", "utf8");
    expect(entry).toContain('import { App } from "../../desktop/src/App"');
    expect(entry).toContain('import "../../desktop/src/styles.css"');
    expect(entry).toContain('from "../../desktop/src/theme"');
  });

  it("does not carry a second frontend implementation", () => {
    expect(existsSync("dashboard/src/App.tsx")).toBe(false);
    expect(existsSync("dashboard/src/styles.css")).toBe(false);
    expect(existsSync("dashboard/app.js")).toBe(false);
    expect(existsSync("dashboard/app.css")).toBe(false);
  });

  it("splits Web platform responsibilities behind a thin Tauri compatibility entrypoint", () => {
    const bridge = readFileSync("dashboard/src/lib/tauri-bridge.ts", "utf8");
    expect(bridge).toContain('from "./runtime-transport"');
    expect(bridge).toContain('from "./surface-capabilities"');
    expect(bridge).toContain('from "./shell-services"');
    expect(bridge.split("\n").length).toBeLessThan(12);

    expect(existsSync("dashboard/src/lib/runtime-transport.ts")).toBe(true);
    expect(existsSync("dashboard/src/lib/host-services.ts")).toBe(true);
    expect(existsSync("dashboard/src/lib/surface-capabilities.ts")).toBe(true);
    expect(existsSync("dashboard/src/lib/shell-services.ts")).toBe(true);
  });

  it("routes Tauri transport and shell modules to their dedicated adapters", () => {
    const viteConfig = readFileSync("dashboard/vite.config.ts", "utf8");
    expect(viteConfig).toContain(
      '"@tauri-apps/api/core": resolve(__dirname, "src/lib/tauri-bridge.ts")',
    );
    expect(viteConfig).toContain(
      '"@tauri-apps/api/event": resolve(__dirname, "src/lib/tauri-bridge.ts")',
    );
    expect(viteConfig).toContain(
      '"@tauri-apps/api/window": resolve(__dirname, "src/lib/shell-services.ts")',
    );
    expect(viteConfig).toContain(
      '"@tauri-apps/plugin-dialog": resolve(__dirname, "src/lib/shell-services.ts")',
    );
    expect(viteConfig).toContain(
      '"@tauri-apps/plugin-updater": resolve(__dirname, "src/lib/shell-services.ts")',
    );
  });

  it("initializes Web surface metadata through the capability module", () => {
    const entry = readFileSync("dashboard/src/main.tsx", "utf8");
    expect(entry).toContain('from "./lib/surface-capabilities"');
    expect(entry).toContain("initializeWebSurface();");
    const surface = readFileSync("dashboard/src/lib/surface-capabilities.ts", "utf8");
    expect(surface).toContain('dataset.nativeWindow = "false"');
  });

  it("scopes native chrome to window capability without changing OS identity", () => {
    const styles = readFileSync("desktop/src/styles.css", "utf8");
    expect(styles).toContain(
      'html[data-native-window="true"][data-platform="macos"] .titlebar .tb-left',
    );
    expect(styles).not.toMatch(/html\[data-platform="macos"\]\s+\.(app|splash|titlebar)/);
    expect(styles).toContain('html[data-window="pet-overlay"]');
    expect(styles).toContain('html:not([data-platform="macos"]) .shortcut');
    expect(readFileSync("dashboard/index.html", "utf8")).not.toContain("user-scalable=no");
  });

  it("uses layout state for drawers and main-column width for composer adaptation", () => {
    const styles = readFileSync("desktop/src/styles.css", "utf8");
    expect(styles).toContain('.app[data-web-layout="narrow"] .sidebar');
    expect(styles).toContain("@container web-main (max-width: 600px)");
    expect(styles).toContain("top: var(--web-content-top)");
    expect(styles).toContain("inset: var(--web-content-top) 0 0");
    expect(styles).not.toContain("inset: 72px 0 0");
  });

  it("keeps mobile drawer grid areas on explicit zero-width tracks", () => {
    const styles = readFileSync("desktop/src/styles.css", "utf8");
    expect(styles).toContain("grid-template-columns: 0 minmax(0, 1fr) 0;");
    expect(styles).toContain('"side main ctx"');
    expect(styles).toContain('"side bottom bottom"');
  });

  it("stacks the mobile Web composer controls without overlapping", () => {
    const styles = readFileSync("desktop/src/styles.css", "utf8");
    expect(styles).toContain('html[data-runtime="web"] .composer-foot {');
    expect(styles).toContain('"tools tools"');
    expect(styles).toContain('"model send"');
    expect(styles).toContain('html[data-runtime="web"] .composer-left-tools {');
    expect(styles).toContain("flex-wrap: wrap;");
    expect(styles).toContain('html[data-runtime="web"] .composer-foot .model-pill {');
    expect(styles).toContain("width: 100%;");
  });

  it("lets Web theme cards wrap within their available width", () => {
    const styles = readFileSync("desktop/src/styles.css", "utf8");
    expect(styles).toMatch(
      /html\[data-runtime="web"\] \.style-grid\s*\{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(min\(170px, 100%\), 1fr\)\);/,
    );
    expect(styles).toMatch(
      /html\[data-runtime="web"\] \.style-card\s*\{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/,
    );
  });

  it("does not reference or preserve deleted legacy CSS during development and builds", () => {
    const viteConfig = readFileSync("dashboard/vite.config.ts", "utf8");
    const packageManifest = readFileSync("package.json", "utf8");
    expect(viteConfig).not.toContain("/src/styles.css");
    expect(viteConfig).toContain("emptyOutDir: true");
    expect(packageManifest).not.toContain('"dashboard/app.css"');
  });
});
