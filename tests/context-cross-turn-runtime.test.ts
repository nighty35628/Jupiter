import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { HISTORY_FOLD_MARKER } from "../src/context-manager.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { loadSessionMeta, rewriteSession, sessionPath } from "../src/memory/session.js";
import { SharedSessionCoordinator } from "../src/memory/shared-session.js";
import type { ChatMessage } from "../src/types.js";

describe("compaction across actual runtime reconstruction", { retry: 0 }, () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const close of cleanup.splice(0).reverse()) close();
    vi.unstubAllEnvs();
  });
  it.each([true, false])(
    "persists terminal summary usage even when candidate accepted=%s",
    async (accepted) => {
      const home = mkdtempSync(join(tmpdir(), "jupiter-context-roundtrip-"));
      cleanup.push(() => rmSync(home, { recursive: true, force: true }));
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      rewriteSession("qa", [
        { role: "user", content: "Original objective" },
        { role: "assistant", content: "Durable evidence from an old exchange. ".repeat(5000) },
      ]);
      const rawBefore = readFileSync(sessionPath("qa"), "utf8");
      let owner = new SharedSessionCoordinator("qa", "qa-id");
      cleanup.push(() => owner.dispose());
      let summaries = 0;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[] };
        const isSummary = body.messages
          .at(-1)
          ?.content?.startsWith("Summarize the conversation above");
        if (isSummary) summaries++;
        return Response.json({
          choices: [
            {
              message: {
                content: isSummary
                  ? accepted
                    ? "Durable summary"
                    : "<tool_call>not a summary</tool_call>"
                  : "Main answer",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: isSummary ? 300 : 160000, completion_tokens: isSummary ? 7 : 5 },
        });
      });
      const make = (turn: string) =>
        new CacheFirstLoop({
          client: new DeepSeekClient({
            apiKey: "synthetic",
            baseUrl: "https://synthetic.invalid/v1",
            fetch,
            retry: { maxAttempts: 1 },
          }),
          model: "synthetic-model",
          prefix: new ImmutablePrefix({ system: "Rules" }),
          session: "qa",
          sessionStorage: owner.beginTurn("view", turn),
          stream: false,
        });
      const first = make("first");
      cleanup.push(() => first.dispose());
      await first.run("New question");
      owner.commit(owner.beginTurn("view", "first"));
      expect(summaries).toBe(1);
      expect(loadSessionMeta("qa").totalCompletionTokens).toBe(12);
      expect(loadSessionMeta("qa").lastPromptTokens).toBe(160000);
      expect(readFileSync(sessionPath("qa"), "utf8").startsWith(rawBefore)).toBe(true);
      first.dispose();
      owner.dispose();
      owner = new SharedSessionCoordinator("qa", "qa-id");
      const second = make("second");
      cleanup.push(() => second.dispose());
      expect(second.currentTurn).toBe(2);
      expect(second.stats.cumulativeCompletionTokens).toBe(12);
      expect(second.stats.summary().lastPromptTokens).toBe(160000);
      expect(
        second.log.toFullHistory().some((row) => row.content?.startsWith(HISTORY_FOLD_MARKER)),
      ).toBe(accepted);
      expect(summaries).toBe(1);
    },
  );
});
