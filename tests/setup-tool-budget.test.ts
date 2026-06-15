import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodeToolset } from "../src/code/setup.js";
import { countTokensBounded } from "../src/tokenizer.js";

describe("code toolset schema budget", () => {
  const previousSearch = process.env.JUPITER_SEARCH;
  const previousJava = process.env.JUPITER_JAVA_SOURCE;

  afterEach(() => {
    if (previousSearch === undefined) process.env.JUPITER_SEARCH = undefined;
    else process.env.JUPITER_SEARCH = previousSearch;
    if (previousJava === undefined) process.env.JUPITER_JAVA_SOURCE = undefined;
    else process.env.JUPITER_JAVA_SOURCE = previousJava;
  });

  it("keeps core agent tools while omitting library tools when retrieval is off", async () => {
    process.env.JUPITER_SEARCH = "off";
    process.env.JUPITER_JAVA_SOURCE = "off";
    const rootDir = mkdtempSync(join(tmpdir(), "jupiter-tools-"));
    const configPath = join(rootDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ libraryRetrievalMode: "off" }));

    const toolset = await buildCodeToolset({ rootDir, configPath });
    const specs = toolset.tools.specs();
    const names = new Set(specs.map((spec) => spec.function.name));
    const schemaTokens = specs
      .map((spec) => ({
        name: spec.function.name,
        tokens: countTokensBounded(JSON.stringify(spec)),
      }))
      .sort((a, b) => b.tokens - a.tokens);

    expect(schemaTokens.length).toBe(specs.length);
    for (const core of [
      "read_file",
      "write_file",
      "run_command",
      "submit_plan",
      "todo_write",
      "open_url",
      "remember",
      "get_symbols",
      "find_in_code",
    ]) {
      expect(names.has(core), `${core} should stay registered`).toBe(true);
    }
    expect(names.has("library_search")).toBe(false);
    expect(names.has("library_read")).toBe(false);
    expect(schemaTokens.slice(0, 10).every((entry) => entry.tokens > 0)).toBe(true);
  });
});
