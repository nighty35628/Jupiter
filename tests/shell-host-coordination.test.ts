import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { PauseGate } from "../src/core/pause-gate.js";
import { ToolRegistry } from "../src/tools.js";
import { registerShellTools } from "../src/tools/shell.js";

describe("shell host coordination", () => {
  it.each(["run_command", "run_background"])(
    "%s never reserves desktop input for a denied command",
    async (tool) => {
      const registry = new ToolRegistry();
      const beforeExecute = vi.fn(async () => {});
      registerShellTools(registry, { rootDir: tmpdir(), beforeExecute });
      const gate = new PauseGate();
      gate.on((request) => gate.resolve(request.id, { type: "deny" }));
      const result = await registry.dispatch(
        tool,
        { command: "echo test" },
        { confirmationGate: gate },
      );
      expect(result).toContain("user denied");
      expect(beforeExecute).not.toHaveBeenCalled();
    },
  );

  it.each(["run_command", "run_background"])(
    "%s coordinates after approval and blocks execution when the desktop is busy",
    async (tool) => {
      const registry = new ToolRegistry();
      const events: string[] = [];
      registerShellTools(registry, {
        rootDir: tmpdir(),
        beforeExecute: async () => {
          events.push("reserve");
          throw new Error("Desktop is busy");
        },
      });
      const gate = new PauseGate();
      gate.on((request) => {
        events.push("approve");
        gate.resolve(request.id, { type: "run_once" });
      });
      const result = await registry.dispatch(
        tool,
        { command: "echo must-not-run" },
        { confirmationGate: gate },
      );
      expect(events).toEqual(["approve", "reserve"]);
      expect(result).toContain("Desktop is busy");
      expect(result).not.toContain("must-not-run\n");
    },
  );
});
