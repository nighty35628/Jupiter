// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { applyIncoming, type Settings } from "../App";
import type { ProviderTestResultEvent, SettingsPatch, SettingsSaveResultEvent } from "../protocol";
import { ProviderSection, useProviderSettingsDraft } from "./settings";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.runtime;
  vi.useRealTimers();
});
beforeEach(() => setLang("en"));
const settings = {
  serverInstanceId: "server-1",
  providerVersion: "server-1:1",
  providerId: "relay",
  baseUrl: "https://relay.example/v1",
  model: "model-a",
  providerDialect: "auto" as const,
  reasoningEffort: "high" as const,
  thinkingEnabled: false,
  reasoningChoices: [],
  editMode: "review" as const,
  budgetUsd: null,
  workspaceDir: "/tmp/mock",
  recentWorkspaces: [],
  version: "test",
};
type DraftProps = {
  settings: Settings;
  saveResult: SettingsSaveResultEvent | null;
  probeResult: ProviderTestResultEvent | null;
};
type ProbeProps = { settings: Settings; probe: ProviderTestResultEvent | null };

function successfulProbe(overrides: Partial<ProviderTestResultEvent> = {}): ProviderTestResultEvent {
  return {
    type: "$provider_test_result",
    requestId: "probe-1",
    serverInstanceId: settings.serverInstanceId,
    providerVersion: settings.providerVersion,
    status: "success",
    ok: true,
    message: "verified",
    validation: "models",
    credentialSource: "saved",
    credentialVersion: settings.providerVersion,
    config: { baseUrl: settings.baseUrl, model: settings.model, providerDialect: "auto" },
    ...overrides,
  };
}

