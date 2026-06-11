export type QQRemoteDesktopCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "new" }
  | { kind: "abort" }
  | { kind: "compact" }
  | { kind: "retry" }
  | { kind: "session_list" }
  | { kind: "session_switch"; target: string }
  | { kind: "session_new" }
  | { kind: "workspace_list" }
  | { kind: "workspace_switch"; target: string }
  | { kind: "model"; value?: string }
  | { kind: "effort"; value?: "low" | "medium" | "high" | "max" }
  | { kind: "plan"; value?: "review" | "auto" | "yolo" }
  | { kind: "btw"; text: string }
  | { kind: "skill"; name: string; args?: string };

export function parseQQRemoteDesktopCommand(
  text: string,
  skillNames: Iterable<string>,
): QQRemoteDesktopCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  if (trimmed === "/help") return { kind: "help" };
  if (trimmed === "/status") return { kind: "status" };
  if (trimmed === "/new") return { kind: "new" };
  if (trimmed === "/abort") return { kind: "abort" };
  if (trimmed === "/compact") return { kind: "compact" };
  if (trimmed === "/retry") return { kind: "retry" };

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

  const modelMatch = /^\/model(?:\s+([\s\S]+))?$/.exec(trimmed);
  if (modelMatch) {
    const value = modelMatch[1]?.trim() ?? "";
    return { kind: "model", value: value || undefined };
  }

  const effortMatch = /^\/effort(?:\s+(low|medium|high|max))?$/i.exec(trimmed);
  if (effortMatch) {
    const value = effortMatch[1]?.trim().toLowerCase() as
      | "low"
      | "medium"
      | "high"
      | "max"
      | undefined;
    return { kind: "effort", value };
  }

  const planMatch = /^\/plan(?:\s+(review|auto|yolo))?$/i.exec(trimmed);
  if (planMatch) {
    const value = planMatch[1]?.trim().toLowerCase() as "review" | "auto" | "yolo" | undefined;
    return { kind: "plan", value };
  }

  const btwMatch = /^\/btw(?:\s+([\s\S]+))?$/.exec(trimmed);
  if (btwMatch) {
    const question = btwMatch[1]?.trim() ?? "";
    return question ? { kind: "btw", text: question } : null;
  }

  const skillMatch = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]+))?$/.exec(trimmed);
  if (!skillMatch) return null;
  const [, rawName, rawArgs] = skillMatch;
  if (!rawName) return null;
  if (
    rawName === "help" ||
    rawName === "status" ||
    rawName === "new" ||
    rawName === "abort" ||
    rawName === "compact" ||
    rawName === "retry" ||
    rawName === "session" ||
    rawName === "workspace" ||
    rawName === "model" ||
    rawName === "effort" ||
    rawName === "plan"
  ) {
    return null;
  }
  const names = new Set(skillNames);
  if (!names.has(rawName)) return null;
  const args = rawArgs?.trim() ?? "";
  return { kind: "skill", name: rawName, args: args || undefined };
}

export function qqRemoteDesktopHelpText(skillNames: Iterable<string>): string {
  const skills = [...new Set(skillNames)].sort();
  const skillHint =
    skills.length > 0 ? `\n- /<skill> [args] (available: ${skills.join(", ")})` : "";
  return [
    "QQ remote desktop commands:",
    "- /help",
    "- /status",
    "- /new",
    "- /abort",
    "- /compact",
    "- /retry",
    "- /session list",
    "- /session switch <number|session-name>",
    "- /session new",
    "- /workspace list",
    "- /workspace switch <number|path>",
    "- /model <flash|pro|deepseek-v4-flash|deepseek-v4-pro>",
    "- /effort <low|medium|high|max>",
    "- /plan <review|auto|yolo>",
    "- /btw <question>",
    `${skillHint}`.trimEnd(),
    "",
    "UI-only desktop commands stay local.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function qqRemoteCommandBypassesBusy(cmd: QQRemoteDesktopCommand): boolean {
  return (
    cmd.kind === "help" ||
    cmd.kind === "status" ||
    cmd.kind === "new" ||
    cmd.kind === "abort" ||
    cmd.kind === "effort" ||
    cmd.kind === "session_list" ||
    cmd.kind === "workspace_list"
  );
}
