import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { attachments } from "../src/attachments/store.js";

vi.mock("../src/attachments/store.js", () => ({
  attachments: {
    importBytes: vi.fn(async () => ({ kind: "image", id: "test-image", width: 1000, height: 600 })),
    requestImage: vi.fn(async () => ({ width: 500, height: 300 })),
  },
}));
import { ComputerUseController } from "../src/computer-use/controller.js";
import { ComputerUseLease } from "../src/computer-use/lease.js";
import {
  ComputerUseToolAdapter,
  registerComputerUseTools,
} from "../src/computer-use/tool-adapter.js";
import type { McpClient } from "../src/mcp/client.js";
import type { CallToolResult } from "../src/mcp/types.js";
import { ToolRegistry } from "../src/tools.js";

function result(structuredContent: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }],
    structuredContent,
    isError,
  };
}

describe("Computer Use tool adapter", () => {
  it("marks a late action response after stop as unknown and never replays it", async () => {
    const root = await mkdtemp(join(tmpdir(), "jupiter-cua-late-"));
    const controller = new ComputerUseController(
      new ComputerUseLease({ path: join(root, "lock") }),
    );
    await controller.start("test");
    const callTool = vi.fn(async () => {
      await controller.stop();
      return result({ effect: "confirmed" });
    });
    const adapter = new ComputerUseToolAdapter({ callTool } as unknown as McpClient, controller);
    const observation = controller.recordObservation({
      capturedAt: Date.now(),
      imageWidth: 100,
      imageHeight: 100,
      screen: { left: 0, top: 0, width: 100, height: 100 },
    });
    try {
      expect(
        JSON.parse(await adapter.type({ observationId: observation.id, text: "test" })),
      ).toMatchObject({ executionOutcome: "unknown_after_cancel", recovery: "unknown" });
      expect(callTool).toHaveBeenCalledOnce();
    } finally {
      await controller.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows long text when the current permission getter is unrestricted", async () => {
    const root = await mkdtemp(join(tmpdir(), "jupiter-cua-unrestricted-"));
    const controller = new ComputerUseController(
      new ComputerUseLease({ path: join(root, "lock") }),
    );
    await controller.start("test");
    const callTool = vi.fn(async () => result({ effect: "confirmed" }));
    const adapter = new ComputerUseToolAdapter(
      { callTool } as unknown as McpClient,
      controller,
      () => "unrestricted",
    );
    try {
      const observation = controller.recordObservation({
        capturedAt: Date.now(),
        imageWidth: 100,
        imageHeight: 100,
        screen: { left: 0, top: 0, width: 100, height: 100 },
      });
      await adapter.type({ observationId: observation.id, text: "a".repeat(2001) });
      expect(callTool).toHaveBeenCalledOnce();
    } finally {
      await controller.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rechecks policy immediately before driver calls and screenshot publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "jupiter-cua-policy-"));
    const controller = new ComputerUseController(
      new ComputerUseLease({ path: join(root, "lock") }),
    );
    const callTool = vi.fn(async () =>
      result({
        screenshot_width: 1000,
        screenshot_height: 600,
        screen_width: 500,
        screen_height: 300,
      }),
    );
    let allowed = true;
    const policy = vi.fn(() => {
      if (!allowed) throw new Error("policy disabled");
    });
    await controller.start("test");
    const adapter = new ComputerUseToolAdapter(
      { callTool } as unknown as McpClient,
      controller,
      "standard",
      policy,
    );
    try {
      allowed = false;
      await expect(adapter.getScreenSize()).rejects.toThrow("policy disabled");
      await expect(adapter.getCursorPosition()).rejects.toThrow("policy disabled");
      await expect(adapter.getDesktopState(undefined, vi.fn())).rejects.toThrow("policy disabled");
      expect(callTool).not.toHaveBeenCalled();
      allowed = true;
      vi.mocked(attachments.requestImage).mockImplementationOnce(async () => {
        allowed = false;
        return { width: 500, height: 300 } as Awaited<ReturnType<typeof attachments.requestImage>>;
      });
      const report = vi.fn();
      await expect(adapter.getDesktopState(undefined, report)).rejects.toThrow("policy disabled");
      expect(report).not.toHaveBeenCalled();
      allowed = true;
      const snapshot = controller.recordObservation({
        capturedAt: Date.now(),
        imageWidth: 100,
        imageHeight: 100,
        screen: { left: 0, top: 0, width: 100, height: 100 },
      });
      vi.spyOn(controller, "renew").mockImplementationOnce(async () => {
        allowed = false;
      });
      await expect(adapter.click({ observationId: snapshot.id, x: 1, y: 1 })).rejects.toThrow(
        "policy disabled",
      );
      expect(callTool).toHaveBeenCalledTimes(1);
    } finally {
      await controller.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the latest permission getter after the final policy check", async () => {
    const root = await mkdtemp(join(tmpdir(), "jupiter-cua-mode-"));
    const controller = new ComputerUseController(
      new ComputerUseLease({ path: join(root, "lock") }),
    );
    const callTool = vi.fn(async () => result({ effect: "confirmed" }));
    let mode: "standard" | "unrestricted" = "unrestricted";
    const adapter = new ComputerUseToolAdapter(
      { callTool } as unknown as McpClient,
      controller,
      () => mode,
      () => {
        mode = "standard";
      },
    );
    await controller.start("test");
    try {
      const snapshot = controller.recordObservation({
        capturedAt: Date.now(),
        imageWidth: 100,
        imageHeight: 100,
        screen: { left: 0, top: 0, width: 100, height: 100 },
      });
      await expect(
        adapter.type({ observationId: snapshot.id, text: "a".repeat(2001) }),
      ).rejects.toThrow("2000");
      expect(callTool).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects metadata calls after stop without sending to the driver", async () => {
    const root = await mkdtemp(join(tmpdir(), "jupiter-cua-read-"));
    const controller = new ComputerUseController(
      new ComputerUseLease({ path: join(root, "lock") }),
    );
    const callTool = vi.fn();
    const adapter = new ComputerUseToolAdapter({ callTool } as unknown as McpClient, controller);
    await controller.start("test");
    await controller.stop();
    try {
      await expect(adapter.getScreenSize()).rejects.toThrow("not active");
      await expect(adapter.getCursorPosition()).rejects.toThrow("not active");
      expect(callTool).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("creates an observation fence and maps actions into the driver's desktop target", async () => {
    const root = await mkdtemp(join(tmpdir(), "jupiter-cua-adapter-"));
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      callTool: async (name: string, args: Record<string, unknown> = {}) => {
        calls.push({ name, args });
        if (name === "get_desktop_state") {
          return result({
            platform: "macos",
            display: "primary",
            screenshot_width: 1000,
            screenshot_height: 600,
            screen_width: 500,
            screen_height: 300,
            scale_factor: 2,
            screenshot_mime_type: "image/png",
          });
        }
        return result({ effect: "confirmed", route: "synthetic_events" });
      },
    } as unknown as McpClient;
    const controller = new ComputerUseController(
      new ComputerUseLease({ path: join(root, "lock") }),
    );
    await controller.start("test");
    try {
      const adapter = new ComputerUseToolAdapter(client, controller);
      const reportImage = vi.fn();
      const snapshot = JSON.parse(await adapter.getDesktopState(undefined, reportImage));
      expect(reportImage).toHaveBeenCalledWith(expect.objectContaining({ id: "test-image" }));
      expect(snapshot.observation).toMatchObject({ imageWidth: 500, imageHeight: 300 });
      await adapter.click({ observationId: snapshot.observationId, x: 100, y: 50 });
      expect(calls[1]).toMatchObject({
        name: "click",
        args: {
          x: 200,
          y: 100,
          target: { kind: "desktop", display_id: "primary" },
        },
      });
      expect(calls[1]?.args).not.toHaveProperty("scope");
      await expect(
        adapter.click({ observationId: snapshot.observationId, x: 100, y: 50 }),
      ).rejects.toThrow("old screen observation");
      const next = JSON.parse(await adapter.getDesktopState(undefined, reportImage));
      await adapter.scroll({
        observationId: next.observationId,
        x: 50,
        y: 50,
        direction: "down",
        amount: 4,
      });
      expect(calls.at(-1)).toMatchObject({
        name: "scroll",
        args: { direction: "down", amount: 4, x: 100, y: 100 },
      });
      expect(calls.at(-1)?.args).not.toHaveProperty("delta_y");
      await expect(
        adapter.scroll({
          observationId: next.observationId,
          x: 50,
          y: 50,
          direction: "down",
          amount: 51,
        }),
      ).rejects.toThrow("1-50");
      const before = calls.length;
      await expect(adapter.getDesktopState()).rejects.toThrow("vision model");
      expect(calls).toHaveLength(before);
      const abort = new AbortController();
      abort.abort();
      await expect(
        adapter.type({ observationId: next.observationId, text: "test" }, abort.signal),
      ).rejects.toThrow();
      expect(calls).toHaveLength(before);
    } finally {
      await controller.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an observation after a newer snapshot replaces it", async () => {
    const root = await mkdtemp(join(tmpdir(), "jupiter-cua-adapter-"));
    const client = {
      callTool: async () =>
        result({
          platform: "macos",
          display: "primary",
          screenshot_width: 100,
          screenshot_height: 100,
          screen_width: 100,
          screen_height: 100,
          scale_factor: 1,
          screenshot_mime_type: "image/png",
        }),
    } as unknown as McpClient;
    const controller = new ComputerUseController(
      new ComputerUseLease({ path: join(root, "lock") }),
    );
    await controller.start("test");
    try {
      const adapter = new ComputerUseToolAdapter(client, controller);
      const old = JSON.parse(await adapter.getDesktopState(undefined, vi.fn()))
        .observationId as string;
      await adapter.getDesktopState(undefined, vi.fn());
      await expect(adapter.click({ observationId: old, x: 1, y: 1 })).rejects.toThrow(
        "old screen observation",
      );
    } finally {
      await controller.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not publish an observation when stopped during screenshot processing", async () => {
    const root = await mkdtemp(join(tmpdir(), "jupiter-cua-adapter-"));
    const controller = new ComputerUseController(
      new ComputerUseLease({ path: join(root, "lock") }),
    );
    await controller.start("test");
    const client = {
      callTool: async () =>
        result({
          screenshot_width: 1000,
          screenshot_height: 600,
          screen_width: 500,
          screen_height: 300,
        }),
    } as unknown as McpClient;
    vi.mocked(attachments.requestImage).mockImplementationOnce(async () => {
      await controller.stop();
      return { width: 500, height: 300 } as Awaited<ReturnType<typeof attachments.requestImage>>;
    });
    const report = vi.fn();
    try {
      await expect(
        new ComputerUseToolAdapter(client, controller).getDesktopState(undefined, report),
      ).rejects.toThrow("stopped or handed off");
      expect(report).not.toHaveBeenCalled();
    } finally {
      await controller.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("registers only the guarded Computer Use surface", () => {
    const registry = new ToolRegistry();
    const adapter = {} as ComputerUseToolAdapter;
    registerComputerUseTools(registry, adapter);
    expect(
      registry
        .specs()
        .map((spec) => spec.function.name)
        .sort(),
    ).toEqual([
      "computer_use_click",
      "computer_use_get_cursor_position",
      "computer_use_get_desktop_state",
      "computer_use_get_screen_size",
      "computer_use_move",
      "computer_use_scroll",
      "computer_use_type",
    ]);
    expect(registry.has("launch_app")).toBe(false);
    expect(registry.has("browser_navigate")).toBe(false);
  });

  it("marks a transport failure as uncertain and prevents replaying the same observation", async () => {
    const root = await mkdtemp(join(tmpdir(), "jupiter-cua-adapter-"));
    const controller = new ComputerUseController(
      new ComputerUseLease({ path: join(root, "lock") }),
    );
    const callTool = vi.fn(async (_name, _args, options) => {
      options?.onSending?.();
      throw new Error("transport closed");
    });
    await controller.start("test");
    const snapshot = controller.recordObservation({
      capturedAt: Date.now(),
      imageWidth: 100,
      imageHeight: 100,
      screen: { left: 0, top: 0, width: 100, height: 100 },
    });
    const adapter = new ComputerUseToolAdapter({ callTool } as unknown as McpClient, controller);
    try {
      const args = { observationId: snapshot.id, text: "test" };
      expect(JSON.parse(await adapter.type(args))).toMatchObject({
        executionOutcome: "unknown_after_transport",
        retry: "manual_recovery_required_before_repeating",
        manualRecoveryRequired: true,
      });
      await expect(adapter.type(args)).rejects.toThrow("manual recovery");
      expect(callTool).toHaveBeenCalledTimes(1);
    } finally {
      await controller.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
