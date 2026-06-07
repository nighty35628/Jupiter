import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteSync } from "../core/atomic-write.js";
import { projectHash } from "../memory/user.js";

export type LibrarySourceKind = "web" | "file";

export interface LibrarySource {
  id: string;
  kind: LibrarySourceKind;
  title: string;
  url?: string;
  path?: string;
  snippet?: string;
  contentText?: string;
  contentFetchedAt?: number;
  contentTruncated?: boolean;
  contentError?: string;
  ingestStatus?: "pending" | "done" | "error";
  addedAt: number;
  updatedAt?: number;
}

export type LibrarySourceInput = Omit<LibrarySource, "id" | "addedAt" | "updatedAt">;

export interface LibraryStoreOptions {
  /** Override `~/.jupiter` for tests. */
  jupiterHome?: string;
}

type StoredLibrarySource = Omit<LibrarySource, "contentText"> & {
  contentFile?: string;
};

const SOURCES_FILE = "sources.json";

function defaultJupiterHome(): string {
  return join(homedir(), ".jupiter");
}

export function workspaceLibraryDir(workspaceDir: string, opts: LibraryStoreOptions = {}): string {
  return join(opts.jupiterHome ?? defaultJupiterHome(), "library", projectHash(workspaceDir));
}

function sourcesPath(workspaceDir: string, opts: LibraryStoreOptions): string {
  return join(workspaceLibraryDir(workspaceDir, opts), SOURCES_FILE);
}

function contentDir(workspaceDir: string, opts: LibraryStoreOptions): string {
  return join(workspaceLibraryDir(workspaceDir, opts), "content");
}

function sourceContentPath(
  workspaceDir: string,
  sourceId: string,
  opts: LibraryStoreOptions,
): string {
  return join(contentDir(workspaceDir, opts), `${sourceId}.txt`);
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  ensureParent(path);
  atomicWriteSync(path, `${JSON.stringify(value, null, 2)}\n`, `${path}.${randomUUID()}.tmp`);
}

function writeText(path: string, text: string): void {
  ensureParent(path);
  atomicWriteSync(path, text, `${path}.${randomUUID()}.tmp`);
}

function readStoredSources(workspaceDir: string, opts: LibraryStoreOptions): StoredLibrarySource[] {
  const path = sourcesPath(workspaceDir, opts);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StoredLibrarySource => {
      if (!item || typeof item !== "object") return false;
      const source = item as Partial<StoredLibrarySource>;
      if (typeof source.id !== "string") return false;
      if (source.kind !== "web" && source.kind !== "file") return false;
      if (typeof source.title !== "string") return false;
      if (typeof source.addedAt !== "number") return false;
      if (source.kind === "web") return typeof source.url === "string";
      return typeof source.path === "string";
    });
  } catch {
    return [];
  }
}

function writeStoredSources(
  workspaceDir: string,
  sources: StoredLibrarySource[],
  opts: LibraryStoreOptions,
): void {
  writeJson(sourcesPath(workspaceDir, opts), sources);
}

function normalizeIdentityValue(value: string | undefined): string {
  return (value ?? "").trim().replace(/\\/g, "/");
}

export function librarySourceIdentity(source: LibrarySourceInput | LibrarySource): string {
  if (source.kind === "web") return `web:${normalizeIdentityValue(source.url)}`;
  return `file:${normalizeIdentityValue(source.path)}`;
}

function hydrateSource(
  workspaceDir: string,
  source: StoredLibrarySource,
  opts: LibraryStoreOptions,
): LibrarySource {
  if (!source.contentFile) return source;
  try {
    return {
      ...source,
      contentText: readFileSync(
        join(workspaceLibraryDir(workspaceDir, opts), source.contentFile),
        "utf8",
      ),
    };
  } catch {
    return source;
  }
}

function storeContentIfPresent(
  workspaceDir: string,
  source: LibrarySourceInput,
  id: string,
  opts: LibraryStoreOptions,
): string | undefined {
  if (typeof source.contentText !== "string") return undefined;
  writeText(sourceContentPath(workspaceDir, id, opts), source.contentText);
  return `content/${id}.txt`;
}

export function listLibrarySourcesForWorkspace(
  workspaceDir: string,
  opts: LibraryStoreOptions = {},
): LibrarySource[] {
  return readStoredSources(workspaceDir, opts).map((source) =>
    hydrateSource(workspaceDir, source, opts),
  );
}

export function addLibrarySourceForWorkspace(
  workspaceDir: string,
  source: LibrarySourceInput,
  opts: LibraryStoreOptions = {},
): LibrarySource {
  const sources = readStoredSources(workspaceDir, opts);
  const identity = librarySourceIdentity(source);
  const existing = sources.find((item) => librarySourceIdentity(item) === identity);
  if (existing) return hydrateSource(workspaceDir, existing, opts);

  const now = Date.now();
  const id = randomUUID();
  const contentFile = storeContentIfPresent(workspaceDir, source, id, opts);
  const { contentText: _contentText, ...metadata } = source;
  const stored: StoredLibrarySource = {
    ...metadata,
    id,
    addedAt: now,
    updatedAt: now,
    ...(contentFile ? { contentFile } : {}),
  };
  writeStoredSources(workspaceDir, [stored, ...sources], opts);
  return hydrateSource(workspaceDir, stored, opts);
}

export function updateLibrarySourceContentForWorkspace(
  workspaceDir: string,
  sourceId: string,
  patch: Pick<
    LibrarySource,
    "contentText" | "contentFetchedAt" | "contentTruncated" | "contentError" | "ingestStatus"
  >,
  opts: LibraryStoreOptions = {},
): LibrarySource | null {
  const sources = readStoredSources(workspaceDir, opts);
  let updated: StoredLibrarySource | null = null;
  const next = sources.map((source) => {
    if (source.id !== sourceId) return source;
    let contentFile = source.contentFile;
    if (typeof patch.contentText === "string") {
      writeText(sourceContentPath(workspaceDir, sourceId, opts), patch.contentText);
      contentFile = `content/${sourceId}.txt`;
    }
    updated = {
      ...source,
      contentFetchedAt: patch.contentFetchedAt,
      contentTruncated: patch.contentTruncated,
      contentError: patch.contentError,
      ingestStatus: patch.ingestStatus,
      updatedAt: Date.now(),
      ...(contentFile ? { contentFile } : {}),
    };
    return updated;
  });
  if (!updated) return null;
  writeStoredSources(workspaceDir, next, opts);
  return hydrateSource(workspaceDir, updated, opts);
}

export function removeLibrarySourceForWorkspace(
  workspaceDir: string,
  sourceId: string,
  opts: LibraryStoreOptions = {},
): boolean {
  const sources = readStoredSources(workspaceDir, opts);
  const target = sources.find((source) => source.id === sourceId);
  if (!target) return false;
  writeStoredSources(
    workspaceDir,
    sources.filter((source) => source.id !== sourceId),
    opts,
  );
  if (target.contentFile) {
    try {
      unlinkSync(join(workspaceLibraryDir(workspaceDir, opts), target.contentFile));
    } catch {
      /* already gone */
    }
  }
  return true;
}
