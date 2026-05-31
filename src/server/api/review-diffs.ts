import type { DashboardContext } from "../context.js";
import type { ApiResult } from "../router.js";

export async function handleReviewDiffs(
  method: string,
  _rest: string[],
  _body: string,
  _ctx: DashboardContext,
): Promise<ApiResult> {
  if (method !== "GET") return { status: 405, body: { error: "GET only" } };
  return { status: 200, body: [] };
}
