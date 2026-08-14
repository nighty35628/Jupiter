import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop startup restore contract", () => {
  it("only advertises restoringSession after messages were actually restored", () => {
    const source = readFileSync(new URL("../src/cli/commands/desktop.ts", import.meta.url), "utf8");

    expect(source).toContain("restoringSession: restoredMessages ? restore?.session : undefined");
    expect(source).not.toContain("restoringSession: restore?.session,");
  });

  it("routes both auto-title paths through the current runtime binding", () => {
    const source = readFileSync(new URL("../src/cli/commands/desktop.ts", import.meta.url), "utf8");

    expect(source.match(/scheduleGeneratedSessionTitle\(\{/g)).toHaveLength(2);
    expect(source).toContain("opts.tab.runtime?.loop.rebindSession(nextName)");
    expect(source).not.toContain("rt.loop.sessionName = nextName");
  });
});
