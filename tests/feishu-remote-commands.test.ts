import { describe, expect, it } from "vitest";
import {
  feishuRemoteCommandBypassesBusy,
  feishuRemoteDesktopHelpText,
  parseFeishuRemoteDesktopCommand,
} from "../src/desktop/feishu-remote-commands.js";

describe("parseFeishuRemoteDesktopCommand", () => {
  it("parses top-level utility commands", () => {
    expect(parseFeishuRemoteDesktopCommand("/help")).toEqual({ kind: "help" });
    expect(parseFeishuRemoteDesktopCommand("/status")).toEqual({ kind: "status" });
  });

  it("parses session commands", () => {
    expect(parseFeishuRemoteDesktopCommand("/session list")).toEqual({
      kind: "session_list",
    });
    expect(parseFeishuRemoteDesktopCommand("/session switch 3")).toEqual({
      kind: "session_switch",
      target: "3",
    });
    expect(parseFeishuRemoteDesktopCommand("/session new")).toEqual({
      kind: "session_new",
    });
  });

  it("parses workspace commands", () => {
    expect(parseFeishuRemoteDesktopCommand("/workspace list")).toEqual({
      kind: "workspace_list",
    });
    expect(parseFeishuRemoteDesktopCommand("/workspace switch /tmp/demo")).toEqual({
      kind: "workspace_switch",
      target: "/tmp/demo",
    });
  });

  it("rejects incomplete or unknown commands", () => {
    expect(parseFeishuRemoteDesktopCommand("/session switch")).toBeNull();
    expect(parseFeishuRemoteDesktopCommand("/workspace switch")).toBeNull();
    expect(parseFeishuRemoteDesktopCommand("/unknown")).toBeNull();
  });
});

describe("feishuRemoteCommandBypassesBusy", () => {
  it("allows non-mutating commands while a turn is busy", () => {
    expect(feishuRemoteCommandBypassesBusy({ kind: "help" })).toBe(true);
    expect(feishuRemoteCommandBypassesBusy({ kind: "status" })).toBe(true);
    expect(feishuRemoteCommandBypassesBusy({ kind: "session_list" })).toBe(true);
    expect(feishuRemoteCommandBypassesBusy({ kind: "workspace_list" })).toBe(true);
  });

  it("blocks navigation and mutation commands while a turn is busy", () => {
    expect(feishuRemoteCommandBypassesBusy({ kind: "session_new" })).toBe(false);
    expect(feishuRemoteCommandBypassesBusy({ kind: "session_switch", target: "1" })).toBe(false);
    expect(feishuRemoteCommandBypassesBusy({ kind: "workspace_switch", target: "1" })).toBe(false);
  });
});

describe("feishuRemoteDesktopHelpText", () => {
  it("documents the lightweight command layer", () => {
    const help = feishuRemoteDesktopHelpText();

    expect(help).toContain("/session list");
    expect(help).toContain("/session switch <number|session-name>");
    expect(help).toContain("/workspace switch <number|path>");
  });
});
