import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions } from "./version.js";

export const SKILL_PACKS_DIRNAME = "skill-packs";
export const SKILL_PACKS_MANAGED_DIRNAME = "managed";
export const SKILL_PACKS_BUNDLED_DIRNAME = "bundled";
export const SKILL_PACK_REGISTRY_URL_ENV = "JUPITER_SKILL_PACK_REGISTRY_URL";
export const DEFAULT_SKILL_PACK_REGISTRY_URL =
  "https://github.com/nighty35628/Jupiter/releases/latest/download/skill-packs.json";

const PACK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SAFE_RELATIVE_PATH = /^[^/\\](?:.*[^/\\])?$/;

export interface SkillPackVersion {
  id: string;
  version: string;
}

export interface SkillPackManifestEntry extends SkillPackVersion {
  url: string;
  sha256?: string;
  description?: string;
  skills?: string[];
  keywords?: string[];
}

export interface SkillPackRegistryManifest {
  schema: 1;
  packs: SkillPackManifestEntry[];
}

export interface SkillPackBundleFile {
  path: string;
  content: string;
}

export interface SkillPackBundle extends SkillPackVersion {
  schema: 1;
  files: SkillPackBundleFile[];
}

export interface SkillPackUpdateEntry {
  id: string;
  currentVersion: string | null;
  latestVersion: string;
  url: string;
  sha256?: string;
  description?: string;
  skills?: string[];
  keywords?: string[];
  updateAvailable: boolean;
}

export type SkillPackUpdateStatus =
  | { ok: true; packs: SkillPackUpdateEntry[] }
  | { ok: false; error: string; packs: SkillPackUpdateEntry[] };

export type SkillPackInstallResult =
  | { ok: true; installed: SkillPackVersion[]; packs: SkillPackUpdateEntry[] }
  | { ok: false; error: string; installed: SkillPackVersion[]; packs: SkillPackUpdateEntry[] };

export interface SkillPackUpdateOptions {
  homeDir?: string;
  registryUrl?: string;
  fetchImpl?: typeof fetch;
  bundledPacks?: readonly SkillPackVersion[];
  packIds?: readonly string[];
}

export interface SkillPackSearchMatch {
  id: string;
  installed: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  source: "channel" | "local";
  url?: string;
  sha256?: string;
  description?: string;
  skills?: string[];
  keywords?: string[];
  exact: boolean;
}

export type SkillPackSearchResult =
  | {
      ok: true;
      query: string;
      registryUrl: string;
      matches: SkillPackSearchMatch[];
      warning?: string;
    }
  | {
      ok: false;
      query: string;
      registryUrl: string;
      error: string;
      matches: SkillPackSearchMatch[];
    };

interface JsonReadResult {
  text: string;
  value: unknown;
}

export function configuredSkillPackRegistryUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  return env[SKILL_PACK_REGISTRY_URL_ENV]?.trim() || DEFAULT_SKILL_PACK_REGISTRY_URL;
}

export function managedSkillPacksDir(homeDir: string = homedir()): string {
  return join(homeDir, ".jupiter", SKILL_PACKS_DIRNAME, SKILL_PACKS_MANAGED_DIRNAME);
}

export function managedSkillPackManifestPath(homeDir: string = homedir()): string {
  return join(managedSkillPacksDir(homeDir), "manifest.json");
}

