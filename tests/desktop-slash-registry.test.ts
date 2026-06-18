import { describe, expect, it } from "vitest";
import { DESKTOP_CLI_SLASH_COMMANDS, parseDesktopSlash } from "../desktop/src/cli-slash.js";
import { SLASH_COMMANDS } from "../src/cli/ui/slash/registry.js";

describe("desktop CLI slash registry", () => {
  it("is derived from the shared CLI slash command registry", () => {
    const sharedDesktopShape = SLASH_COMMANDS.map(({ cmd, summary, argsHint, aliases }) => ({
      cmd,
      summary,
      ...(argsHint ? { argsHint } : {}),
      ...(aliases ? { aliases } : {}),
    }));

    expect(DESKTOP_CLI_SLASH_COMMANDS).toEqual(sharedDesktopShape);
  });

  it("accepts bare undo and rewind as desktop command shortcuts", () => {
    expect(parseDesktopSlash("undo")).toEqual({ cmd: "undo", args: [] });
    expect(parseDesktopSlash("rewind")).toEqual({ cmd: "rewind", args: [] });
    expect(parseDesktopSlash("undo 2")).toEqual({ cmd: "undo", args: ["2"] });
  });
});
