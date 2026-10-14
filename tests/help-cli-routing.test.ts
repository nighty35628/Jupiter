import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}
describe("CLI help entrypoint contracts", () => {
  it("registers host help for ordinary chat and run, including absent/failed MCP", () => {
    for (const path of ["src/cli/commands/chat.tsx", "src/cli/commands/run.ts"]) {
      expect(source(path).includes("registerHelpTool(tools"), path).toBe(true);
    }
    expect(source("src/cli/commands/run.ts")).not.toContain(
      "if (successCount === 0) tools = undefined",
    );
  });
  it("passes request-only help for Agent, and direct help plus tiny topic for tool-free CLI Ask/btw", () => {
    const app = source("src/cli/ui/App.tsx");
    for (const contract of [
      "requestContext: preparedHelp.content",
      "helpContext:",
      "onHelpTopic:",
      "recentTopic: helpTopicRef.current",
      "content: preparedSideHelp.content",
      "tools: []",
    ])
      expect(app.includes(contract), contract).toBe(true);
    expect(source("src/cli/commands/run.ts")).toContain("requestContext: preparedHelp.content");
    expect(source("src/code/setup.ts")).toContain("registerHelpTool(tools");
  });
});
