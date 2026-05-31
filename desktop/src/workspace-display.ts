const LEGACY_WORKSPACE_BASENAME = "DeepSeek-Reasonix";
const DISPLAY_WORKSPACE_BASENAME = "Jupiter";

export function displayWorkspaceBasename(path: string | undefined, fallback = "workspace"): string {
  if (!path) return fallback;
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
