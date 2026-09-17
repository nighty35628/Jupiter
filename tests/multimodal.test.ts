import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageFileCache } from "../src/attachments/files.js";
import { projectImages } from "../src/attachments/projection.js";
import { AttachmentStore } from "../src/attachments/store.js";
import { DeepSeekClient } from "../src/client.js";
import { runDesktopLightAsk } from "../src/desktop/ask-light.js";
import { formatSessionMarkdown } from "../src/desktop/session-markdown.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { loadSessionMessages, rewriteSession, sessionPath } from "../src/memory/session.js";
import {
  DEEPSEEK_VISION_MODEL as model,
  resolveModelCapability,
} from "../src/provider-capabilities.js";
import { ToolRegistry } from "../src/tools.js";

let root: string;
let store: AttachmentStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jupiter-multimodal-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  store = new AttachmentStore(join(root, "images"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const photon = new PhotonImage(new Uint8Array([255, 30, 90, 255, 10, 180, 230, 255]), 2, 1);
  try {
    return await store.importBytes(photon.get_bytes(), "sample.png");
  } finally {
    photon.free();
  }
}
function response(content = "image understood", calls?: unknown[]): Response {
  return Response.json({
    choices: [
      {
        message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
        finish_reason: calls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 400, completion_tokens: 5, total_tokens: 405 },
  });
}
async function collect(events: AsyncGenerator<unknown>) {
  const output: any[] = [];
  for await (const item of events) output.push(item);
  return output;
}
function client(
  fetch: typeof globalThis.fetch,
  extra: ConstructorParameters<typeof DeepSeekClient>[0] = {},
) {
  return new DeepSeekClient({
    apiKey: "test-key",
    baseUrl: "https://api.deepseek.com",
    attachmentStore: store,
    imageTransport: "inline",
    fetch,
    retry: { maxAttempts: 1 },
    ...extra,
  });
}

describe("image capability and wire projection", () => {
  it("does not infer vision or Files from a model family or a third-party model name", () => {
    expect(
      resolveModelCapability("https://api.deepseek.com", "deepseek-v4-pro").supportsImages,
    ).toBe(false);
    expect(resolveModelCapability("https://api.deepseek.com", model)).toMatchObject({
      supportsImages: true,
      supportsImageFiles: true,
      supportsPrefixContinuation: true,
    });
    expect(resolveModelCapability("https://gateway.example/v1", model).supportsImages).toBe(false);
    expect(
      resolveModelCapability("https://gateway.example/v1", model, "deepseek", true),
    ).toMatchObject({ supportsImages: true, supportsImageFiles: false });
  });
  it("projects user/tool images without mutating history or adding durable user turns", async () => {
    const image = await fixture();
    const messages = [
      { role: "user" as const, content: "inspect", clientId: "stable", attachments: [image] },
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "call",
            type: "function" as const,
            function: { name: "read_image", arguments: "{}" },
          },
        ],
      },
      { role: "tool" as const, tool_call_id: "call", content: "screenshot", attachments: [image] },
    ];
    const before = JSON.stringify(messages);
    const projected = await projectImages(messages, { supportsImages: true, store });
    expect(JSON.stringify(messages)).toBe(before);
    expect(projected.messages.map((item) => item.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(projected.messages[2]?.content).toBe("screenshot");
    expect(JSON.stringify(projected.messages)).not.toContain("clientId");
    expect(JSON.stringify(projected.messages)).toContain("data:image/jpeg;base64,");
    expect(projected.snapshot.sent).toHaveLength(2);
  });
  it("omits only older images and reports every omission", async () => {
    const image = await fixture();
    const messages = Array.from({ length: 35 }, (_, index) => ({
      role: "user" as const,
      content: `turn ${index}`,
      attachments: [image],
    }));
    const projected = await projectImages(messages, { supportsImages: true, store });
    expect(projected.snapshot.sent).toHaveLength(32);
    expect(projected.snapshot.omitted).toHaveLength(3);
    expect(JSON.stringify(projected.messages).match(/data:image/g)).toHaveLength(32);
    expect(JSON.stringify(projected.messages[0])).toContain("omitted");
    await expect(
      projectImages(
        [
          {
            role: "user",
            content: "",
            attachments: Array.from({ length: 33 }, () => ({ ...image })),
          },
        ],
        { supportsImages: true, store },
      ),
    ).rejects.toThrow(/too many/);
  }, 30_000);
  it("rejects unsupported models before any network call", async () => {
    const image = await fixture();
    const fetch = vi.fn();
    await expect(
      client(fetch).chat({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "", attachments: [image] }],
      }),
    ).rejects.toThrow(/does not support/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Files reuse and bounded fallback", () => {
  it("uploads once and reuses the provider-scoped file id across requests", async () => {
    const image = await fixture();
    const payloads: any[] = [];
    let uploads = 0;
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/files")) {
        uploads++;
        const file = (init!.body as FormData).get("file") as File;
        expect((init!.body as FormData).get("purpose")).toBe("user_data");
        return Response.json({
          id: "file-api-test",
          bytes: file.size,
          expires_at: Math.floor(Date.now() / 1000) + 604800,
        });
      }
      payloads.push(JSON.parse(init!.body as string));
      return response();
    });
    const options = {
      model,
      messages: [{ role: "user" as const, content: "", attachments: [image] }],
    };
    await client(fetch, { imageTransport: "auto" }).chat(options);
    await client(fetch, { imageTransport: "auto" }).chat(options);
    expect(uploads).toBe(1);
    expect(JSON.stringify(payloads)).toContain('"file_id":"file-api-test"');
    expect(JSON.stringify(payloads)).not.toContain("base64");
  });
  it("falls back once for an expired file within the same chat retry budget", async () => {
    const image = await fixture();
    let calls = 0;
    const payloads: any[] = [];
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/files"))
        return Response.json({
          id: "file-api-expired",
          bytes: ((init!.body as FormData).get("file") as File).size,
        });
      payloads.push(JSON.parse(init!.body as string));
      calls++;
      return calls === 1
        ? Response.json({ error: { code: "file_expired" } }, { status: 400 })
        : response();
    });
    await client(fetch, { imageTransport: "auto", retry: { maxAttempts: 2 } }).chat({
      model,
      messages: [{ role: "user", content: "", attachments: [image] }],
    });
    expect(calls).toBe(2);
    expect(JSON.stringify(payloads[1])).toContain("base64");
  });
  it("does not disguise credentials errors or send Files requests to a third party", async () => {
    const image = await fixture();
    const fetch = vi.fn(async () => new Response("invalid", { status: 401 }));
    await expect(
      client(fetch, { imageTransport: "auto" }).chat({
        model,
        messages: [{ role: "user", content: "", attachments: [image] }],
      }),
    ).rejects.toThrow(/401/);
    expect(fetch).toHaveBeenCalledTimes(1);
    const custom = vi.fn(async (url: unknown) => {
      expect(String(url)).not.toMatch(/\/files$/);
      return response();
    });
    await client(custom, {
      imageTransport: "auto",
      baseUrl: "https://gateway.example/v1",
      visionModels: [model],
    }).chat({ model, messages: [{ role: "user", content: "", attachments: [image] }] });
  });
  it("coalesces uploads without letting one cancelled caller abort another", async () => {
    let complete!: (response: Response) => void;
    const fetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          complete = resolve;
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          );
        }),
    );
    const cache = new ImageFileCache({
      baseUrl: "https://api.deepseek.com",
      apiKey: "a",
      fetch,
      root,
    });
    const a = new AbortController();
    const b = new AbortController();
    const first = cache.resolve(new Uint8Array([1, 2, 3]), "image/jpeg", a.signal);
    const rejected = expect(first).rejects.toThrow(/cancelled/);
    const second = cache.resolve(new Uint8Array([1, 2, 3]), "image/jpeg", b.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 15));
    a.abort();
    complete(Response.json({ id: "file-shared", bytes: 3 }));
    await rejected;
    expect(await second).toBe("file-shared");
    expect(
      new ImageFileCache({ baseUrl: "https://api.deepseek.com", apiKey: "b", fetch, root }).scope,
    ).not.toBe(cache.scope);
  });
  it("never restarts the six-attempt chat budget after stale-file recovery", async () => {
    const image = await fixture();
    let calls = 0;
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/files"))
        return Response.json({
          id: "file-stale",
          bytes: ((init!.body as FormData).get("file") as File).size,
        });
      calls++;
      return calls === 1
        ? Response.json({ error: { code: "file_expired" } }, { status: 400 })
        : new Response("unavailable", { status: 503 });
    });
    await expect(
      client(fetch, {
        imageTransport: "auto",
        retry: { maxAttempts: 6, initialBackoffMs: 0, maxBackoffMs: 0 },
      }).chat({ model, messages: [{ role: "user", content: "", attachments: [image] }] }),
    ).rejects.toThrow();
    expect(calls).toBe(6);
  });
});

