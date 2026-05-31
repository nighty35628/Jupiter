import { type CheckpointMeta, fmtAgo, listCheckpoints } from "../../code/checkpoints.js";
import type { DashboardContext } from "../context.js";
import type { ApiResult } from "../router.js";

export interface CheckpointItem {
  id: string;
  name: string;
  createdAt: number;
  source: string;
  fileCount: number;
  bytes: number;
  ago: string;
}

export async function handleCheckpoints(
  method: string,
  _rest: string[],
  _body: string,
  ctx: DashboardContext,
): Promise<ApiResult> {
  if (method !== "GET") return { status: 405, body: { error: "GET only" } };

  const rootDir = ctx.getCurrentCwd?.();
  if (!rootDir) return { status: 200, body: [] };

  const metas = listCheckpoints(rootDir);
  const items: CheckpointItem[] = metas.map((m: CheckpointMeta) => ({
    id: m.id,
    name: m.name,
    createdAt: m.createdAt,
    source: m.source,
    fileCount: m.fileCount,
    bytes: m.bytes,
    ago: fmtAgo(m.createdAt),
  }));

  return { status: 200, body: items };
}
