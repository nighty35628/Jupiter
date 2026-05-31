/** Mutations require an attached session — standalone mode returns 503 because we have no project root to scope under. */

import {
  addProjectShellAllowed,
  clearProjectShellAllowed,
  loadProjectShellAllowed,
  removeProjectShellAllowed,
} from "../../config.js";
import { BUILTIN_ALLOWLIST } from "../../tools/shell.js";
import type { DashboardContext } from "../context.js";
import type { ApiResult } from "../router.js";

interface MutationBody {
  prefix?: unknown;
  confirm?: unknown;
}

function parseBody(raw: string): MutationBody {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as MutationBody) : {};
  } catch {
    return {};
  }
}

export async function handlePermissions(
  method: string,
  rest: string[],
  body: string,
  ctx: DashboardContext,
): Promise<ApiResult> {
  // GET — listing works regardless of mode (builtin always shown,
  // project list optional).
  if (method === "GET" && rest.length === 0) {
    const cwd = ctx.getCurrentCwd?.();
    return {
      status: 200,
      body: {
        currentCwd: cwd ?? null,
        editMode: ctx.getEditMode?.() ?? null,
        builtin: [...BUILTIN_ALLOWLIST],
        project: cwd ? loadProjectShellAllowed(cwd, ctx.configPath) : [],
      },
    };
  }

  // Mutations require a current project root.
  const cwd = ctx.getCurrentCwd?.();
  if (!cwd) {
    return {
      status: 503,
      body: {
        error:
          "no active project — mutations require an attached dashboard session (run `/dashboard` from inside `jupiter code`).",
      },
    };
  }

  if (method === "POST" && rest.length === 0) {
    const { prefix } = parseBody(body);
    if (typeof prefix !== "string" || !prefix.trim()) {
      return { status: 400, body: { error: "prefix (string) required" } };
    }
    const trimmed = prefix.trim();
    if (BUILTIN_ALLOWLIST.includes(trimmed)) {
      return {
        status: 409,
        body: {
          error: `\`${trimmed}\` is already in the builtin allowlist — no project entry needed.`,
        },
      };
    }
    const before = loadProjectShellAllowed(cwd, ctx.configPath);
    if (before.includes(trimmed)) {
      return { status: 200, body: { added: false, prefix: trimmed, alreadyPresent: true } };
    }
    addProjectShellAllowed(cwd, trimmed, ctx.configPath);
    ctx.audit?.({
      ts: Date.now(),
      action: "add-allowlist",
      payload: { prefix: trimmed, project: cwd },
    });
    return { status: 200, body: { added: true, prefix: trimmed } };
  }

  if (method === "DELETE" && rest.length === 0) {
    const { prefix } = parseBody(body);
    if (typeof prefix !== "string" || !prefix.trim()) {
      return { status: 400, body: { error: "prefix (string) required" } };
    }
    const trimmed = prefix.trim();
    if (BUILTIN_ALLOWLIST.includes(trimmed)) {
      return {
        status: 409,
        body: {
          error: `\`${trimmed}\` is in the builtin allowlist (read-only); builtin entries can't be removed at runtime.`,
        },
      };
    }
    const removed = removeProjectShellAllowed(cwd, trimmed, ctx.configPath);
    if (removed) {
      ctx.audit?.({
        ts: Date.now(),
        action: "remove-allowlist",
        payload: { prefix: trimmed, project: cwd },
      });
    }
    return { status: 200, body: { removed, prefix: trimmed } };
  }

  if (method === "POST" && rest[0] === "clear") {
    const { confirm } = parseBody(body);
    if (confirm !== true) {
      return {
        status: 400,
        body: {
          error: "clear requires { confirm: true } in the body — guards against accidental wipe.",
        },
      };
    }
    const dropped = clearProjectShellAllowed(cwd, ctx.configPath);
    if (dropped > 0) {
      ctx.audit?.({
        ts: Date.now(),
        action: "clear-allowlist",
        payload: { dropped, project: cwd },
      });
    }
    return { status: 200, body: { dropped } };
  }

  return { status: 405, body: { error: `method ${method} not supported on this path` } };
}
