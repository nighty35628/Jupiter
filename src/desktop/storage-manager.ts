import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

export type StorageCleanupTier = "safe" | "optional" | "review";
export type StorageCleanupKind = "cache" | "conversation" | "library" | "workspace" | "config";
export type StorageCleanupMode = "delete" | "none";

export interface StorageItem {
  id: string;
  tier: StorageCleanupTier;
  kind: StorageCleanupKind;
  title: string;
  description: string;
  path?: string;
  sizeBytes: number;
  cleanup: StorageCleanupMode;
}

export interface StorageScan {
  type: "$storage_scan";
  scannedAt: number;
  totalBytes: number;
  safeBytes: number;
  optionalBytes: number;
  reviewBytes: number;
  items: StorageItem[];
}

export interface StorageCleanupItemResult {
  id: string;
  title?: string;
  sizeBytes?: number;
  status: "cleaned" | "skipped" | "failed";
  error?: string;
}

export interface StorageCleanupResult {
  type: "$storage_cleanup";
  freedBytes: number;
  results: StorageCleanupItemResult[];
  scan: StorageScan;
}

export interface StorageScanOptions {
  jupiterHome?: string;
  workspaceDir?: string;
  recentWorkspaces?: readonly string[];
  now?: number;
}

export interface StorageCleanupOptions extends StorageScanOptions {
  itemIds: readonly string[];
}

function defaultJupiterHome(): string {
  return join(homedir(), ".jupiter");
}

function isWithin(parent: string, child: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function safeStatSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function pathSizeBytes(path: string, opts: { excludeNames?: readonly string[] } = {}): number {
  if (!existsSync(path)) return 0;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  const exclude = new Set(opts.excludeNames ?? []);
  let total = safeStatSize(path);
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return total;
  }
  for (const entry of entries) {
    if (exclude.has(entry)) continue;
    total += pathSizeBytes(join(path, entry), opts);
  }
  return total;
}

function workspaceId(path: string): string {
  return createHash("sha1").update(resolve(path)).digest("hex").slice(0, 12);
}

function pushIfPresent(items: StorageItem[], item: StorageItem): void {
  if (item.sizeBytes <= 0) return;
  items.push(item);
}

function sumTier(items: readonly StorageItem[], tier: StorageCleanupTier): number {
  return items.filter((item) => item.tier === tier).reduce((sum, item) => sum + item.sizeBytes, 0);
}

