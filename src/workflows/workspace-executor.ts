import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowAgentInput, WorkflowAgentResult } from "./runner.js";
import type { WorkflowSource } from "./types.js";
import type { WorkspaceWorkflowPlan } from "./workspace.js";
import { buildWorkspaceAgentPrompt } from "./workspace.js";

export interface WorkspaceWorkflowExecutorOptions {
  readonly plan: WorkspaceWorkflowPlan;
  readonly userPrompt: string;
  readonly workspaceDir: string;
}

export function createWorkspaceWorkflowAgentExecutor(
  opts: WorkspaceWorkflowExecutorOptions,
): (input: WorkflowAgentInput) => Promise<WorkflowAgentResult> {
  return async (input) => {
    const check = opts.plan.checks.find((entry) => entry.id === input.phase) ?? opts.plan.checks[0];
    if (!check) {
      throw new Error(`No workspace check configured for workflow: ${opts.plan.id}`);
    }
    const prompt = buildWorkspaceAgentPrompt(check, {
      userPrompt: opts.userPrompt,
      workflowTitle: opts.plan.title,
      workspaceDir: opts.workspaceDir,
    });
    const snapshot = collectWorkspaceSnapshot(opts.workspaceDir);
    const sources = sourceList(opts.workspaceDir, snapshot);
    const summary = formatWorkspaceSummary(opts.plan.id, check.title, opts.userPrompt, snapshot);
    return {
      summary,
      tokenUsage: estimateTokenUsage(prompt, summary),
      sources,
      result: {
        summary,
        findings: snapshot.findings,
        risks: snapshot.risks,
        nextSteps: snapshot.nextSteps,
      },
    };
  };
}

interface WorkspaceSnapshot {
  readonly files: readonly string[];
  readonly existingFiles: readonly string[];
  readonly packageSummary: readonly string[];
  readonly gitSummary: readonly string[];
  readonly findings: readonly string[];
  readonly risks: readonly string[];
  readonly nextSteps: readonly string[];
}

const IMPORTANT_FILES = [
  "package.json",
  "desktop/package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "CLA.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  ".github/workflows/release.yml",
  "desktop/src-tauri/tauri.conf.json",
  "vitest.config.ts",
  "tsconfig.json",
] as const;

function collectWorkspaceSnapshot(root: string): WorkspaceSnapshot {
  const existingFiles = IMPORTANT_FILES.filter((file) => existsSync(join(root, file)));
  const files = listTopLevelFiles(root);
  const packageSummary = packageSummaries(root);
  const gitSummary = gitSummaries(root);
  const findings = [
    ...existingFiles.map((file) => `Found ${file}`),
    ...packageSummary,
    ...gitSummary,
  ];
  const risks = riskHints(existingFiles, packageSummary, gitSummary);
  const nextSteps = nextStepHints(existingFiles, gitSummary);
  return { files, existingFiles, packageSummary, gitSummary, findings, risks, nextSteps };
}

function listTopLevelFiles(root: string): string[] {
  try {
    return readdirSync(root)
      .slice(0, 80)
      .map((name) => {
        try {
          const stat = statSync(join(root, name));
          return stat.isDirectory() ? `${name}/` : name;
        } catch {
          return name;
        }
      });
  } catch {
    return [];
  }
}

function packageSummaries(root: string): string[] {
  const out: string[] = [];
  for (const file of ["package.json", "desktop/package.json"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8")) as {
        name?: string;
        version?: string;
        license?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const scripts = Object.keys(pkg.scripts ?? {});
      const deps =
        Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
      out.push(
        `${file}: ${pkg.name ?? "(unnamed)"} ${pkg.version ?? ""} license=${pkg.license ?? "unknown"} scripts=${scripts.join(",") || "none"} deps=${deps}`,
      );
    } catch (error) {
      out.push(`${file}: unreadable package JSON (${(error as Error).message})`);
    }
  }
  return out;
}

function gitSummaries(root: string): string[] {
  const status = runGit(root, ["status", "--short"]);
  const diffStat = runGit(root, ["diff", "--stat"]);
  const diffNames = runGit(root, ["diff", "--name-only"]);
  const lines: string[] = [];
  if (status) lines.push(`git status: ${firstLines(status, 12).join("; ")}`);
  if (diffStat) lines.push(`git diff stat: ${firstLines(diffStat, 8).join("; ")}`);
  if (diffNames) lines.push(`git changed files: ${firstLines(diffNames, 12).join(", ")}`);
  if (lines.length === 0) lines.push("git status: clean or unavailable");
  return lines;
}

function runGit(root: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 512 * 1024,
  });
  if (result.error || result.status !== 0) return "";
  return result.stdout.trim();
}

function firstLines(text: string, max: number): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, max);
}

function riskHints(
  existingFiles: readonly string[],
  packageSummary: readonly string[],
  gitSummary: readonly string[],
): string[] {
  const risks: string[] = [];
  if (!existingFiles.includes("README.md")) risks.push("README.md is missing.");
  if (!existingFiles.includes("LICENSE")) risks.push("LICENSE is missing.");
  if (!existingFiles.includes(".github/workflows/release.yml")) {
    risks.push("Release workflow is missing or not in the expected path.");
  }
  if (packageSummary.some((line) => line.includes("license=unknown"))) {
    risks.push("At least one package manifest has no license field.");
  }
  if (gitSummary.some((line) => line.includes("git status:") && line.includes("?? output/"))) {
    risks.push("Untracked output/ directory exists and should not be mixed into release work.");
  }
  return risks.length > 0 ? risks : ["No immediate workspace hygiene risks detected locally."];
}

function nextStepHints(existingFiles: readonly string[], gitSummary: readonly string[]): string[] {
  const steps = ["Run the focused workflow tests before acting on findings."];
  if (gitSummary.some((line) => !line.includes("clean or unavailable"))) {
    steps.push("Review current git diff before release or PR actions.");
  }
  if (existingFiles.includes(".github/workflows/release.yml")) {
    steps.push("Verify release workflow target matrix before packaging.");
  }
  return steps;
}

function sourceList(root: string, snapshot: WorkspaceSnapshot): WorkflowSource[] {
  return snapshot.existingFiles.map((file) => ({ title: file, path: join(root, file) }));
}

function formatWorkspaceSummary(
  workflowId: string,
  checkTitle: string,
  userPrompt: string,
  snapshot: WorkspaceSnapshot,
): string {
  return [
    `${checkTitle}: ${workflowId}`,
    `request: ${userPrompt || "(none)"}`,
    "",
    "workspace evidence:",
    ...snapshot.findings.map((line) => `- ${line}`),
    "",
    "risks:",
    ...snapshot.risks.map((line) => `- ${line}`),
    "",
    "next steps:",
    ...snapshot.nextSteps.map((line) => `- ${line}`),
  ].join("\n");
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
