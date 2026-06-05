import type { EditMode, ReasoningEffort } from "./protocol";

const SLASH_MODE_ALIASES = {
  ask: "review",
  review: "review",
  auto: "auto",
  full: "yolo",
  yolo: "yolo",
} as const satisfies Readonly<Record<string, Exclude<EditMode, "plan">>>;

const SLASH_MODE_DESCRIPTORS = [
  { cmd: "/mode ask", editMode: "review" },
  { cmd: "/mode auto", editMode: "auto" },
  { cmd: "/mode full", editMode: "yolo" },
] as const satisfies readonly { cmd: string; editMode: EditMode }[];

export const SLASH_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "max",
] as const satisfies readonly ReasoningEffort[];

export type SlashSettingsCommand =
  | { type: "editMode"; editMode: EditMode }
  | { type: "reasoningEffort"; reasoningEffort: ReasoningEffort };

export type SlashSettingsDescriptor = {
  cmd: string;
  action: SlashSettingsCommand;
};

function parseEditMode(value: string): EditMode | null {
  return SLASH_MODE_ALIASES[value as keyof typeof SLASH_MODE_ALIASES] ?? null;
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return (SLASH_REASONING_EFFORTS as readonly string[]).includes(value);
}

export function parseSlashSettingsCommand(input: string): SlashSettingsCommand | null {
  const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([^\s]+))?$/.exec(input.trim());
  if (!match) return null;

  const name = match[1]?.toLowerCase();
  const arg = match[2]?.toLowerCase();

  if (name === "effort") {
    if (arg && isReasoningEffort(arg)) return { type: "reasoningEffort", reasoningEffort: arg };
    return null;
  }

  if (name === "mode" && arg) {
    const editMode = parseEditMode(arg);
    if (editMode) return { type: "editMode", editMode };
  }

  return null;
}

export function buildSlashSettingsDescriptors(): SlashSettingsDescriptor[] {
  const modeCommands = SLASH_MODE_DESCRIPTORS.map(({ cmd, editMode }) => ({
    cmd,
    action: { type: "editMode", editMode } as const,
  }));
  const effortCommands = SLASH_REASONING_EFFORTS.map((effort) => ({
    cmd: `/effort ${effort}`,
    action: { type: "reasoningEffort", reasoningEffort: effort } as const,
  }));

  return [...modeCommands, ...effortCommands];
}
