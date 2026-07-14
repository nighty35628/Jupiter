import { describe, expect, it } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";

describe("provider error redaction across the loop boundary", () => {
  it("keeps credentials out of LoopEvent and its structured error detail", async () => {
    const apiKey = "sk-loop-abcdefghijklmnop";
    const client = new DeepSeekClient({
      apiKey,
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: `Authorization: Bearer ${apiKey}; cookie=session=private`,
            },
          }),
          { status: 401 },
        ),
      retry: { maxAttempts: 1 },
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "be concise" }),
      stream: false,
    });

    const events = [];
    for await (const event of loop.step("hello")) events.push(event);

    const error = events.find((event) => event.role === "error");
    expect(error).toBeDefined();
    expect(error?.error).toContain("Authentication failed");
    expect(error?.errorDetail?.message).toContain("[redacted]");
    expect(JSON.stringify(events)).not.toContain(apiKey);
    expect(JSON.stringify(events)).not.toContain("session=private");
  });
});
