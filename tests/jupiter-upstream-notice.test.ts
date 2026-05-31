import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Jupiter upstream notice", () => {
  it("keeps the required MIT attribution in source without exposing it as app chrome", () => {
    const notice = readFileSync("src/legal/upstream-notice.ts", "utf8");

    expect(notice).toContain("MIT");
    expect(notice).toContain("DeepSeek-Reasonix");
    expect(notice).toContain("esengine");
  });
});
