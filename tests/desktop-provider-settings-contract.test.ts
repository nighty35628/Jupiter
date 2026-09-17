import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop provider settings contract", () => {
  it("reports the saved provider model instead of the active session model", () => {
    const source = readFileSync("src/cli/commands/desktop.ts", "utf8");
    const start = source.indexOf("function emitSettings(");
    const end = source.indexOf("function emitSettingsToAll(", start);
    const handler = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(handler).toContain("model: provider.model");
    expect(handler).not.toContain("model: tab.currentModel");
  });
});