function bundledSkillPacksDir(): string | null {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const packageJson = join(dir, "package.json");
      if (existsSync(packageJson)) {
        const pkg = JSON.parse(readFileSync(packageJson, "utf8"));
        if (pkg?.name === "jupiter") {
          return join(dir, "resources", SKILL_PACKS_DIRNAME, SKILL_PACKS_BUNDLED_DIRNAME);
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* no bundled resource root */
  }
  return null;
}

interface SkillPackRootRecord extends SkillPackVersion {
  skillRoot: string;
}

function listPackRootRecords(baseDir: string): SkillPackRootRecord[] {
  if (!existsSync(baseDir)) return [];
  const out: SkillPackRootRecord[] = [];
  try {
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !PACK_ID.test(entry.name)) continue;
      const packDir = join(baseDir, entry.name);
      const skillRoot = join(packDir, "skills");
      if (!existsSync(skillRoot)) continue;
      const meta = readPackMetadata(packDir);
      if (meta) out.push({ ...meta, skillRoot });
    }
  } catch {
    /* unreadable pack dir */
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function skillPackSkillRootsFromPackDirs(
  managedDir: string,
  bundledDir: string | null,
): string[] {
  const byId = new Map<string, SkillPackRootRecord>();
  for (const pack of [
    ...listPackRootRecords(managedDir),
    ...(bundledDir ? listPackRootRecords(bundledDir) : []),
  ]) {
    const current = byId.get(pack.id);
    if (!current || comparePackVersions(pack.version, current.version) > 0) {
      byId.set(pack.id, pack);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).map((pack) => pack.skillRoot);
}

export function defaultSkillPackSkillRoots(homeDir: string = homedir()): string[] {
  return skillPackSkillRootsFromPackDirs(managedSkillPacksDir(homeDir), bundledSkillPacksDir());
}

function readPackMetadata(packDir: string): SkillPackVersion | null {
  try {
    const raw = readFileSync(join(packDir, "pack.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (isPackId(parsed?.id) && typeof parsed.version === "string") {
      return { id: parsed.id, version: parsed.version };
    }
  } catch {
    /* infer below */
  }
  const id = packDir.split(/[\\/]/).pop() ?? "";
  return isPackId(id) ? { id, version: "0.0.0" } : null;
}

function listPackVersions(baseDir: string): SkillPackVersion[] {
  if (!existsSync(baseDir)) return [];
  const out: SkillPackVersion[] = [];
  try {
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !PACK_ID.test(entry.name)) continue;
      const meta = readPackMetadata(join(baseDir, entry.name));
      if (meta) out.push(meta);
    }
  } catch {
    /* unreadable pack dir */
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function listBundledSkillPacks(): SkillPackVersion[] {
  const bundled = bundledSkillPacksDir();
  return bundled ? listPackVersions(bundled) : [];
}

export function listManagedSkillPacks(homeDir: string = homedir()): SkillPackVersion[] {
  try {
    const raw = readFileSync(managedSkillPackManifestPath(homeDir), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.packs)) {
      return parsed.packs
        .filter((pack: unknown) => {
          const p = pack as Partial<SkillPackVersion>;
          return isPackId(p.id) && typeof p.version === "string";
        })
        .map((pack: unknown) => {
          const p = pack as SkillPackVersion;
          return { id: p.id, version: p.version };
        })
        .sort((a: SkillPackVersion, b: SkillPackVersion) => a.id.localeCompare(b.id));
    }
  } catch {
    /* fall back to directory scan */
  }
  return listPackVersions(managedSkillPacksDir(homeDir));
}

function isPackId(value: unknown): value is string {
  return typeof value === "string" && PACK_ID.test(value);
}

function parseManifest(value: unknown): SkillPackRegistryManifest | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SkillPackRegistryManifest>;
  if (raw.schema !== 1 || !Array.isArray(raw.packs)) return null;
  const packs: SkillPackManifestEntry[] = [];
  for (const entry of raw.packs) {
    if (!entry || typeof entry !== "object") return null;
    const p = entry as Partial<SkillPackManifestEntry>;
    if (!isPackId(p.id) || typeof p.version !== "string" || typeof p.url !== "string") {
      return null;
    }
    const item: SkillPackManifestEntry = { id: p.id, version: p.version, url: p.url };
    if (typeof p.sha256 === "string" && p.sha256.trim()) item.sha256 = p.sha256.trim();
    if (typeof p.description === "string" && p.description.trim()) {
      item.description = p.description.trim();
    }
    if (Array.isArray(p.skills)) {
      item.skills = p.skills.filter(
        (x): x is string => typeof x === "string" && x.trim().length > 0,
      );
    }
    if (Array.isArray(p.keywords)) {
      item.keywords = p.keywords.filter(
        (x): x is string => typeof x === "string" && x.trim().length > 0,
      );
    }
    packs.push(item);
  }
  return { schema: 1, packs };
}

function parseBundle(value: unknown): SkillPackBundle | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SkillPackBundle>;
  if (raw.schema !== 1 || !isPackId(raw.id) || typeof raw.version !== "string") return null;
  if (!Array.isArray(raw.files)) return null;
  const files: SkillPackBundleFile[] = [];
  for (const file of raw.files) {
    if (!file || typeof file !== "object") return null;
    const f = file as Partial<SkillPackBundleFile>;
    if (typeof f.path !== "string" || typeof f.content !== "string") return null;
    files.push({ path: f.path, content: f.content });
  }
  return { schema: 1, id: raw.id, version: raw.version, files };
}

function latestLocalVersions(
  homeDir: string,
  bundledPacks: readonly SkillPackVersion[] | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const pack of bundledPacks ?? listBundledSkillPacks()) out.set(pack.id, pack.version);
  for (const pack of listManagedSkillPacks(homeDir)) {
    const current = out.get(pack.id);
    if (!current || comparePackVersions(pack.version, current) > 0) out.set(pack.id, pack.version);
  }
  return out;
}

