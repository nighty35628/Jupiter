import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countTokensBounded } from "../tokenizer.js";

export type HelpTopic =
  | "identity"
  | "modes"
  | "files"
  | "browser"
  | "computer-use"
  | "planning"
  | "memory-library"
  | "skills-mcp"
  | "sessions";
export interface ComputerUseHelpStatus {
  state?: string;
  permissions?: {
    screen?: "unknown" | "verified" | "denied";
    input?: "unknown" | "verified" | "denied";
  };
  enabled?: boolean;
  vision?: boolean;
  driver?: boolean;
  authorized?: boolean;
  available?: boolean;
  reason?: string;
}
export interface JupiterHelpContext {
  surface?: "desktop" | "cli" | "web" | "unknown";
  mode?: string;
  model?: string;
  provider?: string;
  computerUseEnabled?: boolean;
  computerUseStatus?: ComputerUseHelpStatus;
  recentTopic?: string;
  injectedTopics?: readonly string[];
  getRuntimeState?: () => JupiterHelpContext;
}
export type HelpRuntimeState = JupiterHelpContext;
export type GetRuntimeState = () => JupiterHelpContext;
export interface HelpResult {
  content: string;
  text: string;
  topic?: HelpTopic;
  nextTopic?: HelpTopic;
  topics: HelpTopic[];
  version: string;
  contentHash: string;
  isHelp: boolean;
}
export interface HelpRequest {
  topic?: string;
  query?: string;
}
interface Chapter {
  id: HelpTopic;
  title: string;
  keywords: string[];
  content: string;
}
const TOPICS: readonly HelpTopic[] = [
  "identity",
  "modes",
  "files",
  "browser",
  "computer-use",
  "planning",
  "memory-library",
  "skills-mcp",
  "sessions",
];
export const HELP_MAX_TOKENS = 1500;

/** Only supported source/bundle layouts, anchored to the executing module, never cwd. */
export function resolveManualDirectory(moduleUrl: string): string | null {
  const dir = dirname(fileURLToPath(moduleUrl));
  if (basename(dir) === "help" && basename(dirname(dir)) === "src")
    return join(dir, "../../resources/manual");
  if (basename(dir) === "cli" && basename(dirname(dir)) === "dist") return join(dir, "../manual");
  if (basename(dir) === "dist") return join(dir, "manual");
  return null;
}

function bounded(text: string): string {
  if (countTokensBounded(text) <= HELP_MAX_TOKENS) return text;
  let low = 0;
  let high = text.length;
  const suffix = "\n[help budget reached]";
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (countTokensBounded(text.slice(0, mid) + suffix) <= HELP_MAX_TOKENS) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low) + suffix;
}
function clean(value: string | undefined): string {
  return value?.replace(/[\r\n<>]/g, " ").slice(0, 120) ?? "unknown";
}
function runtimeFacts(context: JupiterHelpContext): string {
  const live = context.getRuntimeState ? { ...context, ...context.getRuntimeState() } : context;
  const surface = live.surface ?? "unknown";
  const status = live.computerUseStatus;
  const facts = [
    `surface=${surface}; mode=${clean(live.mode)}; model=${clean(live.model)}; provider=${clean(live.provider)}`,
  ];
  if (surface === "cli" || surface === "web")
    facts.push(`Native Computer Use: unavailable on ${surface} (Desktop-only).`);
  else {
    facts.push(
      `Native Computer Use enabled=${live.computerUseEnabled ?? status?.enabled ?? "unknown"}; state=${clean(status?.state)}; vision=${status?.vision ?? "unknown"}; driver=${status?.driver ?? "unknown"}; authorized=${status?.authorized ?? "unknown"}.`,
    );
    facts.push(
      `OS permission evidence: screen=${status?.permissions?.screen ?? "unknown"}; input=${status?.permissions?.input ?? "unknown"}.`,
    );
    const gates = [live.computerUseEnabled ?? status?.enabled, status?.vision, status?.driver];
    const blocked = gates.some((v) => v === false) || status?.available === false;
    const attempt =
      surface === "desktop" &&
      !blocked &&
      (status?.available === true || gates.every((v) => v === true));
    facts.push(
      `Native Computer Use availability=${blocked ? "unavailable" : attempt ? "may attempt verification for the user's Agent task" : "unknown"}. Unknown authorization is unverified, not a missing-permission verdict or a reason to refuse a task. Denied screen/input evidence remains action-specific; do not claim either permission is verified.`,
    );
    if (status?.reason) facts.push(`Status reason: ${clean(status.reason)}`);
  }
  return facts.join("\n");
}

