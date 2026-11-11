import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { resolveRequestBudget } from "../src/context-budget.js";

describe("request budget snapshot", { retry: 0 }, () => {
  it("does not validate an old wire output cap against a newer provider budget", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: "unsafe" } }] }),
    );
    const client = new DeepSeekClient({
      apiKey: "synthetic",
      baseUrl: "https://synthetic.invalid/v1",
      fetch,
    });
    const first = resolveRequestBudget({
      model: "snapshot",
      contextWindowTokens: 4096,
      maxTokens: 3000,
    });
    const later = resolveRequestBudget({
      model: "snapshot",
      contextWindowTokens: 4096,
      maxTokens: 1000,
    });
    const budget = vi
      .spyOn(client, "getRequestBudget")
      .mockReturnValueOnce(first)
      .mockReturnValue(later);
    await expect(
      client.chat({
        model: "snapshot",
        messages: [{ role: "user", content: "bounded evidence ".repeat(1000) }],
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED" });
    expect(fetch).not.toHaveBeenCalled();
    expect(budget).toHaveBeenCalledTimes(1);
  });
});
