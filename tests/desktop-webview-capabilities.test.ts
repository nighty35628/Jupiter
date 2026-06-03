import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function loadPermissions(): string[] {
  const confPath = resolve(__dirname, "../desktop/src-tauri/capabilities/default.json");
  const raw = readFileSync(confPath, "utf8");
  const conf = JSON.parse(raw) as { permissions?: Array<string | { identifier?: string }> };
  return (conf.permissions ?? []).map((permission) =>
    typeof permission === "string" ? permission : (permission.identifier ?? ""),
  );
}

describe("desktop webview capabilities", () => {
  const permissions = loadPermissions();

  it("allows creating and managing the sidebar browser webview", () => {
    expect(permissions).toContain("core:webview:allow-create-webview");
    expect(permissions).toContain("core:webview:allow-webview-close");
    expect(permissions).toContain("core:webview:allow-webview-hide");
    expect(permissions).toContain("core:webview:allow-webview-show");
    expect(permissions).toContain("core:webview:allow-set-webview-position");
    expect(permissions).toContain("core:webview:allow-set-webview-size");
  });
});
