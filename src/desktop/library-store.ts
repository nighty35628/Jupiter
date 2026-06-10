import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { parse as parseHtml } from "node-html-parser";
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

export interface LibrarySearchHit {
  sourceId: string;
  chunkId?: string;
  kind: LibrarySourceKind;
  title: string;
  url?: string;
  path?: string;
  snippet?: string;
  score: number;
  text: string;
  ingestStatus?: LibrarySource["ingestStatus"];
  contentTruncated?: boolean;
  contentError?: string;
}

export interface LibrarySearchResult {
  query: string;
  results: LibrarySearchHit[];
}

export interface LibraryReadResult {
  sourceId: string;
  chunkId?: string;
  kind: LibrarySourceKind;
  title: string;
  url?: string;
  path?: string;
  text: string;
  contentTruncated?: boolean;
  contentError?: string;
}

type StoredLibrarySource = Omit<LibrarySource, "contentText"> & {
  contentFile?: string;
};

const SOURCES_FILE = "sources.json";
const DEFAULT_LIBRARY_CHUNK_CHARS = 2_400;
const DEFAULT_LIBRARY_READ_CHARS = 12_000;
const DEFAULT_LIBRARY_SEARCH_TOP_K = 6;
const DEFAULT_LIBRARY_EXTRACT_MAX_BYTES = 1024 * 1024;
const DEFAULT_LIBRARY_EXTRACT_MAX_CHARS = 64_000;

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

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function chunkText(sourceId: string, text: string, chunkChars = DEFAULT_LIBRARY_CHUNK_CHARS) {
  const chunks: Array<{ chunkId: string; index: number; text: string }> = [];
  const normalized = text.trim();
  if (!normalized) return chunks;
  for (let start = 0, index = 0; start < normalized.length; start += chunkChars, index++) {
    chunks.push({
      chunkId: `${sourceId}:${index}`,
      index,
      text: normalized.slice(start, start + chunkChars),
    });
  }
  return chunks;
}

function scoreText(text: string, terms: string[], weight: number): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const first = haystack.indexOf(term);
    if (first < 0) continue;
    score += weight;
    let pos = haystack.indexOf(term, first + term.length);
    while (pos >= 0) {
      score += weight * 0.35;
      pos += term.length;
      pos = haystack.indexOf(term, pos);
    }
  }
  return score;
}

function excerptForTerms(text: string, terms: string[], maxChars = 420): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  const lower = normalized.toLowerCase();
  const firstHit = terms
    .map((term) => lower.indexOf(term))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max(0, (firstHit ?? 0) - 120);
  const end = Math.min(normalized.length, start + maxChars);
  return `${start > 0 ? "..." : ""}${normalized.slice(start, end)}${
    end < normalized.length ? "..." : ""
  }`;
}

