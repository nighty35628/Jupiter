import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkDirectory, chunkText, walkChunks } from "../src/index/semantic/chunker.js";

describe("chunker", () => {
  describe("chunkText (pure)", () => {
    it("splits a file into overlapping line windows", () => {
      const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
      const chunks = chunkText(text, "src/foo.ts", 30, 5);
      expect(chunks.length).toBeGreaterThan(1);
      // First chunk covers 1..30
      expect(chunks[0]?.startLine).toBe(1);
      expect(chunks[0]?.endLine).toBe(30);
      // Stride = 30 - 5 = 25
      expect(chunks[1]?.startLine).toBe(26);
      expect(chunks[1]?.endLine).toBe(55);
      // Last chunk's endLine never exceeds total
      const last = chunks[chunks.length - 1];
      expect(last?.endLine).toBeLessThanOrEqual(100);
    });

    it("produces a single chunk for a small file", () => {
      const chunks = chunkText("a\nb\nc\n", "x.ts", 60, 12);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.startLine).toBe(1);
    });

    it("returns no chunks for empty input", () => {
      expect(chunkText("", "empty.ts", 60, 12)).toEqual([]);
    });

    it("preserves text content in the chunk body", () => {
      const text = "alpha\nbeta\ngamma\n";
      const [chunk] = chunkText(text, "f.ts", 60, 0);
      expect(chunk?.text).toContain("alpha");
      expect(chunk?.text).toContain("gamma");
    });

    it("guards against overlap >= window (would loop forever)", () => {
      const text = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
      // overlap clamped to windowLines - 1 inside walkChunks; chunkText
      // itself trusts the caller, so we exercise sane stride here.
      const chunks = chunkText(text, "f.ts", 10, 3);
      expect(chunks.length).toBeGreaterThan(1);
      // Check that startLines monotonically increase.
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i]!.startLine).toBeGreaterThan(chunks[i - 1]!.startLine);
      }
    });

    it("splits a multi-line chunk that exceeds maxChunkChars at line boundaries", () => {
      // 30 lines of 200 chars each = 6000 chars, with maxChunkChars=2500
      // we should get multiple sub-chunks, none over the cap.
      const longLine = "x".repeat(200);
      const text = Array.from({ length: 30 }, () => longLine).join("\n");
      const chunks = chunkText(text, "long.ts", 30, 0, 2500);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.text.length).toBeLessThanOrEqual(2500);
      }
      // Line ranges cover the whole file, no gaps
      const minStart = Math.min(...chunks.map((c) => c.startLine));
      const maxEnd = Math.max(...chunks.map((c) => c.endLine));
      expect(minStart).toBe(1);
      expect(maxEnd).toBe(30);
    });

    it("hard-truncates a single line that exceeds maxChunkChars", () => {
      // One line of 5000 chars, cap at 1000. Should produce one chunk
      // containing the truncated line.
      const huge = "y".repeat(5000);
      const chunks = chunkText(huge, "minified.js", 60, 12, 1000);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.text.length).toBeLessThanOrEqual(1000);
      expect(chunks[0]?.startLine).toBe(1);
      expect(chunks[0]?.endLine).toBe(1);
    });

    it("passes through chunks smaller than the cap unchanged", () => {
      const chunks = chunkText("hi\nthere\n", "x.ts", 60, 12, 4000);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.text).toBe("hi\nthere");
    });
  });

  describe("walkChunks (filesystem)", () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "jupiter-chunk-"));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("skips node_modules and lockfiles", async () => {
      await fs.mkdir(join(root, "node_modules", "foo"), { recursive: true });
      await fs.writeFile(join(root, "node_modules", "foo", "x.ts"), "noisy\n");
      await fs.writeFile(join(root, "package-lock.json"), '{"x": 1}\n');
      await fs.writeFile(join(root, "main.ts"), "export const a = 1;\n");
      const chunks = await chunkDirectory(root);
      const paths = chunks.map((c) => c.path);
      expect(paths).toContain("main.ts");
      expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
      expect(paths).not.toContain("package-lock.json");
    });

    it("skips binary extensions", async () => {
      await fs.writeFile(join(root, "a.ts"), "ok\n");
      await fs.writeFile(join(root, "b.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const chunks = await chunkDirectory(root);
      expect(chunks.some((c) => c.path === "a.ts")).toBe(true);
      expect(chunks.some((c) => c.path === "b.png")).toBe(false);
    });

    it("normalizes paths to forward slashes", async () => {
      await fs.mkdir(join(root, "src", "deep"), { recursive: true });
      await fs.writeFile(join(root, "src", "deep", "f.ts"), "x\n");
      const chunks = await chunkDirectory(root);
      const target = chunks.find((c) => c.path.endsWith("f.ts"));
      expect(target?.path).toBe("src/deep/f.ts");
    });

    it("skips files with embedded NUL bytes", async () => {
      // .ts extension passes the binary-ext filter, NUL sniff should
      // catch the binary content.
      await fs.writeFile(join(root, "fake.ts"), "header\0body\n");
      await fs.writeFile(join(root, "real.ts"), "real text\n");
      const chunks = await chunkDirectory(root);
      const paths = chunks.map((c) => c.path);
      expect(paths).toContain("real.ts");
      expect(paths).not.toContain("fake.ts");
    });

    it("works as an async iterable for streaming", async () => {
      await fs.writeFile(join(root, "a.ts"), "x\n");
      await fs.writeFile(join(root, "b.ts"), "y\n");
      const seen: string[] = [];
      for await (const c of walkChunks(root)) seen.push(c.path);
      expect(seen.sort()).toEqual(["a.ts", "b.ts"]);
    });
  });
});
