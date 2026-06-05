import { describe, expect, it } from "vitest";
import {
  buildSlashSettingsDescriptors,
  parseSlashSettingsCommand,
} from "../desktop/src/slash-settings";

describe("desktop slash settings", () => {
  it("parses reasoning effort commands", () => {
    expect(parseSlashSettingsCommand("/effort low")).toEqual({
      type: "reasoningEffort",
      reasoningEffort: "low",
    });
  });

  it("does not treat model or plan commands as permission-mode aliases", () => {
    expect(parseSlashSettingsCommand("/model auto")).toBeNull();
    expect(parseSlashSettingsCommand("/plan auto")).toBeNull();
  });

  it("does not treat bare /plan as the legacy read-only edit mode", () => {
    expect(parseSlashSettingsCommand("/plan")).toBeNull();
  });

  it("ignores unknown or incomplete setting commands", () => {
    expect(parseSlashSettingsCommand("/effort turbo")).toBeNull();
    expect(parseSlashSettingsCommand("/model")).toBeNull();
    expect(parseSlashSettingsCommand("/unknown auto")).toBeNull();
  });

  it("exposes setting commands to slash suggestions and help", () => {
    const commands = buildSlashSettingsDescriptors().map((entry) => entry.cmd);

    expect(commands).not.toContain("/model auto");
    expect(commands).not.toContain("/plan auto");
    expect(commands).not.toContain("/plan");
    expect(commands).toContain("/mode auto");
    expect(commands).toContain("/effort low");
  });
});
