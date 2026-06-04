import { describe, expect, it } from "vitest";
import { DESKTOP_CLI_SLASH_COMMANDS, parseDesktopSlash } from "../desktop/src/cli-slash.js";
import { SLASH_COMMANDS } from "../src/cli/ui/slash/commands.js";

describe("desktop CLI slash registry", () => {
  it("covers every CLI slash command", () => {
    const desktop = new Set(DESKTOP_CLI_SLASH_COMMANDS.map((spec) => spec.cmd));
    const missing = SLASH_COMMANDS.map((spec) => spec.cmd).filter((cmd) => !desktop.has(cmd));

    expect(missing).toEqual([]);
  });

  it("accepts bare undo and rewind as desktop command shortcuts", () => {
    expect(parseDesktopSlash("undo")).toEqual({ cmd: "undo", args: [] });
    expect(parseDesktopSlash("rewind")).toEqual({ cmd: "rewind", args: [] });
    expect(parseDesktopSlash("undo 2")).toEqual({ cmd: "undo", args: ["2"] });
  });
});
