import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

export type JupiterUpdate = Update;
export type JupiterDownloadEvent = DownloadEvent;

export function parseJupiterUpdatesEnabled(value: unknown): boolean {
  return value === "1" || value === "true";
}

export function jupiterUpdatesEnabled(): boolean {
  const env = import.meta.env as Record<string, string | boolean | undefined>;
  return parseJupiterUpdatesEnabled(env.VITE_JUPITER_UPDATES);
}

export async function checkJupiterUpdate(): Promise<JupiterUpdate | null> {
  if (!jupiterUpdatesEnabled()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  return check();
}

export async function installJupiterUpdate(
  update: JupiterUpdate,
  onEvent: (event: JupiterDownloadEvent) => void,
): Promise<void> {
  if (!jupiterUpdatesEnabled()) {
    throw new Error("Jupiter update channel is not configured");
  }
  await update.downloadAndInstall(onEvent);
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
