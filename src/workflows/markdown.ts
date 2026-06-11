import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type LibrarySource,
  type LibraryStoreOptions,
  addLibrarySourceForWorkspace,
} from "../desktop/library-store.js";
import type { WorkflowRun } from "./types.js";

export interface SaveWorkflowRunToLibraryResult {
  readonly reportPath: string;
  readonly source: LibrarySource;
}

export function formatWorkflowRunMarkdown(run: WorkflowRun): string {
  const lines = [
    `# ${run.title}`,
    "",
    `- Run ID: ${run.id}`,
    `- Workflow: ${run.workflowId}@${run.workflowVersion}`,
    `- Status: ${run.status}`,
    `- Phase: ${run.phase ?? "-"}`,
    `- Started: ${run.startedAt}`,
    ...(run.completedAt ? [`- Completed: ${run.completedAt}`] : []),
    `- Total tokens: ${run.tokenUsage.total}`,
    "",
  ];

  const resultSummary = extractResultSummary(run.result);
  if (resultSummary) {
    lines.push("## Summary", "", resultSummary, "");
  }

  if (run.agents.length > 0) {
    lines.push("## Checks", "");
    for (const agent of run.agents) {
      lines.push(`### ${agent.label}`, "");
      lines.push(`- Status: ${agent.status}`);
      lines.push(`- Phase: ${agent.phase}`);
      lines.push(`- Tokens: ${agent.tokenUsage.total}`);
      if (agent.summary) lines.push("", agent.summary);
      if (agent.error) lines.push("", `Error: ${agent.error}`);
      lines.push("");
    }
  }

  if (run.sources.length > 0) {
    lines.push("## Sources", "");
    for (const source of run.sources) {
      const target = source.url ?? source.path ?? "";
      lines.push(`- ${source.title}${target ? ` — ${target}` : ""}`);
    }
    lines.push("");
  }

  if (run.logs.length > 0) {
    lines.push("## Logs", "");
    for (const log of run.logs) lines.push(`- ${log.ts}: ${log.message}`);
    lines.push("");
  }

  if (run.error) {
    lines.push("## Error", "", run.error, "");
  }

  return `${lines.join("\n").trim()}\n`;
}

export async function saveWorkflowRunToLibrary(
  workspaceDir: string,
  run: WorkflowRun,
  opts: LibraryStoreOptions = {},
): Promise<SaveWorkflowRunToLibraryResult> {
  const reportPath = join(workspaceDir, ".jupiter", "workflows", "reports", `${run.id}.md`);
  const markdown = formatWorkflowRunMarkdown(run);
  await mkdir(join(workspaceDir, ".jupiter", "workflows", "reports"), { recursive: true });
  await writeFile(reportPath, markdown, "utf8");
  const source = addLibrarySourceForWorkspace(
    workspaceDir,
    {
      kind: "file",
      title: `Workflow: ${run.title}`,
      path: reportPath,
      snippet: extractResultSummary(run.result) ?? `${run.title} ${run.status}`,
      contentText: markdown,
      ingestStatus: "done",
    },
    opts,
  );
  return { reportPath, source };
}

function extractResultSummary(result: unknown): string | null {
  if (typeof result === "string") return result.trim() || null;
  if (!result || typeof result !== "object") return null;
  const summary = (result as { summary?: unknown }).summary;
  return typeof summary === "string" && summary.trim() ? summary.trim() : null;
}
