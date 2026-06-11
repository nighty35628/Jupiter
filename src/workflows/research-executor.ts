import { webSearchEndpoint, webSearchEngine } from "../config.js";
import {
  type LibrarySearchResult,
  searchLibrarySourcesForWorkspace,
} from "../desktop/library-store.js";
import { type SearchResult, type WebSearchOptions, webSearch } from "../tools/web.js";
import type { ResearchWorkflowPlan } from "./research.js";
import { buildResearchAgentPrompt } from "./research.js";
import type { WorkflowAgentInput, WorkflowAgentResult } from "./runner.js";
import type { WorkflowSource } from "./types.js";

export interface ResearchWorkflowExecutorOptions {
  readonly plan: ResearchWorkflowPlan;
  readonly userPrompt: string;
  readonly workspaceDir?: string;
  readonly configPath?: string;
  readonly jupiterHome?: string;
  readonly searchWeb?: (
    query: string,
    options: WebSearchOptions,
  ) => Promise<readonly SearchResult[]>;
  readonly searchLibrary?: typeof searchLibrarySourcesForWorkspace;
}

export function createResearchWorkflowAgentExecutor(
  opts: ResearchWorkflowExecutorOptions,
): (input: WorkflowAgentInput) => Promise<WorkflowAgentResult> {
  const searchWeb = opts.searchWeb ?? webSearch;
  const searchLibrary = opts.searchLibrary ?? searchLibrarySourcesForWorkspace;

  return async (input) => {
    const check = opts.plan.checks.find((entry) => entry.id === input.phase) ?? opts.plan.checks[0];
    if (!check) {
      throw new Error(`No research check configured for workflow: ${opts.plan.id}`);
    }
    const prompt = buildResearchAgentPrompt(check, {
      userPrompt: opts.userPrompt,
      workflowTitle: opts.plan.title,
    });
    const query = `${opts.userPrompt} ${check.id}`;
    const sources: WorkflowSource[] = [];
    const lines: string[] = [`${check.title}:`];
    const caveats: string[] = [];

    try {
      const results = await searchWeb(query, {
        topK: 5,
        engine: opts.configPath ? webSearchEngine(opts.configPath) : webSearchEngine(),
        endpoint: opts.configPath ? webSearchEndpoint(opts.configPath) : webSearchEndpoint(),
        configPath: opts.configPath,
      });
      if (results.length === 0) {
        caveats.push("web_search returned no results");
      }
      for (const result of results.slice(0, 5)) {
        lines.push(`- ${result.title}: ${result.snippet || result.answer || result.url}`);
        if (result.url) sources.push({ title: result.title, url: result.url });
      }
    } catch (error) {
      caveats.push(`web_search failed: ${(error as Error).message}`);
    }

    if (opts.workspaceDir) {
      const library = searchLibrary(opts.workspaceDir, {
        query,
        topK: 3,
        jupiterHome: opts.jupiterHome,
      });
      appendLibraryResults(lines, sources, library);
    }

    if (caveats.length > 0) {
      lines.push("caveats:");
      for (const caveat of caveats) lines.push(`- ${caveat}`);
    }

    return {
      summary: lines.join("\n"),
      tokenUsage: estimateTokenUsage(prompt, lines.join("\n")),
      sources,
      result: {
        summary: lines.join("\n"),
        caveats,
      },
    };
  };
}

function appendLibraryResults(
  lines: string[],
  sources: WorkflowSource[],
  library: LibrarySearchResult,
): void {
  if (library.results.length === 0) return;
  lines.push("workspace library:");
  for (const hit of library.results.slice(0, 3)) {
    lines.push(`- ${hit.title}: ${hit.text.slice(0, 240)}`);
    sources.push({
      title: hit.title,
      ...(hit.url ? { url: hit.url } : { path: `library:${hit.sourceId}` }),
    });
  }
}

function estimateTokenUsage(prompt: string, output: string) {
  const promptTokens = Math.ceil(prompt.length / 4);
  const completionTokens = Math.ceil(output.length / 4);
  return {
    prompt: promptTokens,
    completion: completionTokens,
    total: promptTokens + completionTokens,
  };
}
