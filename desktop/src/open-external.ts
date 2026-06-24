import { openUrl } from "@tauri-apps/plugin-opener";

export function normalizeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function openExternalUrl(value: unknown): Promise<boolean> {
  const url = normalizeExternalUrl(value);
  if (!url) return false;
  await openUrl(url);
  return true;
}
