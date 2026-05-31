import {
  addSkillPath,
  loadSubagentModels,
  readConfig,
  removeSkillPath,
  saveSubagentModels,
  writeConfig,
} from "../config.js";
import { SkillStore } from "../skills.js";

export interface SkillSettingsOptions {
  configPath?: string;
  projectRoot?: string;
  homeDir?: string;
}

export function addSkillPathSetting(
  skillPath: string,
  opts: SkillSettingsOptions = {},
): ReturnType<typeof addSkillPath> {
  return addSkillPath(skillPath, opts.projectRoot, opts.configPath);
}

export function removeSkillPathSetting(
  skillPath: string,
  opts: SkillSettingsOptions = {},
): ReturnType<typeof removeSkillPath> {
  const result = removeSkillPath(skillPath, opts.projectRoot, opts.configPath);
  if (result.removed && result.paths.length === 0) {
    const cfg = readConfig(opts.configPath);
    cfg.skills = undefined;
    writeConfig(cfg, opts.configPath);
  }
  return result;
}

export function createSkillSetting(
  name: string,
  opts: SkillSettingsOptions & { scope: "project" | "global" },
):
  | { created: true; path: string }
  | {
      created: false;
      error: string;
    } {
  const store = new SkillStore({
    homeDir: opts.homeDir,
    projectRoot: opts.projectRoot,
  });
  const result = store.create(name.trim(), opts.scope);
  if ("error" in result) return { created: false, error: result.error };
  return { created: true, path: result.path };
}

export function setSkillSubagentModel(
  name: string,
  model: "flash" | "pro" | null,
  opts: SkillSettingsOptions = {},
): { changed: boolean; models: Record<string, "flash" | "pro"> } | { error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { error: "skill name is empty" };
  const models = loadSubagentModels(opts.configPath);
  const before = models[trimmed];
  if (model === null) {
    delete models[trimmed];
  } else {
    models[trimmed] = model;
  }
  const changed = before !== models[trimmed];
  if (changed) saveSubagentModels(models, opts.configPath);
  return { changed, models };
}
