import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Jupiter upstream notice", () => {
  it("keeps the required MIT attribution outside runtime source", () => {
    const notice = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
    const manifest = readFileSync("package.json", "utf8");

    expect(notice).toContain("MIT License");
    expect(notice).toContain("DeepSeek-Reasonix");
    expect(notice).toContain("Copyright (c) 2026 Reasonix Contributors");
    expect(notice).toContain("The above copyright notice and this permission notice");
    expect(manifest).toContain('"THIRD_PARTY_NOTICES.md"');
    expect(existsSync("src/legal/upstream-notice.ts")).toBe(false);
  });
});