export function searchLibrarySourcesForWorkspace(
  workspaceDir: string,
  opts: LibraryStoreOptions & {
    query: string;
    topK?: number;
    kind?: LibrarySourceKind;
    chunkChars?: number;
  },
): LibrarySearchResult {
  const query = opts.query.trim();
  const terms = tokenize(query);
  if (!query || terms.length === 0) return { query, results: [] };
  const hits: LibrarySearchHit[] = [];
  for (const source of listLibrarySourcesForWorkspace(workspaceDir, opts)) {
    if (opts.kind && source.kind !== opts.kind) continue;
    const metadataText = [source.title, source.url, source.path, source.snippet]
      .filter(Boolean)
      .join("\n");
    const metadataScore =
      scoreText(source.title, terms, 8) +
      scoreText(source.snippet ?? "", terms, 4) +
      scoreText(`${source.url ?? ""}\n${source.path ?? ""}`, terms, 2);
    const chunks = chunkText(source.id, source.contentText ?? "", opts.chunkChars);
    if (chunks.length === 0) {
      if (metadataScore <= 0) continue;
      hits.push({
        sourceId: source.id,
        kind: source.kind,
        title: source.title,
        url: source.url,
        path: source.path,
        snippet: source.snippet,
        score: Number(metadataScore.toFixed(2)),
        text: excerptForTerms(metadataText, terms),
        ingestStatus: source.ingestStatus,
        contentTruncated: source.contentTruncated,
        contentError: source.contentError,
      });
      continue;
    }
    for (const chunk of chunks) {
      const contentScore = scoreText(chunk.text, terms, 1);
      const score = metadataScore + contentScore;
      if (score <= 0) continue;
      hits.push({
        sourceId: source.id,
        chunkId: chunk.chunkId,
        kind: source.kind,
        title: source.title,
        url: source.url,
        path: source.path,
        snippet: source.snippet,
        score: Number(score.toFixed(2)),
        text: excerptForTerms(chunk.text, terms),
        ingestStatus: source.ingestStatus,
        contentTruncated: source.contentTruncated,
        contentError: source.contentError,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return { query, results: hits.slice(0, opts.topK ?? DEFAULT_LIBRARY_SEARCH_TOP_K) };
}

export function readLibrarySourceForWorkspace(
  workspaceDir: string,
  opts: LibraryStoreOptions & {
    sourceId: string;
    chunkId?: string;
    maxChars?: number;
    chunkChars?: number;
  },
): LibraryReadResult {
  const source = listLibrarySourcesForWorkspace(workspaceDir, opts).find(
    (item) => item.id === opts.sourceId,
  );
  if (!source) throw new Error(`library source not found: ${opts.sourceId}`);
  const maxChars = opts.maxChars ?? DEFAULT_LIBRARY_READ_CHARS;
  let text = source.contentText ?? "";
  const chunkId = opts.chunkId;
  if (chunkId) {
    const chunk = chunkText(source.id, text, opts.chunkChars).find(
      (item) => item.chunkId === chunkId,
    );
    if (!chunk) throw new Error(`library chunk not found: ${chunkId}`);
    text = chunk.text;
  } else if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
  }
  if (!text.trim()) {
    throw new Error(
      `library source has no extracted content: ${source.title}${
        source.contentError ? ` (${source.contentError})` : ""
      }`,
    );
  }
  return {
    sourceId: source.id,
    chunkId,
    kind: source.kind,
    title: source.title,
    url: source.url,
    path: source.path,
    text,
    contentTruncated: source.contentTruncated,
    contentError: source.contentError,
  };
}

function hasNulByte(buf: Buffer): boolean {
  const end = Math.min(buf.length, 8192);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function readFilePrefix(path: string, maxBytes: number): { buffer: Buffer; truncated: boolean } {
  const stat = statSync(path);
  const size = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(size);
  const fd = openSync(path, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, size, 0);
    return { buffer: buffer.subarray(0, bytesRead), truncated: stat.size > maxBytes };
  } finally {
    closeSync(fd);
  }
}

function normalizeExtractedText(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function textFromHtml(html: string): string {
  const root = parseHtml(html);
  for (const node of root.querySelectorAll("script,style,noscript")) {
    node.remove();
  }
  return normalizeExtractedText(root.structuredText || root.text);
}

function extractTextByExtension(path: string, raw: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".html" || ext === ".htm") return textFromHtml(raw);
  if (ext === ".json") {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return normalizeExtractedText(raw);
    }
  }
  return normalizeExtractedText(raw);
}

export function extractLibraryFileContentForWorkspace(
  workspaceDir: string,
  sourceId: string,
  opts: LibraryStoreOptions & {
    maxBytes?: number;
    maxChars?: number;
  } = {},
): LibrarySource | null {
  const source = listLibrarySourcesForWorkspace(workspaceDir, opts).find(
    (item) => item.id === sourceId,
  );
  if (!source || source.kind !== "file" || !source.path) return null;
  const filePath = isAbsolute(source.path) ? source.path : resolve(workspaceDir, source.path);
  try {
    const { buffer, truncated: byteTruncated } = readFilePrefix(
      filePath,
      opts.maxBytes ?? DEFAULT_LIBRARY_EXTRACT_MAX_BYTES,
    );
    if (hasNulByte(buffer)) {
      return updateLibrarySourceContentForWorkspace(
        workspaceDir,
        source.id,
        {
          contentFetchedAt: Date.now(),
          contentError: "Unsupported binary file",
          ingestStatus: "error",
        },
        opts,
      );
    }
    const raw = buffer.toString("utf8");
    const extracted = extractTextByExtension(filePath, raw);
    const maxChars = opts.maxChars ?? DEFAULT_LIBRARY_EXTRACT_MAX_CHARS;
    const charTruncated = extracted.length > maxChars;
    const contentText = charTruncated ? extracted.slice(0, maxChars) : extracted;
    if (!contentText.trim()) {
      return updateLibrarySourceContentForWorkspace(
        workspaceDir,
        source.id,
        {
          contentFetchedAt: Date.now(),
          contentError: "No readable text extracted",
          ingestStatus: "error",
        },
        opts,
      );
    }
    return updateLibrarySourceContentForWorkspace(
      workspaceDir,
      source.id,
      {
        contentText,
        contentFetchedAt: Date.now(),
        contentTruncated: byteTruncated || charTruncated,
        contentError: undefined,
        ingestStatus: "done",
      },
      opts,
    );
  } catch (err) {
    return updateLibrarySourceContentForWorkspace(
      workspaceDir,
      source.id,
      {
        contentFetchedAt: Date.now(),
        contentError: err instanceof Error ? err.message : String(err),
        ingestStatus: "error",
      },
      opts,
    );
  }
}
