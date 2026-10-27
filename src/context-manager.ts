import { COMPACTION_SUMMARY_MARKER } from "@jupiter/core-utils";
import { messageImageTokens } from "./attachments/types.js";
import type { DeepSeekClient } from "./client.js";
import { Usage } from "./client.js";
import { healLoadedMessages } from "./loop.js";
import { compactionRequestTokens } from "./loop/compaction.js";
import { buildAssistantMessage } from "./loop/messages.js";
import {
  type SummaryFailure,
  SummaryRequestError,
  acceptedSummary,
  requestFoldSummary,
  withSummaryDeadline,
} from "./loop/summary.js";
import { DEFAULT_MAX_RESULT_CHARS } from "./mcp/registry.js";
import type { AppendOnlyLog } from "./memory/runtime.js";
import { rewriteSession } from "./memory/session.js";
import { type SessionStats, resolveContextTokens } from "./telemetry/stats.js";
import { countTokensBounded, estimateRequestTokens } from "./tokenizer.js";
import type { ChatMessage, ToolSpec } from "./types.js";

function extractPinnedConstraints(systemPrompt: string): string {
  // matchAll because the system prompt can carry multiple blocks under the same
  // prefix — e.g. global User memory + per-project User memory, or several
  // Project memory files. Single .match() would only grab the first.
  const pattern =
    /# (?:HIGH PRIORITY constraints|User memory|Project memory)[\s\S]*?(?=\n# |\n---|$)/g;
  return Array.from(systemPrompt.matchAll(pattern), (m) => m[0]).join("\n\n");
}

/** Auto-fold when a turn's response shows promptTokens above this fraction of ctxMax. */
export const HISTORY_FOLD_THRESHOLD = 0.75;
/** Tail budget after a normal fold, as a fraction of ctxMax. */
export const HISTORY_FOLD_TAIL_FRACTION = 0.2;
/** Above this fraction the normal fold's tail budget didn't buy enough headroom — fold harder. */
export const HISTORY_FOLD_AGGRESSIVE_THRESHOLD = 0.78;
/** Tail budget after an aggressive fold — half the normal one, sacrifices recent context for headroom. */
export const HISTORY_FOLD_AGGRESSIVE_TAIL_FRACTION = 0.1;
/** Skip the fold if the head wouldn't shrink the log by at least this fraction. */
export const HISTORY_FOLD_MIN_SAVINGS_FRACTION = 0.3;
/** Above this fraction we exit the turn with a summary instead of folding (defense in depth). */
export const FORCE_SUMMARY_THRESHOLD = 0.8;
/** Cost guard: large-window models can be expensive well before context pressure starts. */
export const COST_AWARE_FOLD_PROMPT_TOKENS = 160_000;
/** Cost-triggered folds keep a tight tail because the goal is spend reduction, not just headroom. */
export const COST_AWARE_FOLD_TAIL_TOKENS = 16_000;
/** Turn-start local estimate above this fraction triggers a pre-iter fold. Covers cases the
 * post-response fold can't (terminal prior turn, fresh session restore, huge user paste). */
export const TURN_START_FOLD_THRESHOLD = 0.9;
/** Hard deadline for semantic fold summaries so a hung request cannot stall the turn loop. */
export const HISTORY_FOLD_SUMMARY_TIMEOUT_MS = 15_000;
/** Manual /compact keeps a much smaller tail than automatic model-window compaction.
 *  Automatic folding is driven by context pressure; manual folding is an explicit
 *  user request to shrink the current session now. */
export const MANUAL_COMPACT_KEEP_RECENT_TOKENS = 16_000;
/** Prepended to fold summary content so the model knows it's a synthesized recap.
 *  Re-export of the shared constant so existing imports keep resolving. */
export const HISTORY_FOLD_MARKER = COMPACTION_SUMMARY_MARKER;
/** Header that precedes preserved skill bodies in a fold's synthesized assistant message. */
export const SKILL_PIN_MEMO_HEADER = "[Active skill memos — preserved verbatim across the fold:]";
export const FOLD_USER_TURNS_HEADER =
  "[Original user turns preserved across the fold — exact text until per-turn truncation:]";
export const FOLD_USER_TURN_MAX_CHARS = 600;
export const FOLD_USER_TURNS_MAX_CHARS = 12_000;
export const OLD_TOOL_RESULT_ELIDED_MARKER =
  "[old tool result elided from model context; full output remains in the session log]";
