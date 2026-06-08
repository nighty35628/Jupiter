export type FeishuRemoteDesktopCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "session_list" }
  | { kind: "session_switch"; target: string }
  | { kind: "session_new" }
  | { kind: "workspace_list" }
  | { kind: "workspace_switch"; target: string };

export function parseFeishuRemoteDesktopCommand(text: string): FeishuRemoteDesktopCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  if (trimmed === "/help") return { kind: "help" };
  if (trimmed === "/status") return { kind: "status" };

  const sessionMatch = /^\/session\s+(list|new|switch)(?:\s+([\s\S]+))?$/i.exec(trimmed);
  if (sessionMatch) {
    const action = sessionMatch[1]?.toLowerCase();
    const target = sessionMatch[2]?.trim() ?? "";
    if (action === "list") return { kind: "session_list" };
    if (action === "new") return { kind: "session_new" };
    if (action === "switch" && target) return { kind: "session_switch", target };
    return null;
  }

  const workspaceMatch = /^\/workspace\s+(list|switch)(?:\s+([\s\S]+))?$/i.exec(trimmed);
  if (workspaceMatch) {
    const action = workspaceMatch[1]?.toLowerCase();
    const target = workspaceMatch[2]?.trim() ?? "";
    if (action === "list") return { kind: "workspace_list" };
    if (action === "switch" && target) return { kind: "workspace_switch", target };
    return null;
  }

  return null;
}

export function feishuRemoteDesktopHelpText(): string {
  return [
    "Feishu remote desktop commands:",
    "- /help",
    "- /status",
    "- /session list",
    "- /session switch <number|session-name>",
    "- /session new",
    "- /workspace list",
    "- /workspace switch <number|path>",
    "",
    "Numbers refer to the latest list shown in Feishu.",
  ].join("\n");
}

export function feishuRemoteCommandBypassesBusy(cmd: FeishuRemoteDesktopCommand): boolean {
  return (
    cmd.kind === "help" ||
    cmd.kind === "status" ||
    cmd.kind === "session_list" ||
    cmd.kind === "workspace_list"
  );
}
