import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditMode } from "../src/config.js";
type ShellOpts = {
  allowAll: () => boolean;
  beforeExecute?: (command: string, signal?: AbortSignal) => Promise<void>;
};
const shellOptions = vi.hoisted(() => ({ current: null as null | ShellOpts }));
vi.mock("../src/config.js", async (original) => ({
  ...(await original<typeof import("../src/config.js")>()),
  readConfig: () => ({}),
  loadEditMode: () => "yolo",
  loadToolRateLimit: () => undefined,
  loadFilesystemOutlineThresholdBytes: () => 10000,
  loadProjectPathAllowed: () => [],
  loadProjectShellAllowed: () => [],
  loadMemoryConfirmWrites: () => true,
  loadMemoryGlobalEnabled: () => false,
  loadLibraryRetrievalMode: () => "off",
  searchEnabled: () => false,
  loadJavaSourceEnabled: () => false,
  loadResolvedSkillPaths: () => [],
  loadSkillPackSources: () => [],
  loadSubagentModels: () => [],
}));
vi.mock("../src/index/semantic/tool.js", () => ({
  bootstrapSemanticSearchInCodeMode: async () => ({ enabled: false }),
}));
vi.mock("../src/tools/shell.js", () => ({
  registerShellTools: (_registry: unknown, opts: ShellOpts) => {
    shellOptions.current = opts;
  },
}));
vi.mock("../src/tools/skills.js", () => ({ registerSkillTools: () => {} }));
import { buildCodeToolset } from "../src/code/setup.js";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("help setup and effective surface permissions", () => {
  it("uses effective edit mode for initial plan gate and live shell allowAll, not global YOLO", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "jupiter-help-setup-"));
    dirs.push(rootDir);
    let mode: EditMode = "plan";
    const beforeCommandExecute = vi.fn(async () => {});
    const toolset = await buildCodeToolset({
      rootDir,
      effectiveEditMode: () => mode,
      beforeCommandExecute,
      helpContext: () => ({ surface: "web", model: "mock-model" }),
    });
    expect(toolset.tools.planMode).toBe(true);
    expect(shellOptions.current?.allowAll()).toBe(false);
    expect(shellOptions.current?.beforeExecute).toBe(beforeCommandExecute);
    expect(beforeCommandExecute).not.toHaveBeenCalled();
    expect(await toolset.tools.dispatch("jupiter_help", '{"topic":"computer-use"}')).toContain(
      "unavailable on web",
    );
    mode = "review";
    expect(shellOptions.current?.allowAll()).toBe(false);
    mode = "yolo";
    expect(shellOptions.current?.allowAll()).toBe(true);
    await toolset.jobs.shutdown();
  });
});
