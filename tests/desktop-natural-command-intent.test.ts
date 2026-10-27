import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { classifyDesktopNaturalCommandIntent } from "../src/desktop/natural-command-intent.js";

function clientReturning(content: string): DeepSeekClient {
  const fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content } }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  return new DeepSeekClient({
    apiKey: "sk-test",
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
}

describe("classifyDesktopNaturalCommandIntent", { retry: 0 }, () => {
  it("propagates cancellation instead of routing an aborted classification to chat", async () => {
    const controller = new AbortController();
    const chat = vi.fn(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(
      classifyDesktopNaturalCommandIntent({ chat } as unknown as DeepSeekClient, {
        model: "synthetic-model",
        text: "cancel during classification",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not issue a request for an already cancelled classification", async () => {
    const controller = new AbortController();
    controller.abort();
    const chat = vi.fn();
    await expect(
      classifyDesktopNaturalCommandIntent({ chat } as unknown as DeepSeekClient, {
        model: "synthetic-model",
        text: "cancel before classification",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(chat).not.toHaveBeenCalled();
  });

  it("uses the model response to trigger compact history", async () => {
    await expect(
      classifyDesktopNaturalCommandIntent(clientReturning('{"command":"compact_history"}'), {
        model: "deepseek-v4-flash",
        text: "帮我压缩上下文",
      }),
    ).resolves.toEqual({ command: "compact_history" });
  });

  it("keeps ordinary summarize-history requests as normal chat", async () => {
    await expect(
      classifyDesktopNaturalCommandIntent(clientReturning('{"command":"none"}'), {
        model: "deepseek-v4-flash",
        text: "总结一下对话记录里关于搜索的问题",
      }),
    ).resolves.toEqual({ command: "none" });
  });

  it("fails closed when the model response is not valid JSON", async () => {
    await expect(
      classifyDesktopNaturalCommandIntent(clientReturning("compact it"), {
        model: "deepseek-v4-flash",
        text: "帮我压缩上下文",
      }),
    ).resolves.toEqual({ command: "none" });
  });
});
