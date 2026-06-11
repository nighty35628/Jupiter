import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("desktop/src/styles.css", "utf8");
const statusbar = readFileSync("desktop/src/ui/statusbar.tsx", "utf8");

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(css);
  return match?.groups?.body ?? "";
}

describe("desktop settings status card layout", () => {
  it("moves bottom status information into the settings popover", () => {
    expect(statusbar).toContain("export function SettingsStatusCard");
    expect(statusbar).toContain("settings-card-grid");
    expect(statusbar).toContain("settings-stat-balance");
    expect(statusbar).toContain("settings-card-theme");
    expect(statusbar).toContain("settings-card-actions");
    expect(statusbar).toContain("settings-icon-action");
    expect(statusbar).toContain("settings-card-row");
    expect(statusbar).toContain("const [styleOpen, setStyleOpen] = useState(false)");
    expect(statusbar).toContain("onToggleTheme");
    expect(statusbar).toContain("styleOpen ? (");
  });

  it("removes the permanent bottom status row from the app grid", () => {
    const appRule = cssRule(".app");
    expect(appRule).toContain("grid-template-rows: 38px 34px minmax(0, 1fr) var(--bottom-height)");
    expect(appRule).toContain('"side   bottom  bottom"');
    expect(appRule).not.toContain("status status");
  });

  it("keeps the popover compact and anchored to the lower left settings area", () => {
    expect(cssRule(".settings-card-layer")).toContain("position: fixed");
    expect(cssRule(".settings-card")).toContain("bottom: 52px");
    expect(cssRule(".settings-card")).toContain("width: min(306px");
    expect(cssRule(".settings-card-grid")).toContain("repeat(2, minmax(0, 1fr))");
    expect(cssRule(".settings-card-actions")).toContain("minmax(0, 1fr) 34px 42px");
    expect(cssRule(".settings-icon-action")).toContain("height: 34px");
    expect(css).toContain(".settings-theme-option {\n  min-width: 0;");
    expect(css).toContain("grid-template-columns: 48px minmax(0, 1fr) 14px");
  });

  it("aligns the right sidebar resize guide with the context panel boundary", () => {
    expect(cssRule(".app")).toContain("grid-template-rows: 38px 34px");
    expect(cssRule(".ctx")).toContain("grid-area: ctx");
    expect(cssRule(".ctx")).toContain("border-left: 1px solid var(--border)");

    const rightHandleRule = cssRule('.resize-handle[data-side="right"]');
    expect(rightHandleRule).toContain("top: 72px");
    expect(rightHandleRule).toContain("bottom: 0");

    const rightGuideRule = cssRule('.resize-handle[data-side="right"]::after');
    expect(rightGuideRule).toContain("top: 0");
    expect(rightGuideRule).toContain("bottom: 0");
  });
});
