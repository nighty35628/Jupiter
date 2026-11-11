const LEGACY_WORKSPACE_BASENAME = "Jupiter";
const DISPLAY_WORKSPACE_BASENAME = "Jupiter";
const workspaceDisplayNames = new Map<string, string>();

export function setWorkspaceDisplayNames(items: ReadonlyArray<{ root?: string; name: string }>): void {
  workspaceDisplayNames.clear();
  for (const item of items) {
    if (typeof item.root === "string" && item.root && typeof item.name === "string" && item.name.trim())
      workspaceDisplayNames.set(item.root.replace(/[\\/]+$/, ""), item.name);
  }
}

export function displayWorkspaceBasename(path: string | undefined, fallback = "workspace"): string {
  if (!path) return fallback;
  const displayName = workspaceDisplayNames.get(path.replace(/[\\/]+$/, ""));
  if (displayName) return displayName;
  const base = path.split(/[\\/]/).filter(Boolean).pop() || fallback;
  return base === LEGACY_WORKSPACE_BASENAME ? DISPLAY_WORKSPACE_BASENAME : base;
}

export function displayWorkspacePath(path: string | undefined, fallback = ""): string {
  if (!path) return fallback;
  return path
    .split(/([\\/])/)
    .map((part) => (part === LEGACY_WORKSPACE_BASENAME ? DISPLAY_WORKSPACE_BASENAME : part))
    .join("");
}
