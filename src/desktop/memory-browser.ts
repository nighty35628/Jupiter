import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { readProjectMemory } from "../memory/project.js";
import {
  type MemoryEntry,
  type MemoryExpires,
  type MemoryPriority,
  type MemoryScope,
  MemoryStore,
  type MemoryType,
  readGlobalClaudeMemory,
  readGlobalJupiterMemory,
} from "../memory/user.js";

export type MemoryEntryKind = "project_file" | "global_file" | "structured";

export interface MemoryEntryInfo {
  kind: MemoryEntryKind;
  scope: MemoryScope;
  name: string;
  path: string;
  description: string;
  type?: string;
  priority?: MemoryPriority;
  expires?: MemoryExpires;
}

export interface MemoryEntryDetail extends MemoryEntryInfo {
  body: string;
  createdAt?: string;
}

export interface MemoryWriteRequest {
  path?: string;
  name: string;
  scope: MemoryScope;
  type: MemoryType;
  description: string;
  body: string;
  priority?: MemoryPriority;
  expires?: MemoryExpires;
}

export interface MemoryBrowserOptions {
  /** Absolute ~/.jupiter directory. Tests override this; production uses homedir(). */
  jupiterHome?: string;
}

export function collectMemoryEntriesForWorkspace(
  projectRoot: string,
  opts: MemoryBrowserOptions = {},
): MemoryEntryInfo[] {
  const out: MemoryEntryInfo[] = [];
  const project = readProjectMemory(projectRoot);
  if (project) {
    out.push({
      kind: "project_file",
      scope: "project",
      name: basename(project.path),
      path: project.path,
      description: "Project memory file",
      type: "freeform",
    });
  }

  const global = readGlobalJupiterMemory(opts.jupiterHome);
  if (global) {
    out.push({
      kind: "global_file",
      scope: "global",
      name: basename(global.path),
      path: global.path,
      description: "Global memory file",
      type: "freeform",
    });
  }

  const claudeGlobal = readGlobalClaudeMemory(
    opts.jupiterHome ? dirname(opts.jupiterHome) : undefined,
  );
  if (claudeGlobal) {
    out.push({
      kind: "global_file",
      scope: "global",
      name: basename(claudeGlobal.path),
      path: claudeGlobal.path,
      description: "Claude global memory file",
      type: "freeform",
    });
  }

  const store = new MemoryStore({ homeDir: opts.jupiterHome, projectRoot });
  for (const entry of store.list()) {
    out.push(structuredInfo(store, entry));
  }
  return out;
}

export function readMemoryEntryDetail(
  request: { path: string },
  projectRoot: string,
  opts: MemoryBrowserOptions = {},
): MemoryEntryDetail {
  const requested = resolve(request.path);
  const entry = collectMemoryEntriesForWorkspace(projectRoot, opts).find(
    (candidate) => resolve(candidate.path) === requested,
  );
  if (!entry) throw new Error(`memory path not available: ${request.path}`);

  if (entry.kind === "structured") {
    const store = new MemoryStore({ homeDir: opts.jupiterHome, projectRoot });
    const structured = store.read(entry.scope, entry.name);
    return {
      ...entry,
      description: structured.description,
      type: structured.type,
      priority: structured.priority,
      expires: structured.expires,
      body: structured.body,
      createdAt: structured.createdAt,
    };
  }

  if (!existsSync(entry.path)) throw new Error(`memory file missing: ${entry.path}`);
  return {
    ...entry,
    body: readFileSync(entry.path, "utf8").trim(),
  };
}

export function deleteMemoryEntryForWorkspace(
  request: { path: string },
  projectRoot: string,
  opts: MemoryBrowserOptions = {},
): boolean {
  const requested = resolve(request.path);
  const entry = collectMemoryEntriesForWorkspace(projectRoot, opts).find(
    (candidate) => resolve(candidate.path) === requested,
  );
  if (!entry) throw new Error(`memory path not available: ${request.path}`);

  if (entry.kind === "structured") {
    const store = new MemoryStore({ homeDir: opts.jupiterHome, projectRoot });
    return store.delete(entry.scope, entry.name);
  }

  if (!existsSync(entry.path)) return false;
  unlinkSync(entry.path);
  return true;
}

export function saveStructuredMemoryForWorkspace(
  request: MemoryWriteRequest,
  projectRoot: string,
  opts: MemoryBrowserOptions = {},
): MemoryEntryDetail {
  const store = new MemoryStore({ homeDir: opts.jupiterHome, projectRoot });
  const previous =
    request.path === undefined
      ? null
      : collectMemoryEntriesForWorkspace(projectRoot, opts).find(
          (candidate) => resolve(candidate.path) === resolve(request.path!),
        );
  if (request.path !== undefined && !previous) {
    throw new Error(`memory path not available: ${request.path}`);
  }
  if (previous && previous.kind !== "structured") {
    throw new Error("only structured memories can be edited");
  }

  const file = store.write({
    name: request.name,
    scope: request.scope,
    type: request.type,
    description: request.description,
    body: request.body,
    priority: request.priority,
    expires: request.expires,
  });

  if (previous && (previous.scope !== request.scope || previous.name !== request.name)) {
    store.delete(previous.scope, previous.name);
  }

  return readMemoryEntryDetail({ path: file }, projectRoot, opts);
}

function structuredInfo(store: MemoryStore, entry: MemoryEntry): MemoryEntryInfo {
  return {
    kind: "structured",
    scope: entry.scope,
    name: entry.name,
    path: store.pathFor(entry.scope, entry.name),
    description: entry.description,
    type: entry.type,
    priority: entry.priority,
    expires: entry.expires,
  };
}
