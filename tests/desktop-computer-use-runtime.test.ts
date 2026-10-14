import { describe, expect, it, vi } from "vitest";
import { DesktopComputerUse, isNativeAppLaunch } from "../src/desktop/computer-use.js";
import { ToolRegistry } from "../src/tools.js";

function fixture() {
  const policy = {
    enabled: true,
    surface: "desktop",
    supportsImages: true,
    permissionMode: "standard" as const,
  };
  const runtime = {
    start: vi.fn(async () => ({})),
    stop: vi.fn(async () => {}),
    driver: { running: true },
    controller: { invalidateObservation: vi.fn() },
  };
  const adapter = {
    getDesktopState: vi.fn(async () => JSON.stringify({ observationId: "observed" })),
    getScreenSize: vi.fn(async () => "{}"),
    getCursorPosition: vi.fn(async () => "{}"),
    click: vi.fn(async () => "{}"),
    move: vi.fn(async () => "{}"),
    scroll: vi.fn(async () => "{}"),
    type: vi.fn(async () => "{}"),
  };
  const computer = new DesktopComputerUse({
    owner: "test",
    workspaceDir: "/tmp",
    policy: () => policy,
    detectDriver: () => "/fake/cua-driver",
    createRuntime: () => runtime as any,
    createAdapter: () => adapter,
  });
  return { policy, runtime, adapter, computer };
}

