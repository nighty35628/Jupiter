import { dirname } from "node:path";
import { attachments } from "../attachments/store.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export type WebAccessMode = "local" | "lan" | "public";
export type WebRisk = "read" | "conversation" | "workspace-write" | "host-control" | "secret";

export interface WebPolicyOptions {
  mode: WebAccessMode;
  highRiskEnabled?: boolean;
  workspaces: WorkspaceRegistry;
}

export interface SurfaceCapabilities {
  mode: WebAccessMode;
  nativeWindow: false;
  nativeDialogs: false;
  nativeWebview: false;
  pets: false;
  updater: false;
  globalShortcuts: false;
  uploads: true;
  downloads: true;
  browserExternal: true;
  browserReader: false;
  terminal: boolean;
  gitWrite: boolean;
  mcpWrite: boolean;
  secretWrite: boolean;
  multiDeviceObserve: true;
  writerLease: true;
}

const ALL_COMMANDS = new Set([
  "attachment_import",
  "attachment_draft_refs",
  "abort",
  "ask_light",
  "btw",
  "checkpoint_response",
  "choice_response",
  "compact_history",
  "confirm_response",
  "context_diagnostics_get",
  "desktop_resync",
  "dingtalk_config_save",
  "dingtalk_connect",
  "dingtalk_disconnect",
  "dingtalk_status_get",
  "feishu_config_save",
  "feishu_connect",
  "feishu_disconnect",
  "feishu_status_get",
  "jobs_list",
  "jobs_stop",
  "jobs_stop_all",
  "library_add",
  "library_list",
  "library_refresh",
  "library_remove",
  "mcp_specs_add",
  "mcp_specs_disable",
  "mcp_specs_enable",
  "mcp_specs_get",
  "mcp_specs_reconnect",
  "mcp_specs_remove",
  "memory_delete",
  "memory_read",
  "memory_refresh",
  "memory_save",
  "mention_picked",
  "mention_preview",
  "mention_query",
  "new_chat",
  "optional_components_get",
  "plan_response",
  "provider_test",
  "qq_config_save",
  "qq_connect",
  "qq_disconnect",
  "qq_status_get",
  "retry",
  "retry_api",
  "revision_response",
  "rollback_to_turn",
  "session_archive",
  "session_archive_many",
  "session_clear_archived",
  "session_copy",
  "session_delete",
  "session_delete_archived",
  "session_export",
  "session_import",
  "session_import_bulk",
  "session_import_scan",
  "session_list",
  "session_list_archived",
  "session_load",
  "session_mark_read",
  "session_mark_unread",
  "session_patch_meta",
  "session_rename",
  "session_restore_archived",
  "session_turn_load",
  "settings_get",
  "settings_save",
  "settings_sign_out",
  "setup_save_key",
  "skill_create",
  "skill_model_set",
  "skill_path_add",
  "skill_path_remove",
  "skill_run",
  "skills_get",
  "slash",
  "source_ingest",
  "source_search",
  "storage_cleanup",
  "storage_scan",
  "tab_activate",
  "tab_close",
  "tab_open",
  "update_check",
  "update_disable_prompts",
  "update_skip",
  "user_input",
  "workflow_cancel",
  "workflow_save_library",
]);

const HIGH_RISK_COMMANDS = new Set([
  "dingtalk_config_save",
  "dingtalk_connect",
  "dingtalk_disconnect",
  "feishu_config_save",
  "feishu_connect",
  "feishu_disconnect",
  "mcp_specs_add",
  "mcp_specs_disable",
  "mcp_specs_enable",
  "mcp_specs_reconnect",
  "mcp_specs_remove",
  "provider_test",
  "qq_config_save",
  "qq_connect",
  "qq_disconnect",
  "session_import",
  "session_import_bulk",
  "session_import_scan",
  "settings_sign_out",
  "setup_save_key",
  "skill_create",
  "skill_path_add",
  "skill_path_remove",
  "skill_run",
  "source_ingest",
  "storage_cleanup",
]);

const PATH_OUTPUT_COMMANDS = new Set(["session_export"]);

