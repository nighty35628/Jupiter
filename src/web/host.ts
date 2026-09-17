import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { WorkspaceRegistry } from "./workspaces.js";

const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_TEXT_BYTES = 256 * 1024;
const MAX_PREVIEW_FILE_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const DISABLED_HOOKS_DIR = join(tmpdir(), "jupiter-web-disabled-git-hooks");

type CommandResult = { code: number; stdout: string; stderr: string };
type HostArgs = Record<string, unknown>;

export interface WebHostContext {
  workspaces: WorkspaceRegistry;
}

export async function invokeWebHost(
  command: string,
  args: HostArgs,
  context: WebHostContext,
): Promise<unknown> {
  switch (command) {
    case "git_info":
      return gitInfo(workspaceRoot(args, context));
    case "git_status":
      return gitStatus(workspaceRoot(args, context));
    case "git_diff":
      return gitDiff(workspaceRoot(args, context));
    case "git_checkout_branch":
      return gitCheckout(workspaceRoot(args, context, true), stringArg(args.branch, "branch"));
    case "git_commit_all":
      return gitCommitAll(workspaceRoot(args, context, true), optionalString(args.message));
    case "git_push":
      return runCommand("git", ["push"], workspaceRoot(args, context, true));
    case "git_create_pull_request":
      return runCommand("gh", ["pr", "create", "--fill"], workspaceRoot(args, context, true));
    case "read_file_preview":
      return readFilePreview(args, context);
    case "read_file_bytes":
      return Array.from(await readPreviewBytes(args, context));
    case "desktop_diagnostic_event":
      return null;
    default:
      throw new Error(`${command} is not available in Jupiter Web Beta`);
  }
}

function workspaceRoot(args: HostArgs, context: WebHostContext, requireWrite = false): string {
  const workspaceId = stringArg(args.workspaceId, "workspaceId");
  if (requireWrite && !context.workspaces.writable(workspaceId)) {
    throw new Error("workspace is read-only");
  }
  return context.workspaces.rootFor(workspaceId);
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function runCommand(program: string, args: string[], cwd: string): Promise<CommandResult> {
  mkdirSync(DISABLED_HOOKS_DIR, { recursive: true });
  return new Promise((resolveRun) => {
    execFile(
      program,
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "core.hooksPath",
          GIT_CONFIG_VALUE_0: DISABLED_HOOKS_DIR,
          GIT_CONFIG_KEY_1: "commit.gpgSign",
          GIT_CONFIG_VALUE_1: "false",
          GH_PROMPT_DISABLED: "1",
        },
      },
      (error, stdout, stderr) => {
        const numericCode =
          error && "code" in error && typeof error.code === "number" ? error.code : null;
        resolveRun({
          code: error ? (numericCode ?? -1) : 0,
          stdout,
          stderr: stderr || (error instanceof Error ? error.message : ""),
        });
      },
    );
  });
}

async function gitText(cwd: string, args: string[]): Promise<string | null> {
  const result = await runCommand("git", args, cwd);
  const text = result.stdout.trim();
  return result.code === 0 && text ? text : null;
}

