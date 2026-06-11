import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkflowRun } from "./types.js";

export interface WorkflowStore {
  readonly rootDir: string;
  readonly filePath: string;
  createRun(run: WorkflowRun): Promise<WorkflowRun>;
  updateRun(id: string, patch: Partial<WorkflowRun>): Promise<WorkflowRun>;
  getRun(id: string): Promise<WorkflowRun | null>;
  listRuns(): Promise<WorkflowRun[]>;
}

interface WorkflowStoreFile {
  readonly runs: WorkflowRun[];
}

export function createWorkflowStore(rootDir: string): WorkflowStore {
  const filePath = join(rootDir, ".jupiter", "workflows", "runs.json");
  return {
    rootDir,
    filePath,
    async createRun(run) {
      const data = await readStoreFile(filePath);
      const nextRuns = [run, ...data.runs.filter((existing) => existing.id !== run.id)];
      await writeStoreFile(filePath, { runs: nextRuns });
      return run;
    },
    async updateRun(id, patch) {
      const data = await readStoreFile(filePath);
      const index = data.runs.findIndex((run) => run.id === id);
      if (index < 0) throw new Error(`Workflow run not found: ${id}`);
      const nextRun = { ...data.runs[index], ...patch } as WorkflowRun;
      const nextRuns = data.runs.slice();
      nextRuns[index] = nextRun;
      await writeStoreFile(filePath, { runs: nextRuns });
      return nextRun;
    },
    async getRun(id) {
      const data = await readStoreFile(filePath);
      return data.runs.find((run) => run.id === id) ?? null;
    },
    async listRuns() {
      const data = await readStoreFile(filePath);
      return [...data.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },
  };
}

async function readStoreFile(filePath: string): Promise<WorkflowStoreFile> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkflowStoreFile>;
    return { runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { runs: [] };
    throw error;
  }
}

async function writeStoreFile(filePath: string, data: WorkflowStoreFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