const PUBLIC_ALLOWED_COMMANDS = new Set([
  "attachment_import",
  "attachment_draft_refs",
  "abort",
  "ask_light",
  "btw",
  "checkpoint_response",
  "choice_response",
  "compact_history",
  "confirm_response",
  "context_diagnostics_get",
  "desktop_resync",
  "jobs_list",
  "jobs_stop",
  "jobs_stop_all",
  "library_list",
  "library_refresh",
  "mcp_specs_get",
  "memory_read",
  "memory_refresh",
  "mention_picked",
  "mention_preview",
  "mention_query",
  "new_chat",
  "optional_components_get",
  "plan_response",
  "retry",
  "retry_api",
  "revision_response",
  "rollback_to_turn",
  "session_archive",
  "session_list",
  "session_list_archived",
  "session_load",
  "session_mark_read",
  "session_mark_unread",
  "session_patch_meta",
  "session_rename",
  "session_restore_archived",
  "session_turn_load",
  "settings_get",
  "settings_save",
  "skills_get",
  "source_search",
  "storage_scan",
  "tab_activate",
  "tab_close",
  "tab_open",
  "user_input",
  "workflow_cancel",
]);

const SAFE_SETTINGS_KEYS = new Set([
  "requestId",
  "reasoningEffort",
  "thinkingEnabled",
  "budgetUsd",
  "model",
  "contextTokens",
  "libraryRetrievalMode",
  "showSystemEvents",
  "showAiVisibleDetails",
  "processCardsDefaultOpen",
  "memoryConfirmWrites",
  "memoryGlobalEnabled",
  "promptHistory",
]);

export function surfaceCapabilities(opts: WebPolicyOptions): SurfaceCapabilities {
  const elevated = opts.mode === "local" || opts.highRiskEnabled === true;
  return {
    mode: opts.mode,
    nativeWindow: false,
    nativeDialogs: false,
    nativeWebview: false,
    pets: false,
    updater: false,
    globalShortcuts: false,
    uploads: true,
    downloads: true,
    browserExternal: true,
    browserReader: false,
    terminal: elevated,
    gitWrite: elevated,
    mcpWrite: elevated,
    secretWrite: elevated,
    multiDeviceObserve: true,
    writerLease: true,
  };
}

export function hostCommandAllowed(command: string, opts: WebPolicyOptions): boolean {
  if (
    ["git_info", "git_status", "git_diff", "read_file_preview", "read_file_bytes"].includes(command)
  ) {
    return true;
  }
  if (
    ["git_checkout_branch", "git_commit_all", "git_push", "git_create_pull_request"].includes(
      command,
    )
  ) {
    return surfaceCapabilities(opts).gitWrite;
  }
  return command === "desktop_diagnostic_event";
}

export async function authorizeDesktopCommand(
  input: Record<string, unknown>,
  opts: WebPolicyOptions,
): Promise<{ command: Record<string, unknown>; risk: WebRisk }> {
  const cmd = typeof input.cmd === "string" ? input.cmd : "";
  if (!ALL_COMMANDS.has(cmd)) throw new Error(`unsupported Web command: ${cmd || "(missing)"}`);
  if (opts.mode === "public" && !PUBLIC_ALLOWED_COMMANDS.has(cmd)) {
    throw new Error(`${cmd} is disabled in public Web mode`);
  }
  if (opts.mode !== "local" && (cmd === "setup_save_key" || cmd === "provider_test")) {
    throw new Error(`${cmd} is available only from the local Web surface`);
  }
  if (opts.mode !== "local" && HIGH_RISK_COMMANDS.has(cmd) && !opts.highRiskEnabled) {
    throw new Error(`${cmd} requires the remote high-risk capability`);
  }
  if (PATH_OUTPUT_COMMANDS.has(cmd)) {
    throw new Error(`${cmd} must use the Web upload/download flow`);
  }

  const command = { ...input };
  if (cmd === "tab_open" || cmd === "new_chat" || cmd === "session_load") {
    await normalizeWorkspace(command, opts);
  }
  if (cmd === "settings_save") sanitizeSettings(command, opts);
  resolveFileReferences(command, opts);
  if (cmd === "attachment_draft_refs") {
    if (
      typeof command.owner !== "string" ||
      !/^[a-f0-9-]{36}$/.test(command.owner) ||
      !Number.isSafeInteger(command.revision) ||
      Number(command.revision) < 0 ||
      !Array.isArray(command.ids) ||
      command.ids.length > 8192 ||
      !command.ids.every((id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id))
    )
      throw new Error("Invalid image draft references");
  }
  if (command.imagePaths !== undefined) {
    if (
      !["user_input", "ask_light"].includes(cmd) ||
      !Array.isArray(command.imagePaths) ||
      command.imagePaths.length > 12 ||
      !command.imagePaths.every(
        (path) => typeof path === "string" && /^jupiter-image:[a-f0-9]{64}$/.test(path),
      )
    )
      throw new Error("Images must use durable attachment references");
  }
  if (cmd === "attachment_import") {
    const raw = input.path;
    if (
      typeof raw !== "string" ||
      !/^(jupiter-file:[0-9a-f-]{36}|jupiter-image:[a-f0-9]{64})$/i.test(raw)
    )
      throw new Error("Image import requires an authorized file reference");
    if (typeof command.requestId !== "string" || command.requestId.length > 256)
      throw new Error("Invalid image request id");
    if (raw.startsWith("jupiter-file:")) {
      const record = opts.workspaces.resolveFile(raw.slice(13));
      const roots = record.ref.workspaceId
        ? [opts.workspaces.rootFor(record.ref.workspaceId)]
        : [dirname(record.absolutePath)];
      const image = await attachments.importPath(record.absolutePath, roots);
      command.path = `jupiter-image:${image.id}`;
    }
  }
  if (cmd === "user_input") {
    if (typeof command.text !== "string" || command.text.length > 2 * 1024 * 1024) {
      throw new Error("user input is missing or too large");
    }
  }

  return { command, risk: commandRisk(cmd) };
}