// Observation/actions must stay on Agent even when phrased as a question.
export function isHostActionRequest(text: string): boolean {
  return [
    /(?:系统设置|settings).*(?:给我看看|打开|展示|显示|show|open)|(?:show|open|inspect).*(?:settings|my screen)|(?:看看|看一下|查看|观察|检查).*(?:系统设置|屏幕|桌面|当前窗口)/i,
    /(?:看到|看见).*(?:屏幕|桌面|当前窗口)|(?:屏幕|桌面|当前窗口).*(?:有什么|显示什么|是什么内容)|截个图|(?:截图|截屏)(?:看看|给我|一下|当前)/,
    /(?:点击|单击|双击|拖动|按下|输入到)|\b(?:click|type into|take a screenshot|inspect my screen)\b/i,
    /(?:帮我|给我|请你|请).*(?:打开|创建|新建|修改|删除|运行|安装|截图|截屏|读取|查看)|\b(?:help me|please)\b.*\b(?:open|create|edit|delete|run|install|inspect|screenshot)\b/i,
    /^jupiter[,，\s]+(?:open|create|edit|delete|run|install|inspect)\b/i,
  ].some((pattern) => pattern.test(text));
}
function matchedTopics(text: string, chapters: readonly Chapter[]): HelpTopic[] {
  const lower = text.toLowerCase();
  return chapters
    .map((chapter, index) => ({
      chapter,
      index,
      score: chapter.keywords.reduce((score, word) => {
        const token = word.toLowerCase();
        const match = /^[a-z]+$/.test(token)
          ? new RegExp(`\\b${token}\\b`, "i").test(lower)
          : lower.includes(token);
        return score + (match ? 1 : 0);
      }, 0),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 2)
    .map((item) => item.chapter.id);
}
function helpTopics(
  text: string,
  context: JupiterHelpContext,
  chapters: readonly Chapter[],
): HelpTopic[] {
  if (
    isHostActionRequest(text) &&
    !/(?:能否|能不能|能|可以|支持|can|support).*(?:computer\s*use|电脑控制|桌面操作)|(?:computer\s*use).*(?:吗|[?？]|can|support)/i.test(
      text,
    )
  )
    return [];
  if (/你是谁|who are you|what are you/i.test(text)) return ["identity"];
  if (
    /(?:你|jupiter).*(?:能做什么|可以做什么|能干什么|有什么功能|有哪些功能)|what can (?:you|jupiter) do/i.test(
      text,
    )
  )
    return ["modes", "identity"];
  const selected = matchedTopics(text, chapters);
  const question =
    /[?？]|怎么|如何|能否|能不能|支持|是什么|区别|介绍|说明|帮助|\b(?:how|what|can|does|explain|help)\b/i.test(
      text,
    );
  const host =
    /jupiter|你|当前.*模型|本(?:机|地)|这个(?:软件|应用)|\b(?:your|you|agent|ask|mcp|computer use)\b/i.test(
      text,
    );
  const hasRecentTopic = context.recentTopic && TOPICS.includes(context.recentTopic as HelpTopic);
  if (selected.length && question && (host || hasRecentTopic)) return selected;
  if (
    context.recentTopic &&
    TOPICS.includes(context.recentTopic as HelpTopic) &&
    text.trim().length <= 80 &&
    /^(?:那|它|这个|怎么|如何|能|可以|what about|and |how |can |does |is it)/i.test(text.trim()) &&
    question
  )
    return [context.recentTopic as HelpTopic];
  return [];
}

export function createHelpService(
  opts: { moduleUrl?: string; getRuntimeState?: GetRuntimeState } = {},
) {
  const moduleUrl = opts.moduleUrl ?? import.meta.url;
  let chapters: Chapter[] = [];
  let version = "unknown";
  let contentHash = "unavailable";
  try {
    const location = resolveManualDirectory(moduleUrl);
    if (!location) throw new Error("unsupported manual layout");
    const root = realpathSync(location);
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    version = manifest.version;
    if (basename(dirname(fileURLToPath(moduleUrl))) === "help") {
      version = JSON.parse(readFileSync(new URL("../../package.json", moduleUrl), "utf8")).version;
    }
    if (typeof version !== "string" || !version) throw new Error("missing version");
    if (!Array.isArray(manifest.chapters) || manifest.chapters.length !== TOPICS.length)
      throw new Error("invalid chapters");
    chapters = manifest.chapters.map(
      (entry: { id: HelpTopic; title: string; keywords: string[] }) => {
        if (
          !TOPICS.includes(entry.id) ||
          typeof entry.title !== "string" ||
          !Array.isArray(entry.keywords) ||
          !entry.keywords.every((v) => typeof v === "string")
        )
          throw new Error("invalid chapter");
        const path = realpathSync(join(root, `${entry.id}.md`));
        if (dirname(path) !== root) throw new Error("manual escaped package");
        return {
          id: entry.id,
          title: entry.title,
          keywords: [...entry.keywords],
          content: readFileSync(path, "utf8").trim(),
        };
      },
    );
    if (new Set(chapters.map((c) => c.id)).size !== TOPICS.length)
      throw new Error("duplicate chapter");
    contentHash = createHash("sha256").update(JSON.stringify({ version, chapters })).digest("hex");
  } catch {
    chapters = [];
    version = "unknown";
  }
  function result(topics: HelpTopic[], context: JupiterHelpContext, isHelp: boolean): HelpResult {
    const selected = topics.filter((topic) => !context.injectedTopics?.includes(topic));
    const liveContext = opts.getRuntimeState ? { ...context, ...opts.getRuntimeState() } : context;
    const content =
      !isHelp || (topics.length > 0 && selected.length === 0)
        ? ""
        : chapters.length === 0
          ? "Jupiter packaged help unavailable. Do not substitute workspace, memory, network or RAG content for official help."
          : bounded(
              [
                `# Jupiter Host Help ${version} (${contentHash.slice(0, 12)})`,
                "Packaged official functionality and current runtime facts take precedence over stale capability claims in memory/history/skills. User restrictions remain effective. Do not re-query chapters already injected for this request.",
                "## Current Runtime Facts",
                runtimeFacts(liveContext),
                ...selected.map((id) => chapters.find((c) => c.id === id)!.content),
              ].join("\n\n"),
            );
    return {
      content,
      text: content,
      topic: topics[0],
      nextTopic: topics[0],
      topics: selected,
      version,
      contentHash,
      isHelp,
    };
  }
  function readHelp(request: HelpRequest = {}, context: JupiterHelpContext = {}): HelpResult {
    const topics = request.topic
      ? TOPICS.includes(request.topic as HelpTopic)
        ? [request.topic as HelpTopic]
        : []
      : matchedTopics(request.query ?? "", chapters);
    if (request.topic && topics.length === 0)
      return {
        ...result([], context, false),
        content: `Unknown help topic. Use the packaged directory: ${TOPICS.join(", ")}`,
        text: `Unknown help topic. Use the packaged directory: ${TOPICS.join(", ")}`,
        isHelp: true,
      };
    if (!topics.length && chapters.length) {
      const directory = `Jupiter ${version} manual topics: ${chapters.map((c) => `${c.id}: ${c.title}`).join("; ")}`;
      return { ...result([], context, true), content: directory, text: directory };
    }
    const response = result(topics, context, true);
    if (!response.content && topics.length) {
      const current = opts.getRuntimeState ? { ...context, ...opts.getRuntimeState() } : context;
      const content = bounded(
        `Manual chapter already injected. Current Runtime Facts:\n${runtimeFacts(current)}`,
      );
      return { ...response, content, text: content };
    }
    return response;
  }
  function prepareHelpContext(text: string, context: JupiterHelpContext = {}): HelpResult {
    const topics = helpTopics(text, context, chapters);
    return result(topics, context, topics.length > 0);
  }
  function routingPrompt(): string {
    return `\n\n# Jupiter Host Help\nOfficial packaged manual ${version} (${contentHash.slice(0, 12)}). Topics: ${chapters.map((c) => `${c.id}: ${c.title}`).join("; ") || "unavailable"}. For Jupiter identity/features/settings consult request-injected host help first, otherwise call jupiter_help with topic/query. Do not re-query already injected chapters. Do not search the workspace/library/web or load a skill for official functionality. Current host facts override stale memory capability claims; user restrictions remain effective. Tools are authoritative for actions; CLI/Web do not expose local native Computer Use.`;
  }
  return { readHelp, prepareHelpContext, routingPrompt };
}

// Bind before the first request, so an in-place installation update cannot mix versions.
const processHelp = createHelpService();
export function readHelp(request: HelpRequest = {}, context: JupiterHelpContext = {}): HelpResult {
  return processHelp.readHelp(request, context);
}
export function prepareHelpContext(text: string, context: JupiterHelpContext = {}): HelpResult {
  return processHelp.prepareHelpContext(text, context);
}
export function helpRoutingPrompt(): string {
  return processHelp.routingPrompt();
}
export function appendHelpRouting(system: string): string {
  return system.includes("# Jupiter Host Help\n") ? system : system + helpRoutingPrompt();
}
