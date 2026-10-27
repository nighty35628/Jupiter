/** Shared, dependency-free configuration contract for server and browser clients. */
export type WebSearchEngine =
  | "bing"
  | "bing-intl"
  | "searxng"
  | "metaso"
  | "baidu"
  | "tavily"
  | "perplexity"
  | "exa"
  | "brave"
  | "ollama"
  | "deepseek"
  | "deepseek-native";

export const WEB_SEARCH_ENGINES: readonly WebSearchEngine[] = [
  "bing",
  "bing-intl",
  "searxng",
  "metaso",
  "baidu",
  "tavily",
  "perplexity",
  "exa",
  "brave",
  "ollama",
  "deepseek",
  "deepseek-native",
];

export function isWebSearchEngine(value: unknown): value is WebSearchEngine {
  return typeof value === "string" && WEB_SEARCH_ENGINES.includes(value as WebSearchEngine);
}

/** Legacy preserves Ollama-search/Ollama-fetch coupling. */
export type WebFetchEngine = "legacy" | "http" | "ollama" | "deepseek";
export const WEB_FETCH_ENGINES: readonly WebFetchEngine[] = [
  "legacy",
  "http",
  "ollama",
  "deepseek",
];

export function isWebFetchEngine(value: unknown): value is WebFetchEngine {
  return typeof value === "string" && WEB_FETCH_ENGINES.includes(value as WebFetchEngine);
}
