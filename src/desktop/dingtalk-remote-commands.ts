import {
  type QQRemoteDesktopCommand,
  parseQQRemoteDesktopCommand,
  qqRemoteCommandBypassesBusy,
  qqRemoteDesktopHelpText,
} from "./qq-remote-commands.js";

export type DingTalkRemoteDesktopCommand = QQRemoteDesktopCommand;

export function parseDingTalkRemoteDesktopCommand(
  text: string,
  skillNames: Iterable<string>,
): DingTalkRemoteDesktopCommand | null {
  return parseQQRemoteDesktopCommand(text, skillNames);
}

export function dingtalkRemoteDesktopHelpText(skillNames: Iterable<string>): string {
  return qqRemoteDesktopHelpText(skillNames).replace(
    "QQ remote desktop commands:",
    "DingTalk remote desktop commands:",
  );
}

export function dingtalkRemoteCommandBypassesBusy(cmd: DingTalkRemoteDesktopCommand): boolean {
  return qqRemoteCommandBypassesBusy(cmd);
}
