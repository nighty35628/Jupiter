import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type WebFileSource = "workspace" | "upload" | "generated";

export interface WorkspaceInfo {
  id: string;
  name: string;
  writable: boolean;
}

export interface HostFileRef {
  id: string;
  source: WebFileSource;
  workspaceId?: string;
  name: string;
  relativePath?: string;
  mime?: string;
  size: number;
  modifiedMs: number;
  lifecycle: "workspace" | "runtime" | "session";
}

interface WorkspaceRecord extends WorkspaceInfo {
  root: string;
}

interface FileRecord {
  ref: HostFileRef;
  absolutePath: string;
}

export interface RegisterWorkspaceOptions {
  writable?: boolean;
  name?: string;
}

export interface WorkspacePathDescription {
  workspaceId: string;
  workspaceName: string;
  relativePath: string;
}

/** Server-owned authority for every host path exposed to Jupiter Web. */
export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly idsByRoot = new Map<string, string>();
  private readonly files = new Map<string, FileRecord>();

  static async create(
    roots: readonly string[],
    opts: RegisterWorkspaceOptions = {},
  ): Promise<WorkspaceRegistry> {
    const registry = new WorkspaceRegistry();
    for (const root of roots) await registry.register(root, opts);
    return registry;
  }

  async register(path: string, opts: RegisterWorkspaceOptions = {}): Promise<WorkspaceInfo> {
    const root = await canonicalDirectory(path);
    const existingId = this.idsByRoot.get(pathKey(root));
    if (existingId) return publicWorkspace(this.require(existingId));

    const record: WorkspaceRecord = {
      id: randomUUID(),
      root,
      name: this.uniqueName(opts.name?.trim() || basename(root) || root, root),
      writable: opts.writable !== false,
    };
    this.workspaces.set(record.id, record);
    this.idsByRoot.set(pathKey(root), record.id);
    return publicWorkspace(record);
  }

  list(): WorkspaceInfo[] {
    return Array.from(this.workspaces.values(), publicWorkspace);
  }

  rootFor(workspaceId: string): string {
    return this.require(workspaceId).root;
  }

  describeHostPath(path: string): WorkspacePathDescription | null {
    if (!isAbsolute(path)) return null;
    const candidate = resolve(path);
    for (const workspace of this.workspaces.values()) {
      const rel = relative(workspace.root, candidate);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      return {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        relativePath: rel.split(sep).join("/"),
      };
    }
    return null;
  }

  redactKnownRoots(text: string): string {
    let redacted = text;
    const records = [...this.workspaces.values()].sort((a, b) => b.root.length - a.root.length);
    for (const workspace of records) {
      redacted = replaceAllPathForms(redacted, workspace.root, `[workspace:${workspace.name}]`);
    }
    return redacted;
  }

  writable(workspaceId: string): boolean {
    return this.require(workspaceId).writable;
  }

  /** Compatibility lookup. It only accepts an exact registered root. */
  async idForExactRoot(path: string): Promise<string | null> {
    const root = await realpath(resolve(path)).catch(() => null);
    return root ? (this.idsByRoot.get(pathKey(root)) ?? null) : null;
  }

  async resolveExisting(workspaceId: string, requestedPath: string): Promise<string> {
    const workspace = this.require(workspaceId);
    const relativePath = normalizeRelativePath(requestedPath);
    const absolute = await realpath(resolve(workspace.root, relativePath));
    assertInside(workspace.root, absolute);
    return absolute;
  }

  async resolveDirectory(workspaceId: string, requestedPath = "."): Promise<string> {
    const absolute = await this.resolveExisting(workspaceId, requestedPath);
    const metadata = await stat(absolute);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    return absolute;
  }

  async issueWorkspaceFile(
    workspaceId: string,
    requestedPath: string,
    mime?: string,
  ): Promise<HostFileRef> {
    const workspace = this.require(workspaceId);
    const absolutePath = await this.resolveExisting(workspaceId, requestedPath);
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) throw new Error("not a file");
    const relativePath = relative(workspace.root, absolutePath).split(sep).join("/");
    const ref: HostFileRef = {
      id: randomUUID(),
      source: "workspace",
      workspaceId,
      name: basename(absolutePath),
      relativePath,
      mime,
      size: metadata.size,
      modifiedMs: metadata.mtimeMs,
      lifecycle: "workspace",
    };
    this.files.set(ref.id, { ref, absolutePath });
    return { ...ref };
  }

  registerRuntimeFile(absolutePath: string, metadata: Omit<HostFileRef, "id">): HostFileRef {
    if (!isAbsolute(absolutePath)) throw new Error("runtime file path must be absolute");
    const ref: HostFileRef = { ...metadata, id: randomUUID() };
    this.files.set(ref.id, { ref, absolutePath: resolve(absolutePath) });
    return { ...ref };
  }

  resolveFile(fileId: string): FileRecord {
    const record = this.files.get(fileId);
    if (!record) throw new Error("unknown or expired file id");
    return { ref: { ...record.ref }, absolutePath: record.absolutePath };
  }

  forgetFile(fileId: string): FileRecord | null {
    const record = this.files.get(fileId) ?? null;
    if (record) this.files.delete(fileId);
    return record ? { ref: { ...record.ref }, absolutePath: record.absolutePath } : null;
  }

  private require(workspaceId: string): WorkspaceRecord {
    if (typeof workspaceId !== "string" || !workspaceId) throw new Error("workspaceId is required");
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error("unknown or unauthorized workspace");
    return workspace;
  }

  private uniqueName(requested: string, root: string): string {
    const names = new Set(Array.from(this.workspaces.values(), (workspace) => workspace.name));
    if (!names.has(requested)) return requested;
    const parent = basename(dirname(root));
    const contextual = parent ? `${requested} (${parent})` : requested;
    if (!names.has(contextual)) return contextual;
    for (let index = 2; ; index += 1) {
      const candidate = `${contextual} ${index}`;
      if (!names.has(candidate)) return candidate;
    }
  }
}

function publicWorkspace(record: WorkspaceRecord): WorkspaceInfo {
  return { id: record.id, name: record.name, writable: record.writable };
}

function normalizeRelativePath(path: string): string {
  if (typeof path !== "string" || !path.trim()) throw new Error("file path is required");
  if (path.includes("\0")) throw new Error("file path contains a null byte");
  if (isAbsolute(path)) throw new Error("absolute browser paths are not allowed");
  return path.trim();
}

async function canonicalDirectory(path: string): Promise<string> {
  const root = await realpath(resolve(path));
  const metadata = await stat(root);
  if (!metadata.isDirectory()) throw new Error(`not a directory: ${root}`);
  return root;
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("path is outside the authorized workspace");
  }
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function replaceAllPathForms(text: string, path: string, replacement: string): string {
  const forms = new Set([path, path.split("\\").join("/"), path.split("/").join("\\")]);
  let output = text;
  for (const form of forms) {
    if (form) output = output.split(form).join(replacement);
  }
  return output;
}
