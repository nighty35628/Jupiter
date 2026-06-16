import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INDEX_DIR_NAME, querySemantic } from "../src/index/semantic/builder.js";
import { normalize, openStore } from "../src/index/semantic/store.js";
import { formatHits } from "../src/index/semantic/tool.js";

describe("querySemantic freshness metadata", () => {
  let root: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "jupiter-semantic-query-"));
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("marks hits as stale when the source file changed after indexing", async () => {
    const rel = "src/auth/session.ts";
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, "export function validateSessionCookie() {}\n", "utf8");
    await utimes(abs, new Date(20), new Date(20));

    const store = await openStore(join(root, INDEX_DIR_NAME), {
      provider: "ollama",
      model: "nomic-embed-text",
    });
    await store.add([
      {
        path: rel,
        startLine: 1,
        endLine: 1,
        text: "export function validateSessionCookie() {}",
        embedding: normalize(new Float32Array([1, 0, 0])),
        mtimeMs: 10,
      },
    ]);

    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ embedding: [1, 0, 0] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const hits = await querySemantic(root, "session cookie", {
      provider: "ollama",
      model: "nomic-embed-text",
      minScore: 0,
    });

    expect(hits).not.toBeNull();
    expect(hits?.[0]?.freshness).toEqual({
      status: "stale",
      indexedMtimeMs: 10,
      currentMtimeMs: 20,
    });
    expect(formatHits("session cookie", hits ?? [])).toContain(
      "stale: file changed after indexing",
    );
  });
});
