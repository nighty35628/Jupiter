import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const MENTION_PATH_RE = /^[\p{L}\p{N}_./\\-]+$/u;

export function convertPastedPathsToMentions(content: string, rootDir: string): string | null {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const mentions: string[] = [];
  for (const line of lines) {
    const path = parsePastedPath(line);
    if (!path) return null;
    const absolute = isAbsolute(path) ? resolve(path) : resolve(rootDir, path);
    const rel = relative(rootDir, absolute).replace(/\\/g, "/");
    if (!rel || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) return null;
    if (!MENTION_PATH_RE.test(rel)) return null;
    if (!existsSync(absolute)) return null;
    mentions.push(`@${rel}`);
  }

  return mentions.join(" ");
}

function parsePastedPath(line: string): string | null {
  const unquoted = stripMatchingQuotes(line.trim());
  if (unquoted.startsWith("file://")) return fileUrlToPath(unquoted);
  if (isAbsolute(unquoted) || /^[A-Za-z]:[\\/]/.test(unquoted)) return unquoted;
  if (/^[\p{L}\p{N}_./\\-]+$/u.test(unquoted)) return unquoted;
  return null;
}

function fileUrlToPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const decodedPath = decodeURIComponent(url.pathname);
    if (decodedPath.startsWith("/.file/id=")) return null;
    if (url.hostname) return `//${url.hostname}${decodedPath}`;
    return decodedPath.replace(/^\/([A-Za-z]:\/)/, "$1");
  } catch {
    return null;
  }
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}