export const OLD_TOOL_RESULT_PRUNE_MIN_CHARS = 12_000;
/** Matches the wrapper emitted by `run_skill` so the fold can lift bodies out before summarizing. */
const SKILL_PIN_REGEX = /<skill-pin name="([^"]+)">\n[\s\S]*?\n<\/skill-pin>/g;

export interface ContextManagerDeps {
  client: DeepSeekClient;
  log: AppendOnlyLog;
  stats: SessionStats;
  getSessionBinding: () => { sessionName: string | null; epoch: number };
  getAbortSignal: () => AbortSignal;
  getCurrentTurn: () => number;
  getSystemPrompt: () => string;
  /** Reuses the live prefix → fold summary call shares the cached bytes the main agent already paid for. */
  getToolSpecs?: () => readonly ToolSpec[];
  getFewShots?: () => readonly ChatMessage[];
  getActiveImageIds?: () => readonly string[];
  /** Live request prefix/context around an uncommitted replacement; never writes. */
  buildReplacementMessages?: (history: ChatMessage[]) => ChatMessage[];
  /** Installs a same-model total-window output reserve, only after durable/in-memory commit. */
  onFoldOutputCap?: (model: string, maxTokens: number) => void;
  summaryTimeoutMs?: number;
  /** Fired when the message log was rewritten by fold; lets the loop drop session-scoped caches whose validity rested on the elided history (e.g. read-before-edit tracker). */
  onLogRewrite?: () => void;
  /** Run-local persistence override; context folds must not rewrite raw turn records. */
  persistMessages?: (messages: ChatMessage[], reason: "context" | "history") => void;
  /** Forced summaries are raw assistant output, unlike a history fold. */
  persistForcedSummary?: (summary: ChatMessage, replacesTail: boolean) => ChatMessage | undefined;
}

export type PostUsageDecisionKind = "none" | "fold" | "exit-with-summary";

export interface PostUsageDecision {
  kind: PostUsageDecisionKind;
  promptTokens: number;
  ctxMax: number;
  ratio: number;
  /** Token budget for the recent tail when kind === "fold"; smaller in the aggressive band. */
  tailBudget?: number;
  /** True when this fold is in the 70-85% band — used in user-facing messaging. */
  aggressive?: boolean;
}

export interface FoldResult {
  folded: boolean;
  beforeMessages: number;
  afterMessages: number;
  summaryChars: number;
  reason?:
    | "empty"
    | "already-small"
    | "tail-boundary-missing"
    | "insufficient-savings"
    | SummaryFailure
    | "session-changed"
    | "persistence-failed"
    | "log-changed"
    | "replacement-over-limit"
    | "output-cap-unavailable";
  totalTokens?: number;
  headTokens?: number;
  tailTokens?: number;
  tailBudget?: number;
}

function buildFoldSummaryInstruction(pinnedSkillNames: string[]): string {
  const base =
    "Summarize the conversation above as one self-contained recap. Start with a compact " +
    "Facts digest paragraph containing durable facts, decisions, constraints, and current state. " +
    "Then add only the open work that still matters. Preserve the user's " +
    "ORIGINAL OBJECTIVE (never paraphrase away negative constraints like 'do NOT do X'), all " +
    "'do not' / 'never' / 'avoid' instructions, decisions reached, files inspected or modified, " +
    "tool results still relevant, and any open todos. Skip turn-by-turn play-by-play. " +
    "Output plain prose only — no tool calls, no markdown headings, no SEARCH/REPLACE blocks.";
  if (pinnedSkillNames.length === 0) return base;
  const list = pinnedSkillNames.map((n) => `"${n}"`).join(", ");
  return `${base} The following skill memos are pinned verbatim and appended after your summary — do NOT quote or paraphrase their bodies: ${list}.`;
}

function stringifyUserContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function truncateForFold(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 18))}\n[truncated]`;
}

function buildPreservedUserTurns(head: ChatMessage[]): string {
  const chunks: string[] = [];
  let total = 0;
  let userIndex = 0;
  for (const msg of head) {
    if (msg.role !== "user") continue;
    userIndex++;
    const content = truncateForFold(stringifyUserContent(msg.content), FOLD_USER_TURN_MAX_CHARS);
    const chunk = `User turn ${userIndex}:\n${content}`;
    const sep = chunks.length === 0 ? "" : "\n\n";
    if (total + sep.length + chunk.length > FOLD_USER_TURNS_MAX_CHARS) {
      chunks.push("[older preserved user turns omitted to stay within fold budget]");
      break;
    }
    chunks.push(chunk);
    total += sep.length + chunk.length;
  }
  return chunks.length > 0 ? `\n\n${FOLD_USER_TURNS_HEADER}\n\n${chunks.join("\n\n")}` : "";
}

export function pruneOldToolResultsForModelContext(
  messages: readonly ChatMessage[],
  opts: { maxToolResultChars?: number } = {},
): ChatMessage[] {
  const maxToolResultChars = opts.maxToolResultChars ?? OLD_TOOL_RESULT_PRUNE_MIN_CHARS;
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex <= 0) return [...messages];
  return messages.map((message, index) => {
    if (index >= lastUserIndex) return message;
    if (message.role !== "tool") return message;
    const content = typeof message.content === "string" ? message.content : "";
    if (content.length <= maxToolResultChars) return message;
    return {
      ...message,
      content: OLD_TOOL_RESULT_ELIDED_MARKER,
    };
  });
}

// Dedupe by name, last invocation wins. Read-only — leaves head bytes unchanged so the
// summarizer call's prefix still matches what the main agent already cached.
function collectPinnedSkills(head: ChatMessage[]): { names: string[]; bodies: string[] } {
  const pinned = new Map<string, string>();
  for (const msg of head) {
    if (typeof msg.content !== "string") continue;
    SKILL_PIN_REGEX.lastIndex = 0;
    for (const match of msg.content.matchAll(SKILL_PIN_REGEX)) {
      const name = match[1] as string;
      const full = match[0];
      pinned.delete(name);
      pinned.set(name, full);
    }
  }
  return { names: [...pinned.keys()], bodies: [...pinned.values()] };
}

export class ContextManager {
  constructor(private deps: ContextManagerDeps) {}

  /** Real-time token count of the current log — used by Desktop to refresh the
   *  context meter after /compact when no API usage event is available. */
  getLogTokens(): number {
    const entries = this.deps.log.toFullHistory();
    let total = 0;
    for (const e of entries) {
      const content = typeof e.content === "string" ? e.content : "";
      total += countTokensBounded(content) + messageImageTokens(e);
      if (e.role === "assistant" && Array.isArray(e.tool_calls) && e.tool_calls.length > 0) {
        total += countTokensBounded(JSON.stringify(e.tool_calls));
      }
    }
    return total;
  }

  /** Decision after a turn's response — fold, exit with summary, or carry on. */
  decideAfterUsage(
    usage: Usage | null,
    model: string,
    alreadyFoldedThisTurn: boolean,
  ): PostUsageDecision {
    const ctxMax = resolveContextTokens(model);
    if (!usage) return { kind: "none", promptTokens: 0, ctxMax, ratio: 0 };
    const ratio = usage.promptTokens / ctxMax;
    const base = { promptTokens: usage.promptTokens, ctxMax, ratio };
    if (ratio > FORCE_SUMMARY_THRESHOLD) {
      return { kind: "exit-with-summary", ...base };
    }
    if (alreadyFoldedThisTurn) return { kind: "none", ...base };
    if (ratio > HISTORY_FOLD_AGGRESSIVE_THRESHOLD) {
      return {
        kind: "fold",
        ...base,
        tailBudget: Math.floor(ctxMax * HISTORY_FOLD_AGGRESSIVE_TAIL_FRACTION),
        aggressive: true,
      };
    }
    if (ratio > HISTORY_FOLD_THRESHOLD) {
      return {
        kind: "fold",
        ...base,
        tailBudget: Math.floor(ctxMax * HISTORY_FOLD_TAIL_FRACTION),
        aggressive: false,
      };
    }
    if (usage.promptTokens >= COST_AWARE_FOLD_PROMPT_TOKENS) {
      return {
        kind: "fold",
        ...base,
        tailBudget: Math.min(COST_AWARE_FOLD_TAIL_TOKENS, Math.floor(ctxMax * 0.2)),
        aggressive: false,
      };
    }
    return { kind: "none", ...base };
  }

  /** Turn-start estimate vs ctxMax — caller folds if the ratio crosses
   *  TURN_START_FOLD_THRESHOLD. Replaces the old preflight/mechanical pair. */
  estimateTurnStart(
    messages: ChatMessage[],
    toolSpecs: ReadonlyArray<unknown> | undefined | null,
    model: string,
  ): { estimateTokens: number; ctxMax: number; ratio: number } {
    const ctxMax = resolveContextTokens(model);
    const visible = this.deps.client.supportsImages(model)
      ? messages
      : messages.map((message) => {
          if (!message.attachments?.length) return message;
          const { attachments, ...rest } = message;
          return {
            ...rest,
            content: `${rest.content ?? ""}\n${attachments.map((image) => `[Historical image ${image.name}: ${image.id}]`).join("\n")}`,
          };
        });
    const estimate = estimateRequestTokens(visible, toolSpecs ?? null, true);
    return { estimateTokens: estimate, ctxMax, ratio: estimate / ctxMax };
  }

  async fold(
    model: string,
    opts?: { keepRecentTokens?: number; requireTailBoundary?: boolean; signal?: AbortSignal },
  ): Promise<FoldResult> {
    const deadline = Date.now() + (this.deps.summaryTimeoutMs ?? HISTORY_FOLD_SUMMARY_TIMEOUT_MS);
    const ctxMax = resolveContextTokens(model);
    const tailBudget = opts?.keepRecentTokens ?? Math.floor(ctxMax * HISTORY_FOLD_TAIL_FRACTION);
    const bindingAtStart = this.deps.getSessionBinding();
    const logRevisionAtStart = this.deps.log.revision;
    const all = this.deps.log.toFullHistory();
    const noop: FoldResult = {
      folded: false,
      beforeMessages: all.length,
      afterMessages: all.length,
      summaryChars: 0,
    };
    if (all.length === 0) return { ...noop, reason: "empty", tailBudget };

    // Per-message token cost includes tool_calls JSON; otherwise heavy tool-call
    // arguments slip through the tail-budget check and the boundary slides past
    // the active tool turn. No chat-template wrapper here — that would double-count.
    const tokenCounts = all.map((m) => {
      let n =
        countTokensBounded(typeof m.content === "string" ? m.content : "") + messageImageTokens(m);
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        n += countTokensBounded(JSON.stringify(m.tool_calls));
      }
      return n;
    });
    const totalTokens = tokenCounts.reduce((a, b) => a + b, 0);

    let cumTokens = 0;
    let boundary = all.length;
    for (let i = all.length - 1; i >= 0; i--) {
      if (cumTokens + tokenCounts[i]! > tailBudget) break;
      cumTokens += tokenCounts[i]!;
      if (all[i]!.role === "user") boundary = i;
    }
    if (boundary <= 0) {
      return {
        ...noop,
        reason: "already-small",
        totalTokens,
        headTokens: 0,
        tailTokens: cumTokens,
        tailBudget,
      };
    }
    // Preflight-only: refuse when no user landed in tail — the active tool turn
    // would be wiped. Default fold path (post-response) tolerates empty tail so
    // cache-aligned summary tests still exercise the "summarize all" shape.
    if (opts?.requireTailBoundary && boundary >= all.length) {
      return {
        ...noop,
        reason: "tail-boundary-missing",
        totalTokens,
        headTokens: totalTokens,
        tailTokens: cumTokens,
        tailBudget,
      };
    }

    const head = all.slice(0, boundary);
    const tail = all.slice(boundary);
    const headTokens = totalTokens - cumTokens;
    if (headTokens < totalTokens * HISTORY_FOLD_MIN_SAVINGS_FRACTION) {
      return {
        ...noop,
        reason: "insufficient-savings",
        totalTokens,
        headTokens,
        tailTokens: cumTokens,
        tailBudget,
      };
    }

    const { names: pinnedNames, bodies: pinnedBodies } = collectPinnedSkills(head);
    const summary = await this.summarizeForFold(head, pinnedNames, deadline, opts?.signal, model);
    if (!summary.content) {
      return {
        ...noop,
        reason: summary.reason ?? "summary-empty",
        totalTokens,
        headTokens,
        tailTokens: cumTokens,
        tailBudget,
      };
    }

    const memoTail =
      pinnedBodies.length > 0 ? `\n\n${SKILL_PIN_MEMO_HEADER}\n\n${pinnedBodies.join("\n\n")}` : "";
    const userTurnsTail = buildPreservedUserTurns(head);
    const constraints = extractPinnedConstraints(this.deps.getSystemPrompt());
    const constraintTail = constraints
      ? `\n\n[PINNED CONSTRAINTS — preserved verbatim]\n\n${constraints}`
      : "";
    const summaryMsg = buildAssistantMessage(
      HISTORY_FOLD_MARKER + summary.content + userTurnsTail + memoTail + constraintTail,
      [],
      model,
      summary.reasoningContent,
    );
    const images = new Map(
      head
        .flatMap((message) => [
          ...(message.attachments ?? []),
          ...(message.sourceAttachments ?? []),
        ])
        .map((image) => [image.id, image]),
    );
    if (images.size) summaryMsg.sourceAttachments = [...images.values()];
    const replacement = [summaryMsg, ...tail];
    const turnSignal = opts?.signal ?? this.deps.getAbortSignal();
    let replacementFailure: FoldResult["reason"];
    try {
      const messages = this.deps.buildReplacementMessages?.(replacement) ?? [
        { role: "system" as const, content: this.deps.getSystemPrompt() },
        ...(this.deps.getFewShots?.() ?? []),
        ...replacement,
      ];
      if (
        (await withSummaryDeadline(turnSignal, deadline - Date.now(), (signal) =>
          compactionRequestTokens(this.deps.client, {
            model,
            messages,
            tools: this.deps.getToolSpecs?.(),
            activeImageIds: this.deps.getActiveImageIds?.() ?? [],
            signal,
          }),
        )) > Math.min(resolveContextTokens(model), summary.promptBudget ?? Number.POSITIVE_INFINITY)
      )
        replacementFailure = "replacement-over-limit";
    } catch (error) {
      replacementFailure =
        error instanceof SummaryRequestError
          ? error.reason
          : turnSignal.aborted
            ? "summary-cancelled"
            : "summary-failed";
    }
    // Validation yields while counting the complete replacement. Check the
    // epoch/revision/cancellation *after* it, immediately before persistence.
    const currentBinding = this.deps.getSessionBinding();
    if ((opts?.signal ?? this.deps.getAbortSignal()).aborted) {
      return {
        ...noop,
        reason: "summary-cancelled",
        totalTokens,
        headTokens,
        tailTokens: cumTokens,
        tailBudget,
      };
    }
    if (currentBinding.epoch !== bindingAtStart.epoch) {
      return {
        ...noop,
        reason: "session-changed",
        totalTokens,
        headTokens,
        tailTokens: cumTokens,
        tailBudget,
      };
    }
    if (this.deps.log.revision !== logRevisionAtStart) {
      return {
        ...noop,
        reason: "log-changed",
        totalTokens,
        headTokens,
        tailTokens: cumTokens,
        tailBudget,
      };
    }

    if (Date.now() >= deadline) replacementFailure = "summary-timeout";

    if (!replacementFailure && summary.outputCap !== undefined && !this.deps.onFoldOutputCap) {
      replacementFailure = "output-cap-unavailable";
    }

    if (replacementFailure)
      return {
        ...noop,
        reason: replacementFailure,
        totalTokens,
        headTokens,
        tailTokens: cumTokens,
        tailBudget,
      };
    if (
      (images.size && !currentBinding.sessionName && !this.deps.persistMessages) ||
      ((currentBinding.sessionName || this.deps.persistMessages) &&
        !this.persistRewrite(currentBinding.sessionName, replacement))
    ) {
      return {
        ...noop,
        reason: "persistence-failed",
        totalTokens,
        headTokens,
        tailTokens: cumTokens,
        tailBudget,
      };
    }
    this.deps.log.compactInPlace(replacement);
    if (summary.outputCap !== undefined) this.deps.onFoldOutputCap?.(model, summary.outputCap);
    this.deps.onLogRewrite?.();
    return {
      folded: true,
      beforeMessages: all.length,
      afterMessages: replacement.length,
      summaryChars: summary.content.length,
      totalTokens,
      headTokens,
      tailTokens: cumTokens,
      tailBudget,
    };
  }

  /** Drop a trailing in-flight assistant-with-tool_calls before a forced summary. Tail-only mutation; prefix cache safe. */
  trimTrailingToolCalls(): boolean {
    const tail = this.deps.log.entries[this.deps.log.entries.length - 1];
    if (
      !tail ||
      tail.role !== "assistant" ||
      !Array.isArray(tail.tool_calls) ||
      tail.tool_calls.length === 0
    ) {
      return false;
    }
    const kept = this.deps.log.toFullHistory().slice(0, -1);
    if (
      !this.persistRewrite(this.deps.getSessionBinding().sessionName, kept, "history") &&
      this.deps.persistMessages
    )
      return false;
    this.deps.log.compactInPlace(kept);
    return true;
  }

  commitForcedSummary(summary: ChatMessage, sessionName: string | null): boolean {
    const history = this.deps.log.toFullHistory();
    const last = history.at(-1);
    const replacement = [
      ...(last?.role === "assistant" && last.tool_calls?.length ? history.slice(0, -1) : history),
      summary,
    ];
    if (this.deps.persistForcedSummary) {
      try {
        const stored = this.deps.persistForcedSummary(
          summary,
          Boolean(last?.role === "assistant" && last.tool_calls?.length),
        );
        if (stored) replacement[replacement.length - 1] = stored;
      } catch {
        return false;
      }
    } else if (
      (sessionName || this.deps.persistMessages) &&
      !this.persistRewrite(sessionName, replacement, "history")
    )
      return false;
    this.deps.log.compactInPlace(replacement);
    if (last?.tool_calls?.length) this.deps.onLogRewrite?.();
    return true;
  }

  private async summarizeForFold(
    messagesToSummarize: ChatMessage[],
    pinnedSkillNames: string[],
    deadline: number,
    signal?: AbortSignal,
    activeModel?: string,
  ): Promise<{
    content: string;
    reasoningContent: string;
    reason?: SummaryFailure;
    promptBudget?: number;
    outputCap?: number;
  }> {
    const hasImages = messagesToSummarize.some((message) => message.attachments?.length);
    const summaryModel =
      hasImages || !this.deps.client.officialDeepSeek ? activeModel! : "deepseek-flash";
    const healed = healLoadedMessages(messagesToSummarize, DEFAULT_MAX_RESULT_CHARS).messages;
    const agentSystem = this.deps.getSystemPrompt();
    const fewShots = this.deps.getFewShots?.() ?? [];
    const tools = this.deps.getToolSpecs?.() ?? [];
    const instruction = buildFoldSummaryInstruction(pinnedSkillNames);
    const messages: ChatMessage[] = [
      { role: "system", content: agentSystem },
      ...fewShots.map((m) => ({ ...m })),
      ...healed,
      { role: "user", content: instruction },
    ];
    const turnSignal = signal ?? this.deps.getAbortSignal();
    try {
      const resp = await requestFoldSummary(
        this.deps.client,
        {
          model: summaryModel,
          messages,
          tools: tools.length ? (tools as ToolSpec[]) : undefined,
          signal: turnSignal,
          activeImageIds: this.deps.getActiveImageIds?.() ?? [],
          thinking: "disabled",
        },
        deadline - Date.now(),
        { historyStart: 1 + fewShots.length, historyEnd: messages.length - 1 },
      );
      this.deps.stats.record(this.deps.getCurrentTurn(), summaryModel, resp.usage ?? new Usage());
      const contextBudget =
        resp.contextBudget?.model === activeModel ? resp.contextBudget : undefined;
      return {
        content: acceptedSummary(resp),
        reasoningContent: resp.reasoningContent ?? "",
        promptBudget: contextBudget?.promptTokens,
        outputCap: contextBudget?.kind === "total" ? contextBudget.maxTokens : undefined,
      };
    } catch (error) {
      return {
        content: "",
        reasoningContent: "",
        reason:
          error instanceof SummaryRequestError
            ? error.reason
            : turnSignal.aborted
              ? "summary-cancelled"
              : "summary-failed",
      };
    }
  }

  private persistRewrite(
    sessionName: string | null,
    messages: ChatMessage[],
    reason: "context" | "history" = "context",
  ): boolean {
    try {
      if (this.deps.persistMessages) {
        this.deps.persistMessages(messages, reason);
        return true;
      }
      if (!sessionName) return false;
      rewriteSession(sessionName, messages);
      return true;
    } catch {
      // Keep the in-memory history unchanged when its durable replacement fails.
      return false;
    }
  }
}
