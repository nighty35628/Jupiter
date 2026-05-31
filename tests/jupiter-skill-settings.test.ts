import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig, writeConfig } from "../src/config.js";
import {
  addSkillPathSetting,
  createSkillSetting,
  removeSkillPathSetting,
  setSkillSubagentModel,
} from "../src/config/skill-settings.js";

describe("Jupiter skill settings helpers", () => {
  let dir: string;
  let homeDir: string;
  let projectRoot: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jupiter-skill-settings-"));
    homeDir = join(dir, "home");
    projectRoot = join(dir, "project");
    configPath = join(dir, "config.json");
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("adds and removes custom skill roots without duplicating resolved paths", () => {
    expect(addSkillPathSetting("./skills", { projectRoot, configPath })).toMatchObject({
      added: true,
      path: "./skills",
      resolved: join(projectRoot, "skills"),
    });
    expect(readConfig(configPath).skills?.paths).toEqual(["./skills"]);

    expect(
      addSkillPathSetting(join(projectRoot, "skills"), { projectRoot, configPath }),
    ).toMatchObject({
      added: false,
    });

    expect(
      removeSkillPathSetting(join(projectRoot, "skills"), { projectRoot, configPath }),
    ).toMatchObject({
      removed: true,
      resolved: join(projectRoot, "skills"),
    });
    expect(readConfig(configPath).skills).toBeUndefined();
  });

  it("creates project and global skill stubs through the settings service", () => {
    const project = createSkillSetting("jupiter-review", {
      scope: "project",
      projectRoot,
      homeDir,
    });
    expect(project).toMatchObject({
      created: true,
      path: join(projectRoot, ".jupiter", "skills", "jupiter-review.md"),
    });
    expect(readFileSync(project.path, "utf8")).toContain("name: jupiter-review");

    const global = createSkillSetting("personal-helper", {
      scope: "global",
      projectRoot,
      homeDir,
    });
    expect(global).toMatchObject({
      created: true,
      path: join(homeDir, ".jupiter", "skills", "personal-helper.md"),
    });
  });

  it("sets and clears per-skill subagent model overrides", () => {
    writeConfig({ subagentModels: { existing: "flash" } }, configPath);

    expect(setSkillSubagentModel("jupiter-review", "pro", { configPath })).toMatchObject({
      changed: true,
    });
    expect(readConfig(configPath).subagentModels).toEqual({
      existing: "flash",
      "jupiter-review": "pro",
    });

    expect(setSkillSubagentModel("existing", null, { configPath })).toMatchObject({
      changed: true,
    });
    expect(readConfig(configPath).subagentModels).toEqual({ "jupiter-review": "pro" });
  });
});
