import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleSlash } from "../src/cli/ui/slash/dispatch.js";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../src/index.js";
import { ToolRegistry } from "../src/tools.js";

function makeLoop(): CacheFirstLoop {
  const tools = new ToolRegistry();
  return new CacheFirstLoop({
    client: new DeepSeekClient({ apiKey: "sk-test" }),
    prefix: new ImmutablePrefix({ system: "s", toolSpecs: [] }),
    tools,
    maxToolIters: 1,
    stream: false,
  });
}

describe("/init slash handler", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "jupiter-init-slash-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses outside code mode (no codeRoot)", () => {
    const loop = makeLoop();
    const result = handleSlash("init", [], loop, {});
    expect(result.info).toMatch(/only works in code mode/i);
    expect(result.resubmit).toBeUndefined();
  });

  it("emits the structured init prompt as resubmit when JUPITER.md does not exist", () => {
    const loop = makeLoop();
    const result = handleSlash("init", [], loop, { codeRoot: tmp });
    expect(result.resubmit).toBeDefined();
    expect(result.resubmit).toMatch(/Initialize JUPITER.md/);
    // The hard length cap is the most important constraint — pin it.
    expect(result.resubmit).toMatch(/≤\s*80\s*lines/);
    // The final report is load-bearing for desktop: without it /init can
    // complete silently after writing the pending edit.
    expect(result.resubmit).toMatch(/After writing, report/i);
    expect(result.resubmit).toMatch(/pending edit/i);
    expect(result.resubmit).not.toMatch(/do not summarize/i);
    expect(result.info).toMatch(/scan the project/);
  });

  it("refuses overwriting an existing JUPITER.md without `force`", () => {
    writeFileSync(join(tmp, "JUPITER.md"), "# pre-existing");
    const loop = makeLoop();
    const result = handleSlash("init", [], loop, { codeRoot: tmp });
    expect(result.resubmit).toBeUndefined();
    expect(result.info).toMatch(/already exists/);
    expect(result.info).toMatch(/\/init force/);
  });

  it("`/init force` proceeds even when JUPITER.md exists", () => {
    writeFileSync(join(tmp, "JUPITER.md"), "# pre-existing");
    const loop = makeLoop();
    const result = handleSlash("init", ["force"], loop, { codeRoot: tmp });
    expect(result.resubmit).toBeDefined();
    expect(result.resubmit).toMatch(/Initialize JUPITER.md/);
    expect(result.info).toMatch(/scan the project/);
  });

  it("`force` matching is case-insensitive", () => {
    writeFileSync(join(tmp, "JUPITER.md"), "# pre-existing");
    const loop = makeLoop();
    const result = handleSlash("init", ["FORCE"], loop, { codeRoot: tmp });
    expect(result.resubmit).toBeDefined();
  });
});