async function gitInfo(cwd: string): Promise<Record<string, unknown>> {
  const isRepo = (await gitText(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
  if (!isRepo) {
    return {
      isRepo: false,
      branch: null,
      upstream: null,
      remote: null,
      ahead: 0,
      behind: 0,
      lastCommit: null,
      branches: [],
    };
  }
  const branch =
    (await gitText(cwd, ["branch", "--show-current"])) ??
    (await gitText(cwd, ["rev-parse", "--short", "HEAD"]));
  const upstream = await gitText(cwd, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  const remotes = await gitText(cwd, ["remote"]);
  const remote = upstream?.split("/")[0] ?? remotes?.split(/\r?\n/)[0] ?? null;
  const counts = upstream
    ? await gitText(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])
    : null;
  const [ahead = 0, behind = 0] = (counts ?? "0 0")
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10) || 0);
  const branches =
    (await gitText(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
      ?.split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  return {
    isRepo: true,
    branch,
    upstream,
    remote,
    ahead,
    behind,
    lastCommit: await gitText(cwd, ["log", "-1", "--format=%h %s"]),
    branches,
  };
}

async function gitStatus(cwd: string): Promise<Array<{ path: string; kind: string }>> {
  const result = await runCommand("git", ["status", "--porcelain", "-z"], cwd);
  if (result.code !== 0) return [];
  const entries: Array<{ path: string; kind: string }> = [];
  for (const record of result.stdout.split("\0")) {
    if (record.length < 4) continue;
    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    const kind =
      x === "?" && y === "?"
        ? "untracked"
        : x === "A" || y === "A"
          ? "added"
          : x === "D" || y === "D"
            ? "deleted"
            : x === "R" || y === "R"
              ? "renamed"
              : x === "M" || y === "M"
                ? "modified"
                : null;
    if (kind) entries.push({ path: record.slice(3), kind });
  }
  return entries;
}

async function gitDiff(cwd: string): Promise<string> {
  const chunks: string[] = [];
  for (const args of [
    ["-c", "core.quotepath=false", "diff", "--no-ext-diff", "--cached", "--"],
    ["-c", "core.quotepath=false", "diff", "--no-ext-diff", "--"],
  ]) {
    const result = await runCommand("git", args, cwd);
    if (result.code === 0 && result.stdout.trim()) chunks.push(result.stdout);
  }
  for (const entry of await gitStatus(cwd)) {
    if (entry.kind !== "untracked") continue;
    const result = await runCommand(
      "git",
      [
        "-c",
        "core.quotepath=false",
        "diff",
        "--no-ext-diff",
        "--no-index",
        "--",
        process.platform === "win32" ? "NUL" : "/dev/null",
        entry.path,
      ],
      cwd,
    );
    if ((result.code === 0 || result.code === 1) && result.stdout.trim())
      chunks.push(result.stdout);
  }
  return chunks.join("\n");
}

async function gitCheckout(cwd: string, branch: string): Promise<CommandResult> {
  return runCommand("git", ["checkout", branch], cwd);
}

async function gitCommitAll(cwd: string, requestedMessage: string): Promise<CommandResult> {
  const status = await gitStatus(cwd);
  const first = status[0]?.path ?? "workspace";
  const message =
    requestedMessage ||
    (status.length <= 1 ? `Update ${first}` : `Update ${first} and ${status.length - 1} more`);
  const add = await runCommand("git", ["add", "-A"], cwd);
  if (add.code !== 0) return add;
  return runCommand("git", ["commit", "-m", message], cwd);
}

async function resolvePreviewPath(
  args: HostArgs,
  context: WebHostContext,
): Promise<{ requested: string; absolute: string; fileId: string }> {
  if (typeof args.fileId === "string" && args.fileId) {
    const record = context.workspaces.resolveFile(args.fileId);
    return {
      requested: record.ref.relativePath ?? record.ref.name,
      absolute: record.absolutePath,
      fileId: record.ref.id,
    };
  }
  const requested = stringArg(args.path, "path");
  const workspaceId = stringArg(args.workspaceId, "workspaceId");
  const ref = await context.workspaces.issueWorkspaceFile(workspaceId, requested);
  const record = context.workspaces.resolveFile(ref.id);
  return { requested, absolute: record.absolutePath, fileId: ref.id };
}

async function readPreviewBytes(args: HostArgs, context: WebHostContext): Promise<Buffer> {
  const { absolute } = await resolvePreviewPath(args, context);
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error("not a file");
  if (metadata.size > MAX_PREVIEW_FILE_BYTES) throw new Error("file is too large to preview");
  return readFile(absolute);
}

async function readFilePreview(
  args: HostArgs,
  context: WebHostContext,
): Promise<Record<string, unknown>> {
  const { requested, absolute, fileId } = await resolvePreviewPath(args, context);
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error("not a file");
  const ext = extname(absolute).slice(1).toLowerCase() || null;
  const kind = previewKind(ext);
  let text: string | null = null;
  let truncated = false;
  if (kind === "text") {
    const bytes = await readFile(absolute);
    truncated = bytes.length > MAX_PREVIEW_TEXT_BYTES;
    text = bytes.subarray(0, MAX_PREVIEW_TEXT_BYTES).toString("utf8");
  }
  return {
    path: requested,
    absPath: `jupiter-file:${fileId}`,
    name: basename(absolute),
    ext,
    kind,
    bytes: metadata.size,
    modifiedMs: metadata.mtimeMs,
    text,
    truncated,
  };
}

function previewKind(ext: string | null): "text" | "image" | "document" | "binary" {
  if (ext && ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) {
    return "image";
  }
  if (ext && ["pdf", "docx"].includes(ext)) return "document";
  if (
    !ext ||
    [
      "txt",
      "md",
      "json",
      "jsonl",
      "js",
      "jsx",
      "ts",
      "tsx",
      "css",
      "html",
      "xml",
      "yaml",
      "yml",
      "toml",
      "rs",
      "py",
      "go",
      "java",
      "c",
      "cc",
      "cpp",
      "h",
      "hpp",
      "sh",
      "sql",
      "log",
    ].includes(ext)
  ) {
    return "text";
  }
  return "binary";
}
