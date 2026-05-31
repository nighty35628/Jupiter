import { describe, expect, it } from "vitest";
import { findOllamaBinary } from "../src/index/semantic/ollama-launcher.js";

describe("ollama-launcher", () => {
  describe("findOllamaBinary", () => {
    it("returns null when `ollama` is not on PATH (or a string when it is)", () => {
      // We can't pre-condition on the test runner having (or not having)
      // ollama installed, so we only assert the return type contract and
      // that the function is non-throwing.
      const result = findOllamaBinary();
      expect(result === null || typeof result === "string").toBe(true);
      if (typeof result === "string") {
        expect(result.length).toBeGreaterThan(0);
        expect(result).not.toMatch(/\n/);
      }
    });

    it("does not throw on systems with restrictive PATH lookup tools", () => {
      // Defensive — `which` / `where` returning non-zero must not bubble.
      // Calling twice in a row exercises any state we might accidentally
      // accumulate.
      expect(() => findOllamaBinary()).not.toThrow();
      expect(() => findOllamaBinary()).not.toThrow();
    });
  });
});
