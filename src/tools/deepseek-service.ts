import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ResolvedDeepSeekSearchCredential } from "../config.js";
import type { ServiceCallReport } from "../tools.js";
import { abortable, discardWebBody, readWebBody, withWebDeadline } from "./web-response.js";

export const DEEPSEEK_SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search";
export const DEEPSEEK_FETCH_ENDPOINT = "https://api.deepseek.com/v1/tools/fetch";
export const DEEPSEEK_SERVICE_MAX_BYTES = 10 * 1024 * 1024;

export interface DeepSeekServiceOptions {
  credential: Readonly<ResolvedDeepSeekSearchCredential>;
  signal?: AbortSignal;
  /** Actual user cancellation, when signal also contains an enclosing deadline. */
  callerSignal?: AbortSignal | null;
  timeoutMs?: number;
  onServiceCall?: (report: ServiceCallReport) => void;
}

const searchSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string(),
      summary: z.string(),
      content: z.string(),
    }),
  ),
});
const fetchSchema = z.object({ title: z.string(), content: z.string() });

async function request<T>(
  operation: ServiceCallReport["operation"],
  body: object,
  schema: z.ZodType<T>,
  opts: DeepSeekServiceOptions,
  hasResults: (payload: T) => boolean,
): Promise<T> {
  opts.signal?.throwIfAborted();
  const apiKey = opts.credential.apiKey;
  if (!apiKey) {
    throw new Error(
      opts.credential.state === "needs_dedicated_key"
        ? "DeepSeek Search/Fetch needs a dedicated DEEPSEEK_SEARCH_API_KEY for a third-party model endpoint"
        : "DeepSeek Search/Fetch needs DEEPSEEK_SEARCH_API_KEY or an official DeepSeek main API key",
    );
  }
  const requestId = randomUUID();
  let dispatched = false;
  let status: ServiceCallReport["status"] = "failed";
  let httpStatus: number | undefined;
  let results: boolean | undefined;
  try {
    return await withWebDeadline(opts.timeoutMs ?? 15_000, opts.signal, async (signal) => {
      signal.throwIfAborted();
      dispatched = true;
      const response = await abortable(
        fetch(operation === "web_search" ? DEEPSEEK_SEARCH_ENDPOINT : DEEPSEEK_FETCH_ENDPOINT, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        }),
        signal,
      );
      httpStatus = response.status;
      if (response.status !== 200) {
        discardWebBody(response);
        // Do not echo service error bodies: they may contain submitted URLs or credentials.
        throw new Error(
          `DeepSeek ${operation} failed (HTTP ${response.status}); no backend fallback`,
        );
      }
      const raw = await readWebBody(response, DEEPSEEK_SERVICE_MAX_BYTES, signal);
      let data: T;
      try {
        data = schema.parse(JSON.parse(raw));
      } catch {
        throw new Error(
          `DeepSeek ${operation} returned malformed JSON or an invalid response schema`,
        );
      }
      signal.throwIfAborted();
      results = hasResults(data);
      status = "succeeded";
      return data;
    });
  } catch (error) {
    const caller = opts.callerSignal === undefined ? opts.signal : opts.callerSignal;
    if (caller?.aborted) status = "cancelled";
    throw error;
  } finally {
    try {
      if (dispatched)
        opts.onServiceCall?.({
          kind: "service-call",
          provider: "deepseek",
          operation,
          requestId,
          costKnown: false,
          usageKnown: false,
          status,
          requestMayHaveReachedService: true,
          ...(httpStatus !== undefined ? { httpStatus } : {}),
          ...(results !== undefined ? { hasResults: results } : {}),
        });
    } catch {
      /* Best-effort accounting must not mask success, failure or cancellation. */
    }
  }
}

export async function searchDeepSeek(query: string, count: number, opts: DeepSeekServiceOptions) {
  if (typeof query !== "string" || !query.trim() || [...query].length > 128) {
    throw new Error("DeepSeek search query must contain 1-128 Unicode characters and not be blank");
  }
  if (!Number.isInteger(count) || count < 1 || count > 50)
    throw new Error("DeepSeek search count must be 1-50");
  const data = await request(
    "web_search",
    { query, count, need_content: false },
    searchSchema,
    opts,
    (data) => data.results.length > 0,
  );
  return data.results
    .slice(0, count)
    .filter((item) => {
      try {
        const url = new URL(item.url);
        return /^https?:$/.test(url.protocol) && !url.username && !url.password;
      } catch {
        return false;
      }
    })
    .map((item) => ({ title: item.title, url: item.url, snippet: item.summary || item.snippet }));
}

export function fetchDeepSeek(url: string, opts: DeepSeekServiceOptions) {
  const parsed = new URL(url);
  if (
    url.length > 8192 ||
    !/^https?:$/.test(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "DeepSeek fetch requires an HTTP(S) URL of at most 8192 characters without credentials",
    );
  }
  return request("web_fetch", { url }, fetchSchema, opts, (data) => Boolean(data.content.trim()));
}