describe("Desktop Computer Use lifecycle", () => {
  it("ignores failure publication from a previous turn after a fresh observation", async () => {
    const { adapter, computer } = fixture();
    let rejectOld!: (error: Error) => void;
    adapter.getDesktopState.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const registry = new ToolRegistry();
    computer.register(registry);
    computer.beginTurn(new AbortController().signal);
    const old = registry.dispatch("computer_use_get_desktop_state", {});
    await vi.waitFor(() => expect(adapter.getDesktopState).toHaveBeenCalledOnce());
    await computer.stop();
    const next = computer.beginTurn(new AbortController().signal);
    await registry.dispatch("computer_use_get_desktop_state", {});
    rejectOld(new Error("old connection lost"));
    await old;
    expect(computer.status().state).toBe("ready");
    expect(computer.status().permissions.screen).toBe("verified");
    await computer.endTurn(next);
  });

  it("keeps a failed cleanup referenced and refuses to replace it with a new runtime", async () => {
    const { runtime, computer } = fixture();
    const registry = new ToolRegistry();
    computer.register(registry);
    computer.beginTurn(new AbortController().signal);
    await registry.dispatch("computer_use_get_desktop_state", {});
    runtime.driver.running = false;
    runtime.stop.mockRejectedValue(new Error("exit unconfirmed"));
    await expect(computer.stop()).rejects.toThrow("exit unconfirmed");
    const next = computer.beginTurn(new AbortController().signal);
    await expect(computer.prepareNativeLaunch()).rejects.toThrow("exit unconfirmed");
    expect(runtime.start).toHaveBeenCalledOnce();
    runtime.stop.mockResolvedValue(undefined);
    await computer.endTurn(next);
  });

  it("preserves an admitted turn while policy changes invalidate its previous observation", async () => {
    const { policy, runtime, computer } = fixture();
    const registry = new ToolRegistry();
    computer.register(registry);
    const turn = computer.beginTurn(new AbortController().signal);
    await registry.dispatch("computer_use_get_desktop_state", {});
    policy.enabled = false;
    await computer.pauseForApproval();
    computer.register(registry);
    expect(registry.has("computer_use_click")).toBe(false);
    policy.enabled = true;
    computer.register(registry);
    await registry.dispatch("computer_use_get_desktop_state", {});
    expect(runtime.start).toHaveBeenCalledTimes(2);
    await computer.endTurn(turn);
  });
  it("does not infer input permission from an unverifiable click delivery", async () => {
    const { adapter, computer } = fixture();
    adapter.click.mockResolvedValue(JSON.stringify({ effect: "unverifiable" }));
    const registry = new ToolRegistry();
    computer.register(registry);
    const turn = computer.beginTurn(new AbortController().signal);
    await registry.dispatch("computer_use_get_desktop_state", {});
    await registry.dispatch("computer_use_click", { observationId: "observed", x: 1, y: 1 });
    expect(computer.status().permissions).toEqual({ screen: "verified", input: "unknown" });
    await computer.endTurn(turn);
  });
  it("recognizes actual native launch argv, not quoted text mentioning open", () => {
    expect(isNativeAppLaunch('open -a "System Settings"')).toBe(true);
    expect(isNativeAppLaunch('/usr/bin/env LANG=en_US.UTF-8 open -a "System Settings"')).toBe(true);
    expect(isNativeAppLaunch("echo done && /usr/bin/open -b com.apple.systempreferences")).toBe(
      true,
    );
    expect(isNativeAppLaunch('echo "open -a System Settings"')).toBe(false);
    expect(isNativeAppLaunch("open https://example.com")).toBe(false);
  });

  it("releases control during approval and reacquires without reusing an observation", async () => {
    const { runtime, computer } = fixture();
    const registry = new ToolRegistry();
    computer.register(registry);
    const turn = computer.beginTurn(new AbortController().signal);
    await registry.dispatch("computer_use_get_desktop_state", {});
    await computer.pauseForApproval();
    expect(runtime.stop).toHaveBeenCalledOnce();
    await computer.prepareNativeLaunch();
    expect(runtime.start).toHaveBeenCalledTimes(2);
    expect(runtime.controller.invalidateObservation).toHaveBeenCalledOnce();
    await computer.endTurn(turn);
    expect(runtime.stop).toHaveBeenCalledTimes(2);
  });

  it("does not let stale turn cleanup stop the new turn", async () => {
    const { runtime, computer } = fixture();
    const old = computer.beginTurn(new AbortController().signal);
    await computer.stop();
    const next = computer.beginTurn(new AbortController().signal);
    await computer.prepareNativeLaunch();
    await computer.endTurn(old);
    expect(runtime.stop).not.toHaveBeenCalled();
    await computer.endTurn(next);
    expect(runtime.stop).toHaveBeenCalledOnce();
  });
  it("registers tools without taking control or launching the driver", () => {
    const { runtime, computer } = fixture();
    const registry = new ToolRegistry();
    computer.register(registry);
    expect(registry.has("computer_use_get_desktop_state")).toBe(true);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(computer.status().state).toBe("idle");
  });

  it("starts on demand and releases control at the end of its own turn", async () => {
    const { runtime, adapter, computer } = fixture();
    const registry = new ToolRegistry();
    computer.register(registry);
    const turn = computer.beginTurn(new AbortController().signal);
    await registry.dispatch("computer_use_get_desktop_state", {}, { reportImage: () => {} });
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(adapter.getDesktopState).toHaveBeenCalledOnce();
    expect(computer.status().permissions.screen).toBe("verified");
    await computer.endTurn(turn);
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(computer.status().state).toBe("idle");
  });

  it("checks the global policy again on every action", async () => {
    const { policy, adapter, computer } = fixture();
    const registry = new ToolRegistry();
    computer.register(registry);
    const turn = computer.beginTurn(new AbortController().signal);
    await registry.dispatch("computer_use_get_desktop_state", {}, { reportImage: () => {} });
    policy.enabled = false;
    const result = await registry.dispatch("computer_use_click", {
      observationId: "observed",
      x: 1,
      y: 1,
    });
    expect(result).toContain("disabled");
    expect(adapter.click).not.toHaveBeenCalled();
    await computer.endTurn(turn);
  });

  it("never exposes or starts desktop control on a Web surface, even with the global switch on", async () => {
    const { policy, runtime, computer } = fixture();
    policy.surface = "web-beta";
    const registry = new ToolRegistry();
    computer.register(registry);
    expect(registry.has("computer_use_click")).toBe(false);
    expect(computer.status().state).toBe("unsupported-surface");
    expect(runtime.start).not.toHaveBeenCalled();
  });
});