function comparePackVersions(a: string, b: string): number {
  if (/^\d+\.\d+\.\d+(?:-.+)?$/.test(a) && /^\d+\.\d+\.\d+(?:-.+)?$/.test(b)) {
    return compareVersions(a, b);
  }
  return a.localeCompare(b);
}

async function readJson(url: string, fetchImpl: typeof fetch): Promise<JsonReadResult | null> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  if (typeof res.text === "function") {
    const text = await res.text();
    return { text, value: JSON.parse(text) };
  }
  const value = await res.json();
  return { text: JSON.stringify(value), value };
}

async function fetchManifest(
  opts: SkillPackUpdateOptions,
): Promise<{ ok: true; manifest: SkillPackRegistryManifest } | { ok: false; error: string }> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) return { ok: false, error: "fetch is unavailable" };
  const url = opts.registryUrl ?? configuredSkillPackRegistryUrl();
  try {
    const result = await readJson(url, fetchImpl);
    if (!result) return { ok: false, error: "skill pack update channel is unreachable" };
    const manifest = parseManifest(result.value);
    if (!manifest) return { ok: false, error: "skill pack manifest is invalid" };
    return { ok: true, manifest };
  } catch (err) {
    return { ok: false, error: `skill pack manifest fetch failed: ${(err as Error).message}` };
  }
}

export async function checkSkillPackUpdates(
  opts: SkillPackUpdateOptions = {},
): Promise<SkillPackUpdateStatus> {
  const homeDir = opts.homeDir ?? homedir();
  const manifestResult = await fetchManifest(opts);
  if (!manifestResult.ok) return { ok: false, error: manifestResult.error, packs: [] };
  const local = latestLocalVersions(homeDir, opts.bundledPacks);
  const packs = manifestResult.manifest.packs.map((pack) => {
    const currentVersion = local.get(pack.id) ?? null;
    return {
      id: pack.id,
      currentVersion,
      latestVersion: pack.version,
      url: pack.url,
      sha256: pack.sha256,
      description: pack.description,
      skills: pack.skills,
      keywords: pack.keywords,
      updateAvailable: !currentVersion || comparePackVersions(pack.version, currentVersion) > 0,
    };
  });
  return { ok: true, packs };
}

function normalizeSkillPackQuery(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bskills?\b/g, " ")
    .replace(/技能|插件|包/g, " ")
    .replace(/[^a-z0-9._-]+/g, " ")
    .trim();
}

function skillPackMatchesQuery(
  pack: {
    id: string;
    description?: string;
    skills?: readonly string[];
    keywords?: readonly string[];
  },
  query: string,
): { matches: boolean; exact: boolean } {
  const normalizedQuery = normalizeSkillPackQuery(query);
  if (!normalizedQuery) return { matches: true, exact: false };
  const fields = [
    pack.id,
    pack.description ?? "",
    ...(pack.skills ?? []),
    ...(pack.keywords ?? []),
  ].map(normalizeSkillPackQuery);
  const exact = fields.some((field) => field === normalizedQuery);
  if (exact) return { matches: true, exact: true };
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const haystack = fields.join(" ");
  return { matches: tokens.every((token) => haystack.includes(token)), exact: false };
}

export async function searchSkillPacks(
  query: string,
  opts: SkillPackUpdateOptions = {},
): Promise<SkillPackSearchResult> {
  const homeDir = opts.homeDir ?? homedir();
  const registryUrl = opts.registryUrl ?? configuredSkillPackRegistryUrl();
  const local = latestLocalVersions(homeDir, opts.bundledPacks);
  const byId = new Map<string, SkillPackSearchMatch>();
  let warning: string | undefined;

  const manifestResult = await fetchManifest(opts);
  if (manifestResult.ok) {
    for (const pack of manifestResult.manifest.packs) {
      const currentVersion = local.get(pack.id) ?? null;
      const match = skillPackMatchesQuery(pack, query);
      if (!match.matches) continue;
      byId.set(pack.id, {
        id: pack.id,
        installed: currentVersion !== null,
        currentVersion,
        latestVersion: pack.version,
        updateAvailable: !currentVersion || comparePackVersions(pack.version, currentVersion) > 0,
        source: "channel",
        url: pack.url,
        sha256: pack.sha256,
        description: pack.description,
        skills: pack.skills,
        keywords: pack.keywords,
        exact: match.exact,
      });
    }
  } else {
    warning = manifestResult.error;
  }

  for (const [id, version] of local) {
    if (byId.has(id)) continue;
    const match = skillPackMatchesQuery({ id }, query);
    if (!match.matches) continue;
    byId.set(id, {
      id,
      installed: true,
      currentVersion: version,
      latestVersion: version,
      updateAvailable: false,
      source: "local",
      exact: match.exact,
    });
  }

  const matches = [...byId.values()].sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.updateAvailable !== b.updateAvailable) return a.updateAvailable ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  if (warning && matches.length === 0) {
    return { ok: false, query, registryUrl, error: warning, matches };
  }
  return warning
    ? { ok: true, query, registryUrl, warning, matches }
    : { ok: true, query, registryUrl, matches };
}