export function scanJupiterStorage(opts: StorageScanOptions = {}): StorageScan {
  const jupiterHome = resolve(opts.jupiterHome ?? defaultJupiterHome());
  const items: StorageItem[] = [];

  pushIfPresent(items, {
    id: "safe:jupiter-cache",
    tier: "safe",
    kind: "cache",
    title: "Jupiter cache",
    description: "Temporary Jupiter cache files that can be regenerated.",
    path: join(jupiterHome, "cache"),
    sizeBytes: pathSizeBytes(join(jupiterHome, "cache")),
    cleanup: "delete",
  });
  pushIfPresent(items, {
    id: "safe:jupiter-tmp",
    tier: "safe",
    kind: "cache",
    title: "Jupiter temporary files",
    description: "Short-lived temporary files left by previous runs.",
    path: join(jupiterHome, "tmp"),
    sizeBytes: pathSizeBytes(join(jupiterHome, "tmp")),
    cleanup: "delete",
  });
  pushIfPresent(items, {
    id: "safe:jupiter-logs",
    tier: "safe",
    kind: "cache",
    title: "Jupiter logs",
    description: "Local diagnostic logs. Removing them does not delete conversations.",
    path: join(jupiterHome, "logs"),
    sizeBytes: pathSizeBytes(join(jupiterHome, "logs")),
    cleanup: "delete",
  });
  pushIfPresent(items, {
    id: "safe:mcp-registry-cache",
    tier: "safe",
    kind: "cache",
    title: "MCP registry cache",
    description: "Cached marketplace metadata that will be fetched again when needed.",
    path: join(jupiterHome, "mcp-registry-cache.json"),
    sizeBytes: pathSizeBytes(join(jupiterHome, "mcp-registry-cache.json")),
    cleanup: "delete",
  });

  pushIfPresent(items, {
    id: "optional:archived-sessions",
    tier: "optional",
    kind: "conversation",
    title: "Archived conversations",
    description: "Conversation transcripts already moved out of the active sidebar.",
    path: join(jupiterHome, "sessions", "archive"),
    sizeBytes: pathSizeBytes(join(jupiterHome, "sessions", "archive")),
    cleanup: "delete",
  });
  pushIfPresent(items, {
    id: "optional:library-data",
    tier: "optional",
    kind: "library",
    title: "Workspace library data",
    description: "Saved library sources and extracted text. Cleaning this removes library entries.",
    path: join(jupiterHome, "library"),
    sizeBytes: pathSizeBytes(join(jupiterHome, "library")),
    cleanup: "delete",
  });

  pushIfPresent(items, {
    id: "review:active-sessions",
    tier: "review",
    kind: "conversation",
    title: "Active conversations",
    description:
      "Current conversation transcripts. Review or archive/delete them from the sidebar.",
    path: join(jupiterHome, "sessions"),
    sizeBytes: pathSizeBytes(join(jupiterHome, "sessions"), { excludeNames: ["archive"] }),
    cleanup: "none",
  });
  pushIfPresent(items, {
    id: "review:config",
    tier: "review",
    kind: "config",
    title: "Jupiter configuration",
    description: "Account, model, provider, workspace, and preference settings.",
    path: join(jupiterHome, "config.json"),
    sizeBytes: pathSizeBytes(join(jupiterHome, "config.json")),
    cleanup: "none",
  });

  const workspacePaths = new Set(
    [opts.workspaceDir, ...(opts.recentWorkspaces ?? [])].filter(
      (path): path is string => typeof path === "string" && path.length > 0,
    ),
  );
  for (const workspace of workspacePaths) {
    const metaDir = join(resolve(workspace), ".jupiter");
    pushIfPresent(items, {
      id: `review:workspace-meta:${workspaceId(metaDir)}`,
      tier: "review",
      kind: "workspace",
      title: `Workspace metadata · ${basename(workspace) || workspace}`,
      description: "Jupiter metadata inside this workspace. Open it before removing anything.",
      path: metaDir,
      sizeBytes: pathSizeBytes(metaDir),
      cleanup: "none",
    });
  }

  return {
    type: "$storage_scan",
    scannedAt: opts.now ?? Date.now(),
    totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
    safeBytes: sumTier(items, "safe"),
    optionalBytes: sumTier(items, "optional"),
    reviewBytes: sumTier(items, "review"),
    items: items.sort((a, b) => b.sizeBytes - a.sizeBytes),
  };
}

export function cleanupJupiterStorage(opts: StorageCleanupOptions): StorageCleanupResult {
  const jupiterHome = resolve(opts.jupiterHome ?? defaultJupiterHome());
  const scan = scanJupiterStorage(opts);
  const itemById = new Map(scan.items.map((item) => [item.id, item]));
  const results: StorageCleanupItemResult[] = [];
  let freedBytes = 0;

  for (const id of opts.itemIds) {
    const item = itemById.get(id);
    if (!item || item.cleanup !== "delete" || !item.path || !isWithin(jupiterHome, item.path)) {
      results.push({ id, title: item?.title, sizeBytes: item?.sizeBytes, status: "skipped" });
      continue;
    }
    try {
      rmSync(item.path, { recursive: true, force: true });
      freedBytes += item.sizeBytes;
      results.push({
        id,
        title: item.title,
        sizeBytes: item.sizeBytes,
        status: "cleaned",
      });
    } catch (err) {
      results.push({
        id,
        title: item.title,
        sizeBytes: item.sizeBytes,
        status: "failed",
        error: (err as Error).message,
      });
    }
  }

  return {
    type: "$storage_cleanup",
    freedBytes,
    results,
    scan: scanJupiterStorage(opts),
  };
}
