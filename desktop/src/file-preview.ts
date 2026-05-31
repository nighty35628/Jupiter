import { invoke } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

export type FilePreviewKind = "text" | "image" | "document" | "binary";

export type FilePreviewTarget = {
  path: string;
  line?: string;
};

export type FilePreview = {
  path: string;
  absPath: string;
  name: string;
  ext?: string | null;
  kind: FilePreviewKind;
  bytes: number;
  modifiedMs: number | null;
  text?: string | null;
  truncated: boolean;
};

export function resolveWorkspacePath(path: string, workspaceDir: string | undefined): string {
  if (!workspaceDir) return path;
  const isWindows = workspaceDir.includes("\\");
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/")) {
    return isWindows ? path.replace(/\//g, "\\") : path;
  }
  const sep = isWindows ? "\\" : "/";
  const trimmed = workspaceDir.replace(/[\\/]$/, "");
  const relative = path.replace(/^\.[\\/]/, "").replace(/\//g, sep);
  return `${trimmed}${sep}${relative}`;
}

export function firstPreviewLine(line?: string): number | undefined {
  if (!line) return undefined;
  const parsed = Number.parseInt(line.split(/[:-]/)[0] ?? line, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function readFilePreview(
  path: string,
  workspaceDir: string | undefined,
): Promise<FilePreview> {
  return invoke<FilePreview>("read_file_preview", { path, workspaceDir: workspaceDir ?? null });
}

export async function openDefaultFile(path: string, workspaceDir: string | undefined): Promise<void> {
  await openPath(resolveWorkspacePath(path, workspaceDir));
}

export async function revealFileInFolder(
  path: string,
  workspaceDir: string | undefined,
): Promise<void> {
  await revealItemInDir(resolveWorkspacePath(path, workspaceDir));
}

export async function openFileWithApp(
  path: string,
  workspaceDir: string | undefined,
  app: string,
): Promise<void> {
  const trimmed = app.trim();
  await openPath(resolveWorkspacePath(path, workspaceDir), trimmed || undefined);
}
