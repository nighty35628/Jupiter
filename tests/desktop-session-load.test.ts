import { describe, expect, it } from "vitest";
import * as desktopCommand from "../src/cli/commands/desktop.js";
import type { ChatMessage } from "../src/types.js";

type BuildLoadedMessages = (records: ChatMessage[]) => Array<{
  kind: "assistant" | "user";
  displayTruncated?: boolean | { originalChars: number; visibleChars: number };
  segments?: Array<{
    kind: string;
    text?: string;
    args?: string;
    result?: string;
    segmentCount?: number;
    charCount?: number;
  }>;
}>;

describe("desktop session loading", () => {
  it("elides old heavy assistant segments before sending $session_loaded", () => {
    const buildLoadedMessages = (desktopCommand as { buildLoadedMessages?: BuildLoadedMessages })
      .buildLoadedMessages;
    expect(typeof buildLoadedMessages).toBe("function");

    const huge = "desktop retained field\n".repeat(900);
    const records: ChatMessage[] = [];
    for (let i = 0; i < 260; i++) {
      records.push({
        role: "assistant",
        content: huge,
        reasoning_content: huge,
        tool_calls: [
          {
            id: `c-${i}`,
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: `file-${i}.txt`, content: huge }),
            },
          },
        ],
      });
      records.push({ role: "tool", tool_call_id: `c-${i}`, content: huge });
    }

    const loaded = buildLoadedMessages!(records);
    const assistants = loaded.filter((message) => message.kind === "assistant");
    const folded = assistants.find((message) => message.displayTruncated === true);
    const newest = assistants.at(-1);

    expect(Buffer.byteLength(JSON.stringify(loaded), "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(folded?.segments).toContainEqual(
      expect.objectContaining({ kind: "elision", segmentCount: expect.any(Number) }),
    );
    expect(
      newest?.segments?.some((segment) => segment.kind === "text" && segment.text === huge),
    ).toBe(true);
  });
});
