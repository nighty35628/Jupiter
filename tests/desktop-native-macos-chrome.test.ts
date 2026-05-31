import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const macConfig = JSON.parse(readFileSync("desktop/src-tauri/tauri.macos.conf.json", "utf8"));
const app = readFileSync("desktop/src/App.tsx", "utf8");
const css = readFileSync("desktop/src/styles.css", "utf8");

describe("desktop macOS native window chrome", () => {
  it("uses system traffic lights instead of custom mac controls", () => {
    const win = macConfig.app.windows[0];

    expect(win.decorations).toBe(true);
    expect(win.titleBarStyle).toBe("Overlay");
    expect(win.hiddenTitle).toBe(true);
    expect(app).not.toContain("mac-controls");
    expect(app).not.toContain("mac-ctrl");
    expect(css).not.toContain(".mac-controls");
    expect(css).not.toContain(".mac-ctrl");
  });
});