function resolveFileReferences(command: Record<string, unknown>, opts: WebPolicyOptions): void {
  for (const key of ["text", "path"] as const) {
    const value = command[key];
    if (typeof value !== "string" || !value.includes("jupiter-file:")) continue;
    command[key] = value.replace(
      /jupiter-file:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi,
      (_match, fileId: string) => opts.workspaces.resolveFile(fileId).absolutePath,
    );
  }
}

async function normalizeWorkspace(
  command: Record<string, unknown>,
  opts: WebPolicyOptions,
): Promise<void> {
  const workspaceId = typeof command.workspaceId === "string" ? command.workspaceId : "";
  if (workspaceId) {
    command.workspaceDir = opts.workspaces.rootFor(workspaceId);
    Reflect.deleteProperty(command, "workspaceId");
    return;
  }
  if (typeof command.workspaceDir === "string" && opts.mode === "local") {
    const registered = await opts.workspaces.idForExactRoot(command.workspaceDir);
    if (registered) {
      command.workspaceDir = opts.workspaces.rootFor(registered);
      return;
    }
  }
  if (command.workspaceDir === undefined && cmdAllowsDefaultWorkspace(command.cmd)) return;
  throw new Error("command requires an authorized workspaceId");
}

function sanitizeSettings(command: Record<string, unknown>, opts: WebPolicyOptions): void {
  Reflect.deleteProperty(command, "workspaceDir");
  Reflect.deleteProperty(command, "recentWorkspaces");
  if (opts.mode !== "local") {
    Reflect.deleteProperty(command, "baseUrl");
    Reflect.deleteProperty(command, "apiKey");
    Reflect.deleteProperty(command, "providerDialect");
  }
  if (opts.mode === "local" || opts.highRiskEnabled) return;
  for (const key of Object.keys(command)) {
    if (key === "cmd" || SAFE_SETTINGS_KEYS.has(key)) continue;
    Reflect.deleteProperty(command, key);
  }
  if (command.editMode !== undefined) Reflect.deleteProperty(command, "editMode");
}

function cmdAllowsDefaultWorkspace(cmd: unknown): boolean {
  return cmd === "new_chat" || cmd === "tab_open";
}

function commandRisk(cmd: string): WebRisk {
  if (HIGH_RISK_COMMANDS.has(cmd))
    return cmd.includes("config") || cmd === "setup_save_key" ? "secret" : "host-control";
  if (PATH_OUTPUT_COMMANDS.has(cmd)) return "workspace-write";
  if (
    cmd.startsWith("session_") ||
    cmd.startsWith("memory_") ||
    cmd.startsWith("library_") ||
    cmd === "rollback_to_turn" ||
    cmd === "settings_save"
  ) {
    return "workspace-write";
  }
  if (
    [
      "user_input",
      "retry",
      "retry_api",
      "abort",
      "ask_light",
      "btw",
      "slash",
      "attachment_import",
      "attachment_draft_refs",
    ].includes(cmd)
  ) {
    return "conversation";
  }
  return "read";
}
