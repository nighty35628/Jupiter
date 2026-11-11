import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { runCommand, tokenizeCommand } from "../src/tools/shell.js";

describe("Android synthetic command fixture", { retry: 0 }, () => {
  it.skipIf(process.platform === "win32")(
    "uses an explicit shell and verifies actual Python/Node execution",
    async () => {
      const source = ts.createSourceFile(
        "fixture.mjs",
        await readFile("scripts/update-reliability-smoke.mjs", "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      let command = "";
      const visit = (node: ts.Node) => {
        if (
          ts.isVariableDeclaration(node) &&
          node.name.getText(source) === "androidValidationCommand" &&
          node.initializer &&
          ts.isNoSubstitutionTemplateLiteral(node.initializer)
        )
          command = node.initializer.text;
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(tokenizeCommand(command).slice(0, 2)).toEqual(["/bin/bash", "-lc"]);
      expect(tokenizeCommand(command)).toHaveLength(3);
      const root = await mkdtemp(join(tmpdir(), "jupiter-mobile-command-"));
      try {
        await cp("tests/fixtures/mobile-project", root, { recursive: true });
        execFileSync("git", ["-C", root, "init", "-q"]);
        const result = await runCommand(command, { cwd: root });
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain("ANDROID_PROJECT_TEST_OK");
        expect(result.output).toMatch(/(?:^|\n)42(?:\n|$)/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