describe("provider UI request correlation", { retry: 0 }, () => {
  it.each([false, true])("uses the latest FIFO settings after an older save ack, retaining later edits: %s", (editInFlight) => {
    let state = { settings: { ...settings, settingsRevision: 1 }, messages: [], usage: {},
      providerConnectionLost: false } as unknown as Parameters<typeof applyIncoming>[0];
    const { result, rerender } = renderHook(
      (props: typeof state) => useProviderSettingsDraft(props.settings, props.settingsSaveResult, props.providerTestResult,
        { saves: props.settingsSaveResults, probes: props.providerTestResults, disconnected: props.providerConnectionLost }),
      { initialProps: state },
    );
    act(() => result.current.edit("model", "submitted-model"));
    act(() => result.current.edit("apiKey", "mock-submitted-key"));
    act(() => result.current.save(() => "save-1"));
    if (editInFlight) {
      act(() => result.current.edit("model", "later-edit"));
      act(() => result.current.edit("apiKey", "mock-later-key"));
    }
    const ack: SettingsSaveResultEvent = { type: "$settings_save_result", requestId: "save-1",
      serverInstanceId: "server-1", providerVersion: "server-1:2", status: "success",
      provider: { status: "success", providerVersion: "server-1:2" } };
    for (const event of [
      { ...settings, type: "$settings" as const, settingsRevision: 2, model: "submitted-model", providerVersion: "server-1:2" },
      ack,
      { ...settings, type: "$settings" as const, settingsRevision: 3, model: "other-tab-model", providerVersion: "server-1:3" },
    ]) state = applyIncoming(state, event);
    rerender(state);
    expect(state.settings?.model).toBe("other-tab-model");
    expect(result.current.saveStatus).toBe("success");
    expect(result.current.draft.values.model).toBe(editInFlight ? "later-edit" : "other-tab-model");
    expect(result.current.draft.values.apiKey).toBe(editInFlight ? "mock-later-key" : "");
    expect(Object.keys(result.current.draft.dirty)).toEqual(editInFlight ? ["model", "apiKey"] : []);
    const save = vi.fn((_patch: SettingsPatch) => "save-2");
    act(() => result.current.save(save));
    expect(save.mock.calls[0]?.[0]).toMatchObject({ expectedProviderVersion: "server-1:3",
      model: editInFlight ? "later-edit" : "other-tab-model" });
  });

  it("does not adopt an older snapshot when acknowledgement arrives before its refresh", () => {
    const { result, rerender } = renderHook(
      (props: DraftProps) => useProviderSettingsDraft(props.settings, props.saveResult, props.probeResult),
      { initialProps: { settings, saveResult: null, probeResult: null } as DraftProps },
    );
    act(() => result.current.edit("model", "submitted-model"));
    act(() => result.current.save(() => "save-1"));
    rerender({ settings, probeResult: null, saveResult: { type: "$settings_save_result", requestId: "save-1",
      serverInstanceId: "server-1", providerVersion: "server-1:2", status: "success",
      provider: { status: "success", providerVersion: "server-1:2" } } });
    expect(result.current.draft.values.model).toBe("submitted-model");
    const save = vi.fn((_patch: SettingsPatch) => "save-2");
    act(() => result.current.save(save));
    expect(save.mock.calls[0]?.[0].expectedProviderVersion).toBe("server-1:2");
    rerender({ settings: { ...settings, model: "submitted-model", providerVersion: "server-1:2" },
      saveResult: null, probeResult: null });
    expect(result.current.draft.values.model).toBe("submitted-model");
  });

  it("does not roll back the CAS base on a conflict older than the current settings", () => {
    const { result, rerender } = renderHook(
      (props: DraftProps) => useProviderSettingsDraft(props.settings, props.saveResult, props.probeResult),
      { initialProps: { settings, saveResult: null, probeResult: null } as DraftProps },
    );
    act(() => result.current.edit("model", "unsaved-model"));
    act(() => result.current.save(() => "save-1"));
    rerender({ settings: { ...settings, model: "other-tab-model", providerVersion: "server-1:3" }, probeResult: null,
      saveResult: { type: "$settings_save_result", requestId: "save-1", serverInstanceId: "server-1",
        providerVersion: "server-1:2", status: "conflict", provider: { status: "conflict", providerVersion: "server-1:2" } } });
    expect(result.current.saveStatus).toBe("conflict");
    expect(result.current.draft.values.model).toBe("unsaved-model");
    expect(result.current.draft.dirty.model).toBeDefined();
    const save = vi.fn((_patch: SettingsPatch) => "save-2");
    act(() => result.current.save(save));
    expect(save.mock.calls[0]?.[0].expectedProviderVersion).toBe("server-1:3");
  });

  it("expires probe identity, ignores late replies, and only retests on an explicit request", () => {
    vi.useFakeTimers();
    const onTest = vi.fn(() => "probe-1");
    const { result, rerender } = renderHook(
      (probe: ProviderTestResultEvent | null) => useProviderSettingsDraft(settings, null, probe),
      { initialProps: null as ProviderTestResultEvent | null },
    );
    act(() => result.current.test(onTest));
    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.probeStatus).toBe("unknown");
    expect(onTest).toHaveBeenCalledTimes(1);

    rerender(successfulProbe());
    expect(result.current.probeStatus).toBe("unknown");
    expect(result.current.probeResult).toBeNull();
    rerender(successfulProbe({ status: "pending", ok: false, validation: "none" }));
    expect(result.current.probeStatus).toBe("unknown");

    act(() => result.current.test(() => "probe-2"));
    rerender(successfulProbe());
    expect(result.current.probeStatus).toBe("pending");
    expect(result.current.probeResult).toBeNull();
    rerender(successfulProbe({ requestId: "probe-2" }));
    expect(result.current.probeStatus).toBe("success");
  });

  it.each(["conflict", "failure", "unknown"] as const)(
    "accepts matching %s with a newer server version but rejects unrelated and late replies",
    (status) => {
      vi.useFakeTimers();
      const { result, rerender } = renderHook(
        (probe: ProviderTestResultEvent | null) => useProviderSettingsDraft(settings, null, probe),
        { initialProps: null as ProviderTestResultEvent | null },
      );
      act(() => result.current.test(() => "probe-1"));
      const event = successfulProbe({
        status, ok: false, providerVersion: "server-1:2", credentialSource: "none",
        credentialVersion: undefined, validation: "none", config: undefined,
      });
      rerender({ ...event, requestId: "another-probe" });
      expect(result.current.probeStatus).toBe("pending");
      rerender({ ...event, serverInstanceId: "another-server" });
      expect(result.current.probeStatus).toBe("pending");
      rerender(event);
      expect(result.current.probeStatus).toBe(status);
      expect(result.current.probeResult).toEqual(event);
      act(() => vi.advanceTimersByTime(30_000));
      expect(result.current.probeStatus).toBe(status);
      rerender(successfulProbe());
      expect(result.current.probeStatus).toBe(status);
      expect(result.current.probeResult?.ok).toBe(false);
    },
  );

  it("still requires the submitted provider version for successful probes", () => {
    const { result, rerender } = renderHook(
      (probe: ProviderTestResultEvent | null) => useProviderSettingsDraft(settings, null, probe),
      { initialProps: null as ProviderTestResultEvent | null },
    );
    act(() => result.current.test(() => "probe-1"));
    rerender(successfulProbe({ providerVersion: "server-1:2", credentialVersion: "server-1:1" }));
    expect(result.current.probeStatus).toBe("pending");
    expect(result.current.probeResult).toBeNull();
    rerender(successfulProbe());
    expect(result.current.probeStatus).toBe("success");
  });

  it("does not apply a conflict to a subsequently edited draft", () => {
    const { result, rerender } = renderHook(
      (probe: ProviderTestResultEvent | null) => useProviderSettingsDraft(settings, null, probe),
      { initialProps: null as ProviderTestResultEvent | null },
    );
    act(() => result.current.test(() => "probe-1"));
    act(() => result.current.edit("apiKey", "mock-new-key"));
    rerender(successfulProbe({ status: "conflict", ok: false, providerVersion: "server-1:2" }));
    expect(result.current.probeStatus).toBeNull();
    expect(result.current.probeResult).toBeNull();
    expect(result.current.draft.values.apiKey).toBe("mock-new-key");
  });

  it("retains dirty draft on same/unrelated/other-provider refresh and preserves edits in flight", () => {
    const onSave = vi.fn((_patch: SettingsPatch) => "save-1");
    const { result, rerender } = renderHook(
      (props: DraftProps) =>
        useProviderSettingsDraft(props.settings, props.saveResult, props.probeResult),
      {
        initialProps: { settings, saveResult: null, probeResult: null } as DraftProps,
      },
    );
    act(() => {
      result.current.edit("apiKey", "mock-key");
      result.current.edit("model", "draft-model");
    });
    rerender({
      settings: { ...settings, model: "other-model", providerVersion: "server-1:2" },
      saveResult: null,
      probeResult: null,
    });
    expect(result.current.draft.values.model).toBe("draft-model");
    act(() => result.current.save(onSave));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ expectedProviderVersion: "server-1:1" });
    act(() => result.current.edit("apiKey", "mock-new-key"));
    rerender({
      settings: { ...settings, model: "draft-model", providerVersion: "server-1:3" },
      saveResult: {
        type: "$settings_save_result",
        requestId: "save-1",
        serverInstanceId: "server-1",
        providerVersion: "server-1:3",
        status: "unknown",
        provider: { status: "success", providerVersion: "server-1:3" },
        settings: { status: "unknown" },
      },
      probeResult: null,
    });
    expect(result.current.draft.values.apiKey).toBe("mock-new-key");
    expect(result.current.saveStatus).toBe("success");
  });

  it("rejects unrelated acknowledgements, retains failed keys, and clears only a matched success", () => {
    const { result, rerender } = renderHook(
      (props: SettingsSaveResultEvent | null) => useProviderSettingsDraft(settings, props, null),
      { initialProps: null as SettingsSaveResultEvent | null },
    );
    act(() => result.current.edit("apiKey", "mock-key"));
    act(() => result.current.save(() => "save-1"));
    const event: SettingsSaveResultEvent = {
      type: "$settings_save_result",
      requestId: "save-1",
      serverInstanceId: "server-1",
      providerVersion: "server-1:1",
      status: "success",
      provider: { status: "success" },
    };
    rerender({ ...event, requestId: "unrelated" });
    expect(result.current.draft.values.apiKey).toBe("mock-key");
    rerender({ ...event, requestId: "save-1", status: "failure", provider: { status: "failure" } });
    expect(result.current.draft.values.apiKey).toBe("mock-key");
    act(() => result.current.save(() => "save-2"));
    rerender({ ...event, requestId: "save-2" });
    expect(result.current.draft.values.apiKey).toBe("");
  });

  it("hides stale/out-of-order/wrong-credential/config results, including after signout and restart", () => {
    const { result, rerender } = renderHook(
      (props: ProbeProps) => useProviderSettingsDraft(props.settings, null, props.probe),
      {
        initialProps: { settings, probe: null } as ProbeProps,
      },
    );
    act(() => result.current.test(() => "probe-1"));
    act(() => result.current.test(() => "probe-2"));
    const event: ProviderTestResultEvent = {
      type: "$provider_test_result",
      requestId: "probe-1",
      serverInstanceId: "server-1",
      providerVersion: "server-1:1",
      status: "success",
      ok: true,
      message: "verified",
      validation: "models",
      credentialSource: "saved",
      credentialVersion: "server-1:1",
      config: { baseUrl: settings.baseUrl, model: settings.model, providerDialect: "auto" },
      models: ["model-b"],
    };
    rerender({ settings, probe: event });
    expect(result.current.probeResult).toBeNull();
    rerender({ settings, probe: { ...event, requestId: "probe-2", credentialVersion: "wrong" } });
    expect(result.current.probeResult).toBeNull();
    rerender({
      settings,
      probe: {
        ...event,
        requestId: "probe-2",
        config: { baseUrl: settings.baseUrl, model: "wrong", providerDialect: "auto" },
      },
    });
    expect(result.current.probeResult).toBeNull();
    rerender({ settings, probe: { ...event, requestId: "probe-2" } });
    expect(result.current.probeResult?.validation).toBe("models");
    act(() => result.current.edit("model", "edited"));
    expect(result.current.probeResult).toBeNull();
    act(() => result.current.signOut(vi.fn()));
    rerender({ settings, probe: { ...event, requestId: "probe-2" } });
    expect(result.current.probeResult).toBeNull();
    act(() => result.current.save(() => "save-restart"));
    rerender({
      settings: { ...settings, serverInstanceId: "server-2", providerVersion: "server-2:1" },
      probe: event,
    });
    expect(result.current.saveStatus).toBe("unknown");
    expect(result.current.probeResult).toBeNull();
  });

  it("keeps pending and unknown accessible without changing the provider layout", () => {
    vi.useFakeTimers();
    render(
      <ProviderSection
        settings={settings}
        onSave={() => "save-1"}
        onTestProvider={() => "probe-1"}
        onSignOutApiKey={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "mock-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("status").textContent).toMatch(/saving/i);
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("mock-key");
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole("status").textContent).toMatch(/unknown/i);
  });

  it("does not expose credentials or probes on Web even with a provider id", () => {
    document.documentElement.dataset.runtime = "web";
    render(
      <ProviderSection
        settings={settings}
        onSave={vi.fn()}
        onTestProvider={vi.fn()}
        onSignOutApiKey={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
    expect(screen.getByText(/Configure them in Desktop or the host configuration file/)).toBeTruthy();
  });
});
