import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { DEEPSEEK_CONTEXT_TOKENS } from "../src/telemetry/stats.js";
import {
  DEFAULT_BOUNDED_TOKENIZE_CHARS,
  countRequestTokens,
  countTokens,
  countTokensAsync,
  countTokensBounded,
  encode,
  estimateConversationTokens,
  estimateRequestTokens,
  formatDeepSeekPrompt,
} from "../src/tokenizer.js";

describe("full wire token counting", { retry: 0 }, () => {
  it.each([
    "",
    "Hello, world!",
    "你好，世界！",
    "12345678901234567890",
    "🎉🚀💻🔥",
    "<think>你好</think><｜User｜>Hello",
    `${"hello ".repeat(500)}<think>${"汉 ".repeat(500)}`,
  ])("matches exact encoding across pre-token and added-token boundaries: %s", async (text) => {
    expect(await countTokensAsync(text)).toBe(encode(text).length);
  });

  it.each([
    "A".repeat(2053),
    "a".repeat(2071),
    "汉".repeat(1031),
    `${"!".repeat(511)}🎉${"!".repeat(2053)}`,
  ])("preserves merges inside an oversized pre-token", async (text) => {
    const count = await countTokensAsync(text);
    expect(count).toBe(countTokens(text));
  });

  it("matches independent golden counts without warming the shared BPE cache", async () => {
    expect(await countTokensAsync("Hello!")).toBe(2);
    expect(await countTokensAsync("你好")).toBe(1);
    expect(await countTokensAsync("mixed 中文 and english 混合")).toBe(7);
    expect(await countTokensAsync("<think>reasoning here</think>")).toBe(5);
  });

  it("keeps concurrent counts independent across yields", async () => {
    const texts = [
      `${"left ".repeat(1000)}<think>${"右 ".repeat(1000)}`,
      `${"右 ".repeat(1000)}</think>${"left ".repeat(1000)}`,
    ];
    const first = countTokensAsync(texts[0]!);
    const second = countTokensAsync(texts[1]!);
    expect(await first).toBe(countTokens(texts[0]!));
    expect(await second).toBe(countTokens(texts[1]!));
  });

  it("lets timers run while counting a large unbroken pre-token", async () => {
    let timerRan = false;
    const timer = setTimeout(() => {
      timerRan = true;
    }, 0);
    try {
      expect(await countTokensAsync("A".repeat(100_000))).toBeGreaterThan(0);
      expect(timerRan).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it("cancels a long count before contacting the provider", async () => {
    const controller = new AbortController();
    const fetch = vi.fn();
    const client = new DeepSeekClient({ apiKey: "synthetic", fetch, retry: { maxAttempts: 1 } });
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      await expect(
        client.chat({
          model: "deepseek-flash",
          messages: [{ role: "user", content: "A".repeat(100_000) }],
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
    }
  });

  it("honors an already-cancelled count", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(countTokensAsync("hello", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("matches the existing V4 template including tool results and reasoning", async () => {
    const messages = [
      { role: "system", content: "s" },
      { role: "user", content: "read" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "inspect",
        tool_calls: [{ id: "call", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
      },
      { role: "tool", content: "result" },
      { role: "user", content: "continue" },
    ];
    const before = JSON.stringify(messages);
    for (const dropThinking of [false, true]) {
      expect(await countRequestTokens(messages, [], dropThinking)).toBe(
        countTokens(formatDeepSeekPrompt(messages, dropThinking)),
      );
    }
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("counts current tool schemas even when their array is reused", async () => {
    const messages = [{ role: "user", content: "hi" }];
    const tools = [{ function: { name: "read", description: "small" } }];
    const before = await countRequestTokens(messages, tools);
    tools[0]!.function.description = "large schema ".repeat(1000);
    expect(await countRequestTokens(messages, tools)).toBeGreaterThan(before + 1000);
  });

  it("accepts an exactly-fitting request and rejects one token below it", async () => {
    const model = "wire-boundary-regression";
    const messages = [{ role: "user", content: `${"hello ".repeat(500)}你好` }];
    const tokens = countTokens(formatDeepSeekPrompt(messages, true));
    const fetch = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    const client = new DeepSeekClient({ apiKey: "synthetic", fetch, retry: { maxAttempts: 1 } });
    try {
      DEEPSEEK_CONTEXT_TOKENS[model] = tokens;
      await expect(client.chat({ model, messages })).resolves.toMatchObject({ content: "ok" });
      DEEPSEEK_CONTEXT_TOKENS[model] = tokens - 1;
      await expect(client.chat({ model, messages })).rejects.toMatchObject({
        code: "CONTEXT_WINDOW_EXCEEDED",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(DEEPSEEK_CONTEXT_TOKENS, model);
    }
  });
});

describe("DeepSeek V4 tokenizer — golden cases", () => {
  it("empty string is zero tokens", () => {
    expect(encode("")).toEqual([]);
    expect(countTokens("")).toBe(0);
  });

  it("ASCII words tokenize compactly", () => {
    expect(encode("Hello!")).toEqual([19923, 3]);
    expect(encode("Hello, world!")).toEqual([19923, 14, 2058, 3]);
  });

  it("common CJK collocation is a single token", () => {
    expect(encode("你好")).toEqual([30594]);
  });

  it("CJK sentence splits on punctuation", () => {
    expect(encode("你好，世界！")).toEqual([30594, 303, 3427, 1175]);
  });

  it("digit run is isolated by the \\p{N}{1,3} pre-tokenizer rule", () => {
    expect(encode("1 + 1 = 2")).toEqual([19, 940, 223, 19, 438, 223, 20]);
  });

  it("recognizes <think>/</think> as atomic added tokens", () => {
    const ids = encode("<think>reasoning here</think>");
    expect(ids[0]).toBe(128821);
    expect(ids[ids.length - 1]).toBe(128822);
    expect(ids.length).toBe(5);
  });

  it("mixed English+CJK follows the right pre-tokenizer branches", () => {
    const ids = encode("mixed 中文 and english 混合");
    expect(ids).toEqual([122545, 223, 21134, 305, 33010, 223, 14769]);
  });

  it("round-trips a code snippet at a reasonable compression ratio", () => {
    const src = "function add(a, b) { return a + b; }";
    const n = countTokens(src);
    expect(n).toBeGreaterThanOrEqual(10);
    expect(n).toBeLessThanOrEqual(16);
  });

  it("Chinese prose gets the expected ~0.6 tokens/char rate", () => {
    const text = "深度求索是一家专注于人工智能基础技术研究的公司";
    const n = countTokens(text);
    expect(n).toBeGreaterThanOrEqual(8);
    expect(n).toBeLessThanOrEqual(16);
  });
});

describe("formatDeepSeekPrompt", () => {
  it("renders system + user with BOS and generation suffix", () => {
    const out = formatDeepSeekPrompt([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hi" },
    ]);
    expect(out).toBe("<｜begin▁of▁sentence｜>Be concise.<｜User｜>Hi<｜Assistant｜></think>");
  });

  it("renders multi-turn with role prefixes and EOS on assistant", () => {
    const out = formatDeepSeekPrompt([
      { role: "system", content: "Helpful." },
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
    ]);
    expect(out).toBe(
      "<｜begin▁of▁sentence｜>Helpful.<｜User｜>Q1<｜Assistant｜></think>A1<｜end▁of▁sentence｜><｜User｜>Q2<｜Assistant｜></think>",
    );
  });

  it("renders DSML tool_calls when assistant has no content", () => {
    const out = formatDeepSeekPrompt([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
      },
    ]);
    expect(out).toContain("<｜DSML｜tool_calls>");
    expect(out).toContain('<｜DSML｜invoke name="read_file">');
    expect(out).toContain("a.ts");
    expect(out).toContain("<｜DSML｜parameter");
    expect(out).toMatch(/<｜end▁of▁sentence｜>$/);
  });

  it("merges tool results into user messages with <tool_result> blocks", () => {
    const out = formatDeepSeekPrompt([
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", content: "file contents" },
      { role: "user", content: "thanks" },
    ]);
    expect(out).toContain("<tool_result>file contents</tool_result>");
    expect(out).toMatch(/<｜Assistant｜><\/think>$/);
  });

  it("handles missing role as user default", () => {
    const out = formatDeepSeekPrompt([{ content: "hello" }]);
    expect(out).toBe("<｜begin▁of▁sentence｜><｜User｜>hello<｜Assistant｜></think>");
  });

  it("empty messages array returns just the generation prompt", () => {
    expect(formatDeepSeekPrompt([])).toBe("<｜Assistant｜></think>");
  });

  it("wraps reasoning_content in <think>...</think> before content", () => {
    const out = formatDeepSeekPrompt([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "Hi there!",
        reasoning_content: "User greeted me, I should respond.",
      },
    ]);
    expect(out).toContain("<think>User greeted me, I should respond.</think>Hi there!");
  });

  it("renders reasoning_content without content", () => {
    const out = formatDeepSeekPrompt([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "Thinking step only.",
      },
    ]);
    expect(out).toContain("<think>Thinking step only.</think>");
    expect(out).toMatch(/<｜end▁of▁sentence｜>$/);
  });

  it("renders reasoning_content alongside tool_calls", () => {
    const out = formatDeepSeekPrompt([
      { role: "user", content: "read file" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "I need to use read_file tool.",
        tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
      },
    ]);
    expect(out).toContain("<think>I need to use read_file tool.</think>");
    expect(out).toContain("<｜DSML｜tool_calls>");
  });

  it("handles drop_thinking by stripping early reasoning_content", () => {
    const out = formatDeepSeekPrompt(
      [
        { role: "user", content: "Q1" },
        {
          role: "assistant",
          content: "A1",
          reasoning_content: "Early reasoning - should be dropped.",
        },
        { role: "user", content: "Q2" },
        {
          role: "assistant",
          content: "A2",
          reasoning_content: "Late reasoning - should be kept.",
        },
      ],
      true,
    );
    expect(out).not.toContain("Early reasoning");
    expect(out).toContain("<think>Late reasoning");
  });

  it("default drop_thinking=false preserves all reasoning_content", () => {
    const out = formatDeepSeekPrompt([
      { role: "user", content: "Q1" },
      {
        role: "assistant",
        content: "A1",
        reasoning_content: "Early reasoning.",
      },
      { role: "user", content: "Q2" },
    ]);
    expect(out).toContain("Early reasoning");
  });
});

describe("estimateConversationTokens", () => {
  it("counts V4-templated tokens including framing overhead", () => {
    const n = estimateConversationTokens([
      { role: "user", content: "you are helpful" },
      { role: "user", content: "你好" },
      { role: "user", content: "Hello!" },
    ]);
    const rawContent = countTokens("you are helpful") + countTokens("你好") + countTokens("Hello!");
    expect(n).toBeGreaterThan(rawContent);
  });

  it("counts DSML tool_calls via template when present on assistant", () => {
    const withCalls = estimateConversationTokens([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
      },
    ]);
    expect(withCalls).toBeGreaterThan(0);
  });

  it("counts framing tokens even for null/empty content messages", () => {
    const n = estimateConversationTokens([
      { role: "user", content: null },
      { role: "user", content: "" },
      { role: "user", content: undefined },
    ]);
    expect(n).toBeGreaterThan(0);
  });
});

describe("estimateRequestTokens", () => {
  it("includes TOOLS_TEMPLATE overhead when toolSpecs are provided", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const withTools = estimateRequestTokens(msgs, [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ]);
    // The overhead should be significantly larger than the raw schema JSON count
    const rawSchema = countTokens(
      JSON.stringify({
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      }),
    );
    expect(withTools).toBeGreaterThan(estimateConversationTokens(msgs) + rawSchema);
  });

  it("returns conversation tokens when no tools", () => {
    const msgs = [{ role: "user", content: "hi" }];
    expect(estimateRequestTokens(msgs, null)).toBe(estimateConversationTokens(msgs));
  });

  it("returns conversation tokens when empty tools array", () => {
    const msgs = [{ role: "user", content: "hi" }];
    expect(estimateRequestTokens(msgs, [])).toBe(estimateConversationTokens(msgs));
  });

  it("counts tools with function extraction", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const withFn = estimateRequestTokens(msgs, [
      { function: { name: "foo", parameters: { type: "object", properties: {} } } },
    ]);
    const bare = estimateConversationTokens(msgs);
    expect(withFn).toBeGreaterThan(bare);
  });

  it("drop_thinking=true reduces tokens when early reasoning exists", () => {
    const msgs = [
      { role: "user", content: "Q1" },
      {
        role: "assistant",
        content: "A1",
        reasoning_content: "Some lengthy early reasoning that should be dropped...",
      },
      { role: "user", content: "Q2" },
    ];
    const withDrop = estimateConversationTokens(msgs, true);
    const withoutDrop = estimateConversationTokens(msgs, false);
    expect(withDrop).toBeLessThan(withoutDrop);
  });
});

describe("countTokensBounded", () => {
  it("keeps the default sample cap conservative for pathological BPE input", () => {
    expect(DEFAULT_BOUNDED_TOKENIZE_CHARS).toBeLessThanOrEqual(2048);
  });

  it("returns the exact token count when input is within the char cap", () => {
    const text = "Hello world! 你好 deepseek.";
    expect(countTokensBounded(text, text.length)).toBe(countTokens(text));
  });

  it("estimates oversized input from a bounded head/tail sample", () => {
    const head = "Hello world! ".repeat(40);
    const middle = "A".repeat(100_000);
    const tail = "你好 deepseek ".repeat(40);
    const text = head + middle + tail;

    const estimate = countTokensBounded(text, 512);

    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(text.length);
    expect(estimate).toBeGreaterThan(Math.floor(text.length * 0.05));
  });

  it("bounds pathological repetitive input without multi-second BPE work", () => {
    const text = "A".repeat(100_000);
    const t0 = performance.now();
    const estimate = countTokensBounded(text);
    const t1 = performance.now();

    expect(estimate).toBeGreaterThan(0);
    expect(t1 - t0).toBeLessThan(1000);
  });
});

describe("countTokens ↔ encode equivalence", () => {
  const corpus: [string, string][] = [
    ["empty", ""],
    ["plain ASCII", "Hello, world!"],
    ["ASCII sentence", "The quick brown fox jumps over the lazy dog."],
    ["CJK characters", "你好世界"],
    ["CJK prose", "深度求索是一家专注于人工智能基础技术研究的公司"],
    ["mixed English+CJK", "mixed 中文 and english 混合"],
    ["emoji (surrogate pairs)", "🎉🚀💻🔥"],
    ["emoji in sentence", "Great job! 🎉 Let's go 🚀"],
    ["digits", "1 + 1 = 2, 1234567890"],
    ["special added tokens", "<think>reasoning here</think>"],
    ["multiple added tokens", "<｜begin▁of▁sentence｜>Hello<｜User｜>Hi<｜Assistant｜>"],
    ["code snippet", "function add(a, b) { return a + b; }"],
    ["JSON payload", '{"name":"test","values":[1,2,3],"nested":{"key":"value"}}'],
    ["repeated text", "Hello world! ".repeat(100)],
    ["whitespace heavy", "  \t\n  hello  \n\t  world  \t\n  "],
    ["long ASCII", "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(50)],
  ];

  for (const [label, text] of corpus) {
    it(`countTokens matches encode.length for: ${label}`, () => {
      expect(countTokens(text)).toBe(encode(text).length);
    });
  }

  it("countTokens matches encode.length for >10KB blob", () => {
    const big = "The quick brown fox jumps over the lazy dog. 你好世界 🎉 ".repeat(200);
    expect(big.length).toBeGreaterThan(10_000);
    expect(countTokens(big)).toBe(encode(big).length);
  });
});

describe("performance sanity", () => {
  it("tokenizes 10k chars of typical mixed content in under 200 ms", () => {
    const block = "Hello world! 你好 deepseek ".repeat(400);
    const t0 = performance.now();
    const n = countTokens(block);
    const t1 = performance.now();
    expect(n).toBeGreaterThan(1000);
    expect(t1 - t0).toBeLessThan(200);
  });
});
