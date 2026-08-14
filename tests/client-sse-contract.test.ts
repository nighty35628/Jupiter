import { describe, expect, it } from "vitest";
import { DeepSeekClient, type StreamChunk } from "../src/client.js";
import { streamModelResponse } from "../src/loop/streaming.js";

const terminalFrame = (finishReason = "stop") =>
  `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: finishReason }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  })}\n\n`;

function makeClient(body: string, baseUrl = "https://api.deepseek.com"): DeepSeekClient {
  return new DeepSeekClient({
    apiKey: "sk-test",
    baseUrl,
    retry: { maxAttempts: 1 },
    fetch: async () =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
  });
}

async function collect(client: DeepSeekClient): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of client.stream({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "test" }],
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("DeepSeek SSE contract", () => {
  it("ignores comments and empty data events without treating them as completion", async () => {
    const body = [
      ": keep-alive\n\n",
      "data:\n\n",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      terminalFrame(),
      "data: [DONE]\n\n",
    ].join("");

    const chunks = await collect(makeClient(body));
    expect(chunks.map((chunk) => chunk.contentDelta).filter(Boolean)).toEqual(["ok"]);
    expect(chunks.at(-1)?.finishReason).toBe("stop");
    expect(chunks.at(-1)?.usage?.totalTokens).toBe(5);
  });

  it("rejects malformed JSON frames", async () => {
    await expect(collect(makeClient("data: {not-json}\n\ndata: [DONE]\n\n"))).rejects.toThrow(
      /malformed JSON/,
    );
  });

  it("requires [DONE] from the official DeepSeek endpoint", async () => {
    await expect(collect(makeClient(""))).rejects.toThrow(/required \[DONE\]/);
    await expect(collect(makeClient(terminalFrame()))).rejects.toThrow(/required \[DONE\]/);
  });

  it("allows a compatible gateway to finish at EOF after a terminal finish_reason", async () => {
    const chunks = await collect(makeClient(terminalFrame(), "https://gateway.example/v1"));
    expect(chunks.at(-1)?.finishReason).toBe("stop");
  });

  it("rejects compatible-gateway EOF without a terminal finish_reason", async () => {
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`;
    await expect(collect(makeClient(body, "https://gateway.example/v1"))).rejects.toThrow(
      /terminal finish_reason/,
    );
  });

  it("ignores events after [DONE] in the same network block", async () => {
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "before" } }] })}\n\n`,
      "data: [DONE]\n\n",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "after" } }] })}\n\n`,
    ].join("");
    const chunks = await collect(makeClient(body));
    expect(chunks.map((chunk) => chunk.contentDelta).filter(Boolean)).toEqual(["before"]);
  });

  it("preserves every tool call delta and assembles calls in index order", async () => {
    const body = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              reasoning_content: "think",
              content: "work",
              tool_calls: [
                { index: 1, id: "call-b", function: { name: "second", arguments: '{"b":2}' } },
                { index: 0, id: "call-a", function: { name: "first", arguments: '{"a":1}' } },
              ],
            },
          },
        ],
      })}\n\n`,
      terminalFrame("tool_calls"),
      "data: [DONE]\n\n",
    ].join("");

    const generator = streamModelResponse({
      client: makeClient(body),
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "test" }],
      toolSpecs: [],
      signal: new AbortController().signal,
      thinkingEnabled: true,
      reasoningEffort: "high",
      turn: 1,
    });
    let result: Awaited<ReturnType<typeof generator.next>>;
    do {
      result = await generator.next();
    } while (!result.done);

    expect(result.value.assistantContent).toBe("work");
    expect(result.value.reasoningContent).toBe("think");
    expect(result.value.toolCalls.map((call) => call.id)).toEqual(["call-a", "call-b"]);
    expect(result.value.toolCalls.map((call) => call.function.arguments)).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
    expect(result.value.finishReason).toBe("tool_calls");
    expect(result.value.usage?.totalTokens).toBe(5);
  });
});
