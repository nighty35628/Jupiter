import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

describe("Android private host and ordinary Web separation", { retry: 0 }, () => {
  it("allows first-key setup only in a trusted local host", async () => {
    vi.resetModules();
    const { authorizeDesktopCommand } = await import("../src/web/policy.js");
    const { initializeAndroidRuntimeContext } = await import("../src/mobile/runtime-context.js");
    const workspaces = {} as import("../src/web/workspaces.js").WorkspaceRegistry;
    const input = { cmd: "setup_save_key", key: "synthetic-private-mobile-key" };
    await expect(authorizeDesktopCommand(input, { mode: "local", workspaces })).rejects.toThrow();
    initializeAndroidRuntimeContext({
      role: "host",
      runId: randomUUID(),
      configPath: "/private/test/config.json",
      dek: new Uint8Array(32),
    });
    await expect(
      authorizeDesktopCommand(input, { mode: "local", workspaces }),
    ).resolves.toMatchObject({ command: input });
    for (const mode of ["lan", "public"] as const) {
      await expect(
        authorizeDesktopCommand(input, { mode, workspaces, highRiskEnabled: true }),
      ).rejects.toThrow();
    }
  });
  it("does not mistake an interactive or scheduled child for the HTTP host", async () => {
    for (const role of ["interactive", "scheduled"] as const) {
      vi.resetModules();
      const { authorizeDesktopCommand } = await import("../src/web/policy.js");
      const { initializeAndroidRuntimeContext } = await import("../src/mobile/runtime-context.js");
      initializeAndroidRuntimeContext({
        role,
        runId: randomUUID(),
        configPath: "/private/test/config.json",
        dek: new Uint8Array(32),
      });
      const workspaces = {} as import("../src/web/workspaces.js").WorkspaceRegistry;
      await expect(
        authorizeDesktopCommand(
          { cmd: "setup_save_key", key: "synthetic-private-mobile-key" },
          { mode: "local", workspaces },
        ),
      ).rejects.toThrow();
    }
  });
  it("switches Android projects only through registered workspace identities", async () => {
    vi.resetModules();
    const { authorizeDesktopCommand } = await import("../src/web/policy.js");
    const { initializeAndroidRuntimeContext } = await import("../src/mobile/runtime-context.js");
    initializeAndroidRuntimeContext({
      role: "host",
      runId: randomUUID(),
      configPath: "/private/test/config.json",
      dek: new Uint8Array(32),
    });
    const workspaces = {
      rootFor: (id: string) => {
        if (id !== "authorized-project") throw new Error("Unknown workspace");
        return "/workspaces/registered";
      },
      idForExactRoot: async (path: string) =>
        path === "/workspaces/registered" ? "authorized-project" : undefined,
    } as unknown as import("../src/web/workspaces.js").WorkspaceRegistry;
    await expect(
      authorizeDesktopCommand(
        { cmd: "settings_save", workspaceId: "authorized-project" },
        { mode: "local", workspaces },
      ),
    ).resolves.toMatchObject({
      command: { cmd: "settings_save", workspaceDir: "/workspaces/registered" },
    });
    await expect(
      authorizeDesktopCommand(
        { cmd: "settings_save", workspaceId: "not-registered" },
        { mode: "local", workspaces },
      ),
    ).rejects.toThrow();
    await expect(
      authorizeDesktopCommand(
        { cmd: "settings_save", workspaceDir: "/private/elsewhere" },
        { mode: "local", workspaces },
      ),
    ).rejects.toThrow();
    for (const mode of ["lan", "public"] as const) {
      const result = await authorizeDesktopCommand(
        { cmd: "settings_save", workspaceDir: "/workspaces/registered" },
        { mode, workspaces },
      );
      expect(result.command).not.toHaveProperty("workspaceDir");
    }
  });
});