function assertSafeBundlePath(packDir: string, path: string): string {
  if (!SAFE_RELATIVE_PATH.test(path) || path.includes("\0")) {
    throw new Error(`unsafe skill pack file path: ${path}`);
  }
  const target = resolve(packDir, path);
  const rel = relative(packDir, target);
  if (rel === "" || rel.startsWith("../") || rel === ".." || rel.startsWith("..\\")) {
    throw new Error(`unsafe skill pack file path: ${path}`);
  }
  return target;
}

function writeManagedManifest(homeDir: string, installed: readonly SkillPackVersion[]): void {
  const current = new Map(listManagedSkillPacks(homeDir).map((pack) => [pack.id, pack.version]));
  for (const pack of installed) current.set(pack.id, pack.version);
  const packs = [...current.entries()]
    .map(([id, version]) => ({ id, version }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const path = managedSkillPackManifestPath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schema: 1, packs }, null, 2), "utf8");
}

async function fetchBundle(
  pack: SkillPackUpdateEntry,
  fetchImpl: typeof fetch,
): Promise<SkillPackBundle> {
  const result = await readJson(pack.url, fetchImpl);
  if (!result) throw new Error(`skill pack bundle is unreachable: ${pack.id}`);
  if (pack.sha256) {
    const actual = createHash("sha256").update(result.text).digest("hex");
    if (actual !== pack.sha256) throw new Error(`sha256 mismatch for skill pack ${pack.id}`);
  }
  const bundle = parseBundle(result.value);
  if (!bundle) throw new Error(`skill pack bundle is invalid: ${pack.id}`);
  if (bundle.id !== pack.id) throw new Error(`skill pack bundle id mismatch: ${pack.id}`);
  if (bundle.version !== pack.latestVersion) {
    throw new Error(`skill pack bundle version mismatch: ${pack.id}`);
  }
  return bundle;
}

export async function installSkillPackUpdates(
  opts: SkillPackUpdateOptions = {},
): Promise<SkillPackInstallResult> {
  const homeDir = opts.homeDir ?? homedir();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) return { ok: false, error: "fetch is unavailable", installed: [], packs: [] };
  const status = await checkSkillPackUpdates(opts);
  if (!status.ok) return { ok: false, error: status.error, installed: [], packs: status.packs };
  const rawPackIds = opts.packIds ?? [];
  const requested = new Set(rawPackIds.filter(isPackId));
  if (rawPackIds.length > 0 && requested.size !== rawPackIds.length) {
    return {
      ok: false,
      error: "invalid skill pack id in request",
      installed: [],
      packs: status.packs,
    };
  }
  if (requested.size > 0) {
    const available = new Set(status.packs.map((pack) => pack.id));
    const missing = [...requested].filter((id) => !available.has(id));
    if (missing.length > 0) {
      return {
        ok: false,
        error: `skill pack not found in update channel: ${missing.join(", ")}`,
        installed: [],
        packs: status.packs,
      };
    }
  }
  const updates = status.packs.filter(
    (pack) => pack.updateAvailable && (requested.size === 0 || requested.has(pack.id)),
  );
  const installed: SkillPackVersion[] = [];
  try {
    for (const pack of updates) {
      const bundle = await fetchBundle(pack, fetchImpl);
      const packDir = join(managedSkillPacksDir(homeDir), bundle.id);
      const tmpDir = `${packDir}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      rmSync(tmpDir, { recursive: true, force: true });
      mkdirSync(tmpDir, { recursive: true });
      for (const file of bundle.files) {
        const target = assertSafeBundlePath(tmpDir, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content, "utf8");
      }
      writeFileSync(
        join(tmpDir, "pack.json"),
        JSON.stringify({ schema: 1, id: bundle.id, version: bundle.version }, null, 2),
        "utf8",
      );
      rmSync(packDir, { recursive: true, force: true });
      renameOrCopy(tmpDir, packDir);
      installed.push({ id: bundle.id, version: bundle.version });
    }
    if (installed.length > 0) writeManagedManifest(homeDir, installed);
    return { ok: true, installed, packs: status.packs };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      installed,
      packs: status.packs,
    };
  }
}

function renameOrCopy(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    rmSync(to, { recursive: true, force: true });
    copyDir(from, to);
    rmSync(from, { recursive: true, force: true });
  }
}

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dest);
    } else if (entry.isFile()) {
      writeFileSync(dest, readFileSync(src));
    }
  }
}
