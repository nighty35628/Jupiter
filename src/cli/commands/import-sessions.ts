import {
  type ExternalSessionSelection,
  type ExternalSessionSource,
  discoverExternalSessionCandidates,
  importExternalSession,
  importExternalSessions,
} from "../../session-import.js";

export interface ImportSessionsOptions {
  source?: string;
  path?: string;
  paths?: string[];
  name?: string;
  workspace?: string;
  summary?: string;
  force?: boolean;
  scan?: boolean;
  includeSubagents?: boolean;
}

export function importSessionsCommand(opts: ImportSessionsOptions): void {
  const source = opts.source ? normalizeSource(opts.source) : undefined;
  if (opts.source && !source) {
    console.error(`unsupported source "${opts.source}" (expected: claude or codex).`);
    process.exit(1);
  }
  if (opts.scan) {
    for (const candidate of discoverExternalSessionCandidates({
      includeSubagents: opts.includeSubagents,
    })) {
      const imported = candidate.imported ? " imported" : "";
      console.log(
        `${candidate.source}\t${candidate.messageCount}\t${candidate.summary ?? candidate.name}${imported}\t${candidate.path}`,
      );
    }
    return;
  }
  const paths = [...(opts.paths ?? []), ...(opts.path ? [opts.path] : [])];
  const hasPrefixedPath = paths.some((path) => /^(claude|codex):/.test(path));
  if (paths.length > 1 || hasPrefixedPath || (paths.length === 0 && source)) {
    const items: ExternalSessionSelection[] | undefined =
      paths.length > 0
        ? paths.map((path) => {
            const parsed = parsePathSelection(path, source);
            if (!parsed) {
              console.error(`cannot infer source for "${path}" -- pass --source claude|codex.`);
              process.exit(1);
            }
            return parsed;
          })
        : undefined;
    const result = importExternalSessions({
      sources: source ? [source] : undefined,
      items,
      workspace: opts.workspace,
      includeSubagents: opts.includeSubagents,
    });
    console.log(
      `imported ${result.imported} session(s), skipped ${result.skipped}, failed ${result.failed}.`,
    );
    return;
  }
  if (!source || paths.length !== 1) {
    console.error("pass --scan, --source <claude|codex>, or --path <jsonl>.");
    process.exit(1);
  }
  try {
    const result = importExternalSession({
      source,
      path: paths[0]!,
      name: opts.name,
      workspace: opts.workspace,
      summary: opts.summary,
      force: opts.force,
    });
    console.log(`imported ${result.messageCount} message(s) into session "${result.name}"`);
    console.log(`source: ${result.source}`);
    console.log(`file:   ${result.path}`);
    if (result.workspace) console.log(`workspace: ${result.workspace}`);
    if (result.summary) console.log(`summary:   ${result.summary}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    if (message.startsWith("target session already exists:")) {
      console.error("re-run with --force to overwrite, or pass --name <session>.");
    }
    process.exit(1);
  }
}

function normalizeSource(value: string): ExternalSessionSource | undefined {
  return value === "claude" || value === "codex" ? value : undefined;
}

function parsePathSelection(
  value: string,
  fallbackSource: ExternalSessionSource | undefined,
): ExternalSessionSelection | undefined {
  const match = /^(claude|codex):(.+)$/.exec(value);
  if (match) return { source: match[1] as ExternalSessionSource, path: match[2]! };
  return fallbackSource ? { source: fallbackSource, path: value } : undefined;
}
