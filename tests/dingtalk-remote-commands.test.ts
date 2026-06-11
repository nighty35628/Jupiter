import { describe, expect, it } from "vitest";
import {
  dingtalkRemoteCommandBypassesBusy,
  dingtalkRemoteDesktopHelpText,
  parseDingTalkRemoteDesktopCommand,
} from "../src/desktop/dingtalk-remote-commands.js";

describe("desktop DingTalk remote commands", () => {
  const skills = ["agent-reach"];

  it("parses the shared lightweight remote command layer", () => {
    expect(parseDingTalkRemoteDesktopCommand("/help", skills)).toEqual({ kind: "help" });
    expect(parseDingTalkRemoteDesktopCommand("/status", skills)).toEqual({ kind: "status" });
    expect(parseDingTalkRemoteDesktopCommand("/session list", skills)).toEqual({
      kind: "session_list",
    });
    expect(parseDingTalkRemoteDesktopCommand("/workspace switch /tmp/demo", skills)).toEqual({
      kind: "workspace_switch",
      target: "/tmp/demo",
    });
    expect(parseDingTalkRemoteDesktopCommand("/model flash", skills)).toEqual({
      kind: "model",
      value: "flash",
    });
    expect(parseDingTalkRemoteDesktopCommand("/agent-reach news", skills)).toEqual({
      kind: "skill",
      name: "agent-reach",
      args: "news",
    });
  });

  it("uses QQ-compatible busy bypass rules", () => {
    expect(dingtalkRemoteCommandBypassesBusy({ kind: "help" })).toBe(true);
    expect(dingtalkRemoteCommandBypassesBusy({ kind: "status" })).toBe(true);
    expect(dingtalkRemoteCommandBypassesBusy({ kind: "session_list" })).toBe(true);
    expect(dingtalkRemoteCommandBypassesBusy({ kind: "model", value: "flash" })).toBe(false);
  });

  it("documents the DingTalk command names", () => {
    const help = dingtalkRemoteDesktopHelpText(skills);

    expect(help).toContain("DingTalk remote desktop commands:");
    expect(help).toContain("/session list");
    expect(help).toContain("/workspace switch <number|path>");
    expect(help).toContain("/<skill> [args]");
  });
});
