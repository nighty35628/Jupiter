import type { LibraryRetrievalMode } from "../config.js";
import {
  type LibrarySourceKind,
  type LibraryStoreOptions,
  readLibrarySourceForWorkspace,
  searchLibrarySourcesForWorkspace,
} from "../desktop/library-store.js";
import type { ToolRegistry } from "../tools.js";

export interface LibraryToolsOptions extends LibraryStoreOptions {
  workspaceDir: string;
  retrievalMode?: () => LibraryRetrievalMode;
}

export function registerLibraryTools(
  registry: ToolRegistry,
  opts: LibraryToolsOptions,
): ToolRegistry {
  const disabled = () => opts.retrievalMode?.() === "off";
  const disabledResult = {
    error: "workspace library retrieval is disabled by user setting",
    disabledReason: "library-retrieval-off",
  };
  registry.register({
    name: "library_search",
    parallelSafe: true,
    readOnly: true,
    skipTruncationSave: true,
    description:
      "Search the current workspace library/资料库. Use this when the user asks to use saved sources, library materials, references, notes, imported web pages, or workspace knowledge. Returns ranked source chunks with sourceId/chunkId; call library_read to read the chosen chunk.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search terms or natural-language query for the saved library sources.",
        },
        topK: {
          type: "integer",
          description: "Maximum number of ranked results to return. Default 6, max 20.",
        },
        kind: {
          type: "string",
          enum: ["web", "file"],
          description: "Optional source kind filter.",
        },
      },
      required: ["query"],
    },
    fn: (args: { query: string; topK?: number; kind?: LibrarySourceKind }) => {
      if (disabled()) return disabledResult;
      return searchLibrarySourcesForWorkspace(opts.workspaceDir, {
        query: args.query,
        topK: Math.min(Math.max(args.topK ?? 6, 1), 20),
        kind: args.kind,
        jupiterHome: opts.jupiterHome,
      });
    },
  });

  registry.register({
    name: "library_read",
    parallelSafe: true,
    readOnly: true,
    skipTruncationSave: true,
    description:
      "Read extracted text from a saved workspace library source. Prefer passing a chunkId returned by library_search. The result includes source metadata so answers can cite what was actually read.",
    parameters: {
      type: "object",
      properties: {
        sourceId: {
          type: "string",
          description: "Library source id returned by library_search.",
        },
        chunkId: {
          type: "string",
          description: "Optional chunk id returned by library_search, such as '<sourceId>:0'.",
        },
        maxChars: {
          type: "integer",
          description: "Maximum characters to return when reading a whole source. Default 12000.",
        },
      },
      required: ["sourceId"],
    },
    fn: (args: { sourceId: string; chunkId?: string; maxChars?: number }) => {
      if (disabled()) return disabledResult;
      return readLibrarySourceForWorkspace(opts.workspaceDir, {
        sourceId: args.sourceId,
        chunkId: args.chunkId,
        maxChars: args.maxChars ? Math.min(Math.max(args.maxChars, 500), 40_000) : undefined,
        jupiterHome: opts.jupiterHome,
      });
    },
  });

  return registry;
}
