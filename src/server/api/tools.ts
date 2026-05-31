import type { DashboardContext } from "../context.js";
import type { ApiResult } from "../router.js";

export async function handleTools(
  method: string,
  _rest: string[],
  _body: string,
  ctx: DashboardContext,
): Promise<ApiResult> {
  if (method !== "GET") {
    return { status: 405, body: { error: "GET only" } };
  }
  if (!ctx.tools) {
    return {
      status: 503,
      body: {
        error:
          "live tools view requires an attached session — run `/dashboard` from inside `jupiter code` instead of standalone `jupiter dashboard`.",
        available: false,
      },
    };
  }
  const specs = ctx.tools.specs();
  // We deliberately surface the model-facing schema (`specs()` already
  // resolves auto-flattened forms) so what the SPA shows matches what
  // DeepSeek receives. ReadOnly + planMode flags come from the
  // internal definitions, accessed via `get()`.
  const items = specs.map((s) => {
    const def = ctx.tools!.get(s.function.name);
    return {
      name: s.function.name,
      description: s.function.description,
      schema: s.function.parameters,
      readOnly: Boolean(def?.readOnly),
      flattened: ctx.tools!.wasFlattened(s.function.name),
    };
  });
  return {
    status: 200,
    body: {
      planMode: ctx.tools.planMode,
      total: items.length,
      tools: items,
    },
  };
}
