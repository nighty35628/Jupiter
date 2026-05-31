// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./sidebar";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

afterEach(() => {
  cleanup();
  globalThis.localStorage?.removeItem?.("jupiter.sidebar.pinnedSessions");
  globalThis.localStorage?.removeItem?.("jupiter.sidebar.collapsedWorkspaces");
  vi.useRealTimers();
});

describe("desktop Sidebar workspace grouping", () => {
  it("does not fallback untagged sessions to the current workspace", () => {
    render(
      <Sidebar
        sessions={[
          {
            name: "subagent-sub-a-202605311200",
            messageCount: 1,
            mtime: new Date("2026-05-31T12:00:00Z").toISOString(),
            summary: "subagent scratch",
          },
        ]}
        importSources={[]}
        activeName="desktop-current"
        workspaceDir="/tmp/11"
        recentWorkspaces={["/tmp/11"]}
        onNewChat={vi.fn()}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onRefreshImportSources={vi.fn()}
        onImportDetectedSessions={vi.fn()}
        onImportSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenRules={vi.fn()}
        onOpenCommands={vi.fn()}
        onOpenAbout={vi.fn()}
      />,
    );

    const row = screen.getByTitle(/subagent scratch/);
    expect(row.getAttribute("title")).not.toContain("/tmp/11");
    expect(screen.queryByText("11")).toBeNull();
  });

  it("keeps workspace group order independent from the active workspace", () => {
    render(
      <Sidebar
        sessions={[
          {
            name: "desktop-beta",
            messageCount: 1,
            mtime: new Date("2026-05-30T12:00:00Z").toISOString(),
            summary: "Beta chat",
            workspace: "/tmp/Beta",
          },
          {
            name: "desktop-alpha",
            messageCount: 1,
            mtime: new Date("2026-05-31T12:00:00Z").toISOString(),
            summary: "Alpha chat",
            workspace: "/tmp/Alpha",
          },
        ]}
        importSources={[]}
        activeName="desktop-beta"
        workspaceDir="/tmp/Beta"
        recentWorkspaces={["/tmp/Beta", "/tmp/Alpha"]}
        onNewChat={vi.fn()}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onRefreshImportSources={vi.fn()}
        onImportDetectedSessions={vi.fn()}
        onImportSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenRules={vi.fn()}
        onOpenCommands={vi.fn()}
        onOpenAbout={vi.fn()}
      />,
    );

    const names = Array.from(document.querySelectorAll(".workspace-group-head .name")).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["Alpha", "Beta"]);
  });

  it("moves workspace groups to recent-project order from the sidebar menu", () => {
    render(
      <Sidebar
        sessions={[
          {
            name: "desktop-beta",
            messageCount: 1,
            mtime: new Date("2026-05-31T12:00:00Z").toISOString(),
            summary: "Beta chat",
            workspace: "/tmp/Beta",
          },
          {
            name: "desktop-alpha",
            messageCount: 1,
            mtime: new Date("2026-05-30T12:00:00Z").toISOString(),
            summary: "Alpha chat",
            workspace: "/tmp/Alpha",
          },
        ]}
        importSources={[]}
        activeName="desktop-beta"
        workspaceDir="/tmp/Beta"
        recentWorkspaces={["/tmp/Beta", "/tmp/Alpha"]}
        onNewChat={vi.fn()}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onRefreshImportSources={vi.fn()}
        onImportDetectedSessions={vi.fn()}
        onImportSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenRules={vi.fn()}
        onOpenCommands={vi.fn()}
        onOpenAbout={vi.fn()}
      />,
    );

    expect(screen.getByText(/Pinned|置顶|固定/)).toBeTruthy();
    expect(screen.getByText(/Projects|项目|プロジェクト/)).toBeTruthy();
    expect(screen.queryByText(/Chats|对话|チャット/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Sidebar options|侧边栏选项|サイドバーオプション/ }));
    fireEvent.click(screen.getByRole("button", { name: /Recent projects|近期项目|最近のプロジェクト/ }));

    const names = Array.from(document.querySelectorAll(".workspace-group-head .name")).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["Beta", "Alpha"]);
  });

  it("keeps relative time labels on a sidebar clock instead of click-triggered renders", () => {
    vi.useFakeTimers();
    const base = new Date("2026-05-31T12:00:00Z");
    vi.setSystemTime(base);

    render(
      <Sidebar
        sessions={[
          {
            name: "desktop-time",
            messageCount: 1,
            mtime: new Date(base.getTime() - 59_000).toISOString(),
            summary: "Time chat",
            workspace: "/tmp/Jupiter",
          },
        ]}
        importSources={[]}
        activeName="desktop-other"
        workspaceDir="/tmp/Jupiter"
        recentWorkspaces={["/tmp/Jupiter"]}
        onNewChat={vi.fn()}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onRefreshImportSources={vi.fn()}
        onImportDetectedSessions={vi.fn()}
        onImportSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenRules={vi.fn()}
        onOpenCommands={vi.fn()}
        onOpenAbout={vi.fn()}
      />,
    );

    expect(screen.getByText(/just now|刚刚|たった今|gerade eben/)).toBeTruthy();

    vi.setSystemTime(new Date(base.getTime() + 2_000));
    fireEvent.click(screen.getByRole("button", { name: /Sidebar options|侧边栏选项|サイドバーオプション/ }));
    expect(screen.getByText(/just now|刚刚|たった今|gerade eben/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.getByText(/1m ago|1 分钟前|1 分前|vor 1 Min/)).toBeTruthy();
  });

  it("collapses and expands one workspace group without loading a session", () => {
    const onLoadSession = vi.fn();
    render(
      <Sidebar
        sessions={[
          {
            name: "desktop-jupiter",
            messageCount: 1,
            mtime: new Date("2026-05-31T12:00:00Z").toISOString(),
            summary: "Jupiter chat",
            workspace: "/tmp/Jupiter",
          },
          {
            name: "desktop-alpha",
            messageCount: 1,
            mtime: new Date("2026-05-30T12:00:00Z").toISOString(),
            summary: "Alpha chat",
            workspace: "/tmp/Alpha",
          },
        ]}
        importSources={[]}
        activeName="desktop-alpha"
        workspaceDir="/tmp/Alpha"
        recentWorkspaces={["/tmp/Alpha", "/tmp/Jupiter"]}
        onNewChat={vi.fn()}
        onLoadSession={onLoadSession}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onRefreshImportSources={vi.fn()}
        onImportDetectedSessions={vi.fn()}
        onImportSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenRules={vi.fn()}
        onOpenCommands={vi.fn()}
        onOpenAbout={vi.fn()}
      />,
    );

    const jupiterGroup = screen
      .getAllByRole("button", { name: /Jupiter/ })
      .find((el) => el.classList.contains("workspace-group-head"));
    expect(jupiterGroup).toBeTruthy();
    if (!jupiterGroup) throw new Error("missing Jupiter workspace group");
    expect(jupiterGroup.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Jupiter chat")).toBeTruthy();

    fireEvent.click(jupiterGroup);

    expect(jupiterGroup.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Jupiter chat")).toBeNull();
    expect(screen.getByText("Alpha chat")).toBeTruthy();
    expect(onLoadSession).not.toHaveBeenCalled();

    fireEvent.click(jupiterGroup);

    expect(jupiterGroup.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Jupiter chat")).toBeTruthy();
  });
});
