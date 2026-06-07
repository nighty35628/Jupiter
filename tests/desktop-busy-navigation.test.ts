import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("desktop/src/App.tsx", "utf8");
const protocol = readFileSync("desktop/src/protocol.ts", "utf8");
const desktop = readFileSync("src/cli/commands/desktop.ts", "utf8");

describe("desktop busy navigation", () => {
  it("marks sidebar session/new-chat navigation as open-in-new-tab while current tab is busy", () => {
    expect(protocol).toContain('{ cmd: "session_load"; name: string; openInNewTab?: boolean }');
    expect(protocol).toContain(
      '{ cmd: "new_chat"; workspaceDir?: string; openInNewTab?: boolean }',
    );
    expect(app).toContain("const optimisticBusyRef = useRef(false)");
    expect(app).toContain("optimisticBusyRef.current = true");
    expect(app).toContain("() => state.busy || optimisticBusyRef.current");
    expect(app).toContain(
      "const activeBusy = Boolean(activeRuntimeSnapshot?.busy || activeTabMeta?.busy)",
    );
    expect(app).toContain('sendRpc({ cmd: "new_chat", openInNewTab: isTabBusy() })');
    expect(app).toContain("sendRpcToTab(activeTabId, {");
    expect(app).toContain('cmd: "new_chat"');
    expect(app).toContain("openInNewTab: activeBusy");
    expect(app).toContain('cmd: "session_load"');
  });

  it("routes busy session/new-chat requests to focused tabs instead of loading into the running tab", () => {
    expect(desktop).toContain('| { cmd: "session_load"; name: string; openInNewTab?: boolean }');
    expect(desktop).toContain(
      '| { cmd: "new_chat"; workspaceDir?: string; openInNewTab?: boolean }',
    );
    expect(desktop).toContain("if (msg.openInNewTab || tab.aborter)");
  });

  it("focuses an already-open session tab before loading a session snapshot", () => {
    expect(desktop).toContain("function focusExistingSessionTab");
    expect(desktop).toContain(
      "function findOpenSessionTab(session: string, workspaceDir?: string)",
    );
    expect(desktop).toContain("if (focusExistingSessionTab(msg.name, targetWorkspace)) return");
    expect(
      desktop.indexOf("if (focusExistingSessionTab(msg.name, targetWorkspace)) return"),
    ).toBeLessThan(desktop.indexOf("loadSessionIntoTab(tab, msg.name"));
  });
});
