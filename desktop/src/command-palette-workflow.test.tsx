import { describe, expect, it, vi } from "vitest";
import { buildCommands } from "./CommandPalette";

function handlers(overrides: Partial<Parameters<typeof buildCommands>[0]> = {}) {
  return {
    newChat: vi.fn(),
    clearChat: vi.fn(),
    focusComposer: vi.fn(),
    openSettings: vi.fn(),
    about: vi.fn(),
    abort: vi.fn(),
    copyLast: vi.fn(),
    conversationCopy: vi.fn(),
    exportMarkdown: vi.fn(),
    pickWorkspace: vi.fn(),
    newTab: vi.fn(),
    closeTab: vi.fn(),
    busy: false,
    canCloseTab: true,
    hasMessages: false,
    ...overrides,
  };
}

describe("CommandPalette workflow commands", () => {
  it("includes workflow start commands supplied by the app", () => {
    const run = vi.fn();
    const commands = buildCommands(
      handlers({
        workflowCommands: [
          {
            id: "workflow-release-readiness-check",
            label: "Workflow: Release Readiness Check",
            hint: "Check release blockers",
            run,
          },
        ],
      }),
    );

    const command = commands.find((entry) => entry.id === "workflow-release-readiness-check");

    expect(command).toMatchObject({
      group: "action",
      label: "Workflow: Release Readiness Check",
      hint: "Check release blockers",
    });
    command?.run();
    expect(run).toHaveBeenCalledOnce();
  });
});