describe("image-aware compaction", () => {
  it("uses the active visual model and preserves durable source handles", async () => {
    const image = await fixture();
    const requests: any[] = [];
    const loop = new CacheFirstLoop({
      client: client(async (_url, init) => {
        requests.push(JSON.parse(init!.body as string));
        return response("summary");
      }),
      prefix: new ImmutablePrefix({ system: "test" }),
      model,
      stream: false,
      session: "fold",
    });
    loop.log.append({ role: "user", content: "Inspect this diagram", attachments: [image] });
    loop.log.append({ role: "assistant", content: "visual details ".repeat(100) });
    rewriteSession("fold", loop.log.toFullHistory());
    expect((await loop.compactHistory({ keepRecentTokens: 1 })).folded).toBe(true);
    expect(requests[0].model).toBe(model);
    expect(JSON.stringify(requests[0])).toContain("data:image");
    expect(loadSessionMessages("fold")[0]?.sourceAttachments).toEqual([image]);
    const projected = await projectImages(loop.log.toFullHistory(), {
      supportsImages: false,
      store,
    });
    expect(JSON.stringify(projected.messages)).toContain(image.id);
    expect(JSON.stringify(projected.messages)).not.toContain("data:image");
  });
  it("leaves image history untouched when a fold cannot be committed", async () => {
    const image = await fixture();
    const loop = new CacheFirstLoop({
      client: client(async () => response("summary")),
      prefix: new ImmutablePrefix({ system: "test" }),
      model,
      stream: false,
      session: "bad-fold",
    });
    loop.log.append({ role: "user", content: "", attachments: [image] });
    loop.log.append({ role: "assistant", content: "visual details ".repeat(100) });
    const before = JSON.stringify(loop.log.toFullHistory());
    await mkdir(sessionPath("bad-fold"), { recursive: true });
    expect(await loop.compactHistory({ keepRecentTokens: 1 })).toMatchObject({
      folded: false,
      reason: "persistence-failed",
    });
    expect(JSON.stringify(loop.log.toFullHistory())).toBe(before);
  });
});

