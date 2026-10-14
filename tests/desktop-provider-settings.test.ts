import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderVersionTracker,
  probeDesktopProvider,
  saveDesktopProvider,
  summarizeSettingsSave,
} from "../src/desktop/provider-settings.js";
afterEach(() => vi.useRealTimers());

function fixture() {
  let current = {
    baseUrl: "https://relay.example/v1",
    apiKey: "mock-key",
    model: "mock-model",
    dialectPreference: "auto" as const,
    endpointIdentity: "relay",
    officialDeepSeek: false,
    imageTransport: "auto" as const,
    capability: { supportsImages: false },
    label: "Relay",
  };
  const tracker = createProviderVersionTracker("mock-instance");
  const resolve = vi.fn((input: any = {}) => ({
    ...current,
    ...input,
    dialectPreference: input.dialect ?? current.dialectPreference,
    endpointIdentity: input.baseUrl && input.baseUrl !== current.baseUrl ? "other" : "relay",
  }));
  const save = vi.fn((input: any) => {
    current = { ...current, ...input, dialectPreference: input.dialect };
  });
  const deps = {
    resolve,
    tracker,
    save,
    bindLegacy: vi.fn(),
    sources: () => ({ baseUrlSource: "config", apiKeySource: "config" }),
  };
  return {
    deps,
    savedVersion: tracker.observe(current),
    changeKey: () => {
      current = { ...current, apiKey: "mock-rotated-key" };
    },
  };
}

describe("desktop provider request boundaries", { retry: 0 }, () => {
  it("checks CAS before any write, and versions are opaque and only RAM-resident", () => {
    const f = fixture();
    f.changeKey();
    const result = saveDesktopProvider(
      { baseUrl: "https://relay.example/v1", expectedProviderVersion: f.savedVersion },
      f.deps,
    );
    expect(result.status).toBe("conflict");
    expect(f.deps.save).not.toHaveBeenCalled();
    expect(f.deps.bindLegacy).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("mock-key");
    expect(result.providerVersion).not.toContain("mock-rotated-key");
  });

  it("saves atomically and keeps provider success when another settings group fails", () => {
    const f = fixture();
    const provider = saveDesktopProvider(
      { model: "next", expectedProviderVersion: f.savedVersion },
      f.deps,
    );
    expect(f.deps.save).toHaveBeenCalledTimes(1);
    expect(provider.status).toBe("success");
    const result = summarizeSettingsSave("save-1", provider, { status: "unknown" }, f.deps.tracker);
    expect(result.provider?.status).toBe("success");
    expect(result.settings?.status).toBe("unknown");
    expect(result.status).toBe("unknown");
  });

  it("rejects provider save and probe on the Web surface before touching credentials/network", async () => {
    const f = fixture();
    expect(
      saveDesktopProvider({ expectedProviderVersion: f.savedVersion }, { ...f.deps, web: true })
        .status,
    ).toBe("failure");
    const createClient = vi.fn();
    expect(
      (
        await probeDesktopProvider(
          {
            requestId: "probe-1",
            expectedProviderVersion: f.savedVersion,
            baseUrl: "https://relay.example/v1",
            model: "mock-model",
            providerDialect: "auto",
          },
          { ...f.deps, web: true, createClient },
        )
      ).status,
    ).toBe("failure");
    expect(createClient).not.toHaveBeenCalled();
    expect(f.deps.save).not.toHaveBeenCalled();
  });

  it("binds results to the adopted saved credential version and distinguishes models from chat", async () => {
    const f = fixture();
    const chat = vi.fn(async () => ({}));
    const createClient = vi.fn(() => ({
      listModels: vi.fn(async () => ({ data: [{ id: "model-a" }] })),
      chat,
    }));
    const request = {
      requestId: "probe-1",
      expectedProviderVersion: f.savedVersion,
      baseUrl: "https://relay.example/v1",
      model: "mock-model",
      providerDialect: "auto" as const,
    };
    const result = await probeDesktopProvider(request, { ...f.deps, createClient });
    expect(result).toMatchObject({
      status: "success",
      credentialSource: "saved",
      credentialVersion: f.savedVersion,
      validation: "models",
      requestId: "probe-1",
    });
    expect(chat).not.toHaveBeenCalled();
    const chatResult = await probeDesktopProvider(
      { ...request, requestId: "probe-2", apiKey: "mock-draft-key" },
      { ...f.deps, createClient: () => ({ listModels: async () => ({ data: [] }), chat }) },
    );
    expect(chatResult).toMatchObject({
      validation: "chat",
      credentialSource: "draft",
      credentialVersion: "probe-2",
    });
    expect(JSON.stringify(chatResult)).not.toContain("mock-draft-key");
  });

  it("marks late probes conflicted after key rotation/signout and redacts raw errors", async () => {
    const f = fixture();
    const result = await probeDesktopProvider(
      {
        requestId: "late",
        expectedProviderVersion: f.savedVersion,
        baseUrl: "https://relay.example/v1",
        model: "mock-model",
        providerDialect: "auto",
      },
      {
        ...f.deps,
        createClient: () => ({
          listModels: async () => {
            f.changeKey();
            return { data: [{ id: "m" }] };
          },
          chat: vi.fn(),
        }),
      },
    );
    expect(result.status).toBe("conflict");
    expect(result.ok).toBe(false);
    const failed = await probeDesktopProvider(
      {
        requestId: "error",
        baseUrl: "https://relay.example/v1",
        model: "mock-model",
        providerDialect: "auto",
      },
      {
        ...f.deps,
        createClient: () => ({
          listModels: async () => {
            throw new Error("mock-rotated-key leaked");
          },
          chat: vi.fn(),
        }),
      },
    );
    expect(JSON.stringify(failed)).not.toContain("mock-rotated-key");
  });

  it("reports timeout as unknown rather than claiming the endpoint failed verification", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const promise = probeDesktopProvider(
      {
        requestId: "timeout",
        expectedProviderVersion: f.savedVersion,
        baseUrl: "https://relay.example/v1",
        model: "mock-model",
        providerDialect: "auto",
      },
      {
        ...f.deps,
        createClient: () => ({
          listModels: ({ signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("mock aborted")), {
                once: true,
              });
            }),
          chat: vi.fn(),
        }),
      },
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await promise).status).toBe("unknown");
  });
});
