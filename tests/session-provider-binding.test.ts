import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { deleteSession, loadSessionMeta, patchSessionMeta } from "../src/memory/session.js";
import { providerSessionBinding, resolveProviderSnapshot } from "../src/provider-runtime.js";

const sessions: string[] = [];

function sessionName(): string {
  const name = `provider-test-${randomUUID()}`;
  sessions.push(name);
  return name;
}

afterEach(() => {
  for (const session of sessions.splice(0)) deleteSession(session);
});

async function drain(loop: CacheFirstLoop): Promise<void> {
  for await (const _event of loop.step("hello")) {
    // Drain the turn to completion.
  }
}

describe("session provider binding", () => {
  it("blocks a transcript before sending it to a different endpoint", async () => {
    const session = sessionName();
    const original = resolveProviderSnapshot({
      baseUrl: "https://first.example/v1",
      apiKey: "first-key",
      model: "model-a",
      dialect: "openai-compatible",
    });
    const next = resolveProviderSnapshot({
      baseUrl: "https://second.example/v1",
      apiKey: "second-key",
      model: "model-b",
      dialect: "openai-compatible",
    });
    patchSessionMeta(session, { provider: providerSessionBinding(original) });
    const fetchMock = vi.fn(async () => Response.json({ choices: [] }));
    const client = new DeepSeekClient({
      apiKey: next.apiKey,
      baseUrl: next.baseUrl,
      dialect: next.dialect,
      providerId: next.id,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "test", toolSpecs: [] }),
      model: next.model,
      session,
      providerBinding: providerSessionBinding(next),
      stream: false,
    });

    await expect(drain(loop)).rejects.toThrow(/bound to first\.example/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("binds a legacy session on its first successful provider use", async () => {
    const session = sessionName();
    const provider = resolveProviderSnapshot({
      baseUrl: "https://relay.example/v1",
      apiKey: "relay-key",
      model: "relay-model",
      dialect: "openai-compatible",
    });
    const client = new DeepSeekClient({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      dialect: provider.dialect,
      providerId: provider.id,
      retry: { maxAttempts: 1 },
      fetch: async () =>
        Response.json({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "test", toolSpecs: [] }),
      model: provider.model,
      session,
      providerBinding: providerSessionBinding(provider),
      stream: false,
    });

    await drain(loop);
    expect(loadSessionMeta(session).provider).toEqual(providerSessionBinding(provider));
  });
});