describe("complete multimodal turns", () => {
  it("saves a pure-image draft and submission id, reloads and restores it for retry", async () => {
    const image = await fixture();
    const fetch = vi.fn(async () => response());
    const loop = new CacheFirstLoop({
      client: client(fetch),
      prefix: new ImmutablePrefix({ system: "test" }),
      model,
      stream: false,
      session: "images",
    });
    await collect(loop.step("", { clientId: "message-1", attachments: [image] }));
    const records = loadSessionMessages("images");
    expect(records[0]).toMatchObject({ clientId: "message-1", content: "", attachments: [image] });
    expect(JSON.stringify(records)).not.toContain("base64");
    expect(loop.retryLastDraft()).toEqual({ text: "", attachments: [image] });
    expect(loop.currentTurn).toBe(0);
  });
  it("does not execute a model or retain an optimistic message after an image commit fails", async () => {
    const image = await fixture();
    const fetch = vi.fn(async () => response());
    const loop = new CacheFirstLoop({
      client: client(fetch),
      prefix: new ImmutablePrefix({ system: "test" }),
      model,
      stream: false,
      session: "broken",
    });
    await mkdir(sessionPath("broken"), { recursive: true });
    await expect(collect(loop.step("", { attachments: [image] }))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(loop.currentTurn).toBe(0);
    expect(loop.log.length).toBe(0);
  });
  it("keeps Ask image-only and tool-free", async () => {
    const image = await fixture();
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.tools).toBeUndefined();
      expect(JSON.stringify(body.messages)).toContain("base64");
      return response();
    });
    await runDesktopLightAsk({
      client: client(fetch),
      model,
      text: "",
      attachments: [image],
      turn: 1,
      emit: () => {},
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("preserves completed image tool results when manually continuing a failed API request", async () => {
    const image = await fixture();
    let round = 0;
    const fetch = vi.fn(async () => {
      round++;
      if (round === 1)
        return response("", [
          {
            id: "screenshot-1",
            type: "function",
            function: { name: "screenshot", arguments: "{}" },
          },
        ]);
      if (round === 2) return new Response("slow down", { status: 429 });
      return response();
    });
    const screenshot = vi.fn((_args, ctx) => {
      ctx.reportImage(image);
      return "screenshot";
    });
    const tools = new ToolRegistry().register({
      name: "screenshot",
      parameters: { type: "object", properties: {} },
      fn: screenshot,
    });
    const loop = new CacheFirstLoop({
      client: client(fetch),
      prefix: new ImmutablePrefix({ system: "test", toolSpecs: tools.specs() }),
      tools,
      model,
      stream: false,
      session: "tool-image",
    });
    await collect(loop.step("inspect"));
    expect(loop.canRetryFailedModelRequest()).toBe(true);
    await collect(loop.retryFailedModelRequest());
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(loop.log.toFullHistory().filter((message) => message.role === "user")).toHaveLength(1);
    expect(
      loop.log.toFullHistory().find((message) => message.role === "tool")?.attachments,
    ).toEqual([image]);
  });
  it("exports an explicit image placeholder rather than an empty user turn", async () => {
    const image = await fixture();
    expect(
      formatSessionMarkdown([{ kind: "user", text: "", turn: 1, attachments: [image] }], {
        user: "User",
        assistant: "Assistant",
        tool: "Tool",
        reasoning: "Thinking",
      }),
    ).toContain("Image bytes are not included");
  });
});
