import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const superpowersRoot = join(
  process.cwd(),
  "resources",
  "skill-packs",
  "bundled",
  "superpowers",
  "skills",
);

function skillFile(name: string, ...parts: string[]): string {
  return readFileSync(join(superpowersRoot, name, ...parts), "utf8");
}

describe("bundled Superpowers skill pack", () => {
  it("ships Jupiter-specific platform guidance", () => {
    const usingSuperpowers = skillFile("using-superpowers", "SKILL.md");
    const jupiterToolsPath = join(
      superpowersRoot,
      "using-superpowers",
      "references",
      "jupiter-tools.md",
    );

    expect(existsSync(jupiterToolsPath)).toBe(true);
    expect(usingSuperpowers).toContain("In Jupiter");
    expect(usingSuperpowers).toContain("references/jupiter-tools.md");
    expect(usingSuperpowers).toContain("Jupiter skill invocation");
    expect(usingSuperpowers).not.toContain("In Claude Code:");

    const jupiterTools = readFileSync(jupiterToolsPath, "utf8");
    expect(jupiterTools).toContain("spawn_subagent");
    expect(jupiterTools).toContain("todo_write");
    expect(jupiterTools).toContain("run_skill");
    expect(jupiterTools).toContain("read_file");
    expect(jupiterTools).toContain("run_command");
  });

  it("uses Jupiter skill locations and tool names in core workflows", () => {
    const writingSkills = skillFile("writing-skills", "SKILL.md");
    expect(writingSkills).toContain("~/.jupiter/skills");
    expect(writingSkills).toContain(".jupiter/skills");

    const dispatching = skillFile("dispatching-parallel-agents", "SKILL.md");
    expect(dispatching).toContain("spawn_subagent");
    expect(dispatching).not.toContain('Task("');

    const subagentDriven = skillFile("subagent-driven-development", "SKILL.md");
    expect(subagentDriven).toContain("todo_write");
    expect(subagentDriven).not.toContain("Create TodoWrite");

    const executingPlans = skillFile("executing-plans", "SKILL.md");
    expect(executingPlans).toContain("todo_write");
    expect(executingPlans).not.toContain("Create TodoWrite");
  });
});
