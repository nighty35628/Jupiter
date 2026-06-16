import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows installer icons", () => {
  it("uses the Jupiter application icon for NSIS installer and uninstaller executables", () => {
    const raw = readFileSync(resolve(__dirname, "../desktop/src-tauri/tauri.conf.json"), "utf8");
    const config = JSON.parse(raw) as {
      bundle?: { windows?: { nsis?: { installerIcon?: string; uninstallerIcon?: string } } };
    };

    expect(config.bundle?.windows?.nsis?.installerIcon).toBe("icons/icon.ico");
    expect(config.bundle?.windows?.nsis?.uninstallerIcon).toBe("icons/icon.ico");
  });
});
