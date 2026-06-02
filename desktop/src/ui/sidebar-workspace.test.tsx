// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./sidebar";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

afterEach(() => {
  cleanup();
  globalThis.localStorage?.removeItem?.("jupiter.sidebar.pinnedSessions");
  globalThis.localStorage?.removeItem?.("jupiter.sidebar.workspacePinnedSessions");
  globalThis.localStorage?.removeItem?.("jupiter.sidebar.pinnedWorkspaces");
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
        onOpenCommands={vi.fn()}
      />,
    );

    const row = screen.getByTitle(/subagent scratch/);
    expect(row.getAttribute("title")).not.toContain("/tmp/11");
    expect(screen.queryByText("11")).toBeNull();
  });

  it("keeps only settings in the footer", () => {
    const onOpenSettings = vi.fn();
    render(
      <Sidebar
        sessions={[]}
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
        onOpenSettings={onOpenSettings}
        onOpenCommands={vi.fn()}
      />,
    );

    expect(screen.queryByText(/Approval rules|审批规则|承認ルール|Genehmigungsregeln/)).toBeNull();
    expect(screen.queryByText(/About|关于|概要|Über/)).toBeNull();

    fireEvent.click(screen.getByText(/Settings|设置|設定|Einstellungen/));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
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
        onOpenCommands={vi.fn()}
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
        onOpenCommands={vi.fn()}
      />,
    );

    expect(screen.queryByText(/Pinned|置顶|固定/)).toBeNull();
    expect(screen.getByText(/Projects|项目|プロジェクト/)).toBeTruthy();
    expect(screen.queryByText(/Chats|对话|チャット/)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Sidebar options|侧边栏选项|サイドバーオプション/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Recent projects|近期项目|最近のプロジェクト/ }),
    );

    const names = Array.from(document.querySelectorAll(".workspace-group-head .name")).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["Beta", "Alpha"]);
  });

  it("pins a session only inside its workspace group", () => {
    render(
      <Sidebar
        sessions={[
          {
            name: "desktop-alpha-recent",
            messageCount: 1,
            mtime: new Date("2026-05-31T12:00:00Z").toISOString(),
            summary: "Alpha recent",
            workspace: "/tmp/Alpha",
          },
          {
            name: "desktop-alpha-main",
            messageCount: 1,
            mtime: new Date("2026-05-30T12:00:00Z").toISOString(),
            summary: "Alpha main",
            workspace: "/tmp/Alpha",
          },
          {
            name: "desktop-beta",
            messageCount: 1,
            mtime: new Date("2026-05-29T12:00:00Z").toISOString(),
            summary: "Beta chat",
            workspace: "/tmp/Beta",
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
        onOpenCommands={vi.fn()}
      />,
    );

    const alphaMain = screen.getByTitle(/Alpha main/);
    fireEvent.click(
      within(alphaMain).getByRole("button", {
        name: /Pin in workspace|工作区内置顶|ワークスペース内でピン留め/,
      }),
    );

    expect(screen.queryByText(/Pinned|置顶|固定/)).toBeNull();
    const alphaGroup = screen.getByText("Alpha").closest(".workspace-group");
    const betaGroup = screen.getByText("Beta").closest(".workspace-group");
    if (!alphaGroup || !betaGroup) throw new Error("missing workspace groups");

    const alphaTitles = Array.from(alphaGroup.querySelectorAll(".session-item .title")).map(
      (el) => el.textContent,
    );
    const betaTitles = Array.from(betaGroup.querySelectorAll(".session-item .title")).map(
      (el) => el.textContent,
    );
    expect(alphaTitles).toEqual(["Alpha main", "Alpha recent"]);
    expect(betaTitles).toEqual(["Beta chat"]);
  });

  it("pins a workspace group above other workspace groups", () => {
    render(
      <Sidebar
        sessions={[
          {
            name: "desktop-alpha",
            messageCount: 1,
            mtime: new Date("2026-05-31T12:00:00Z").toISOString(),
            summary: "Alpha chat",
            workspace: "/tmp/Alpha",
          },
          {
            name: "desktop-beta",
            messageCount: 1,
            mtime: new Date("2026-05-30T12:00:00Z").toISOString(),
            summary: "Beta chat",
            workspace: "/tmp/Beta",
          },
        ]}
        importSources={[]}
        activeName="desktop-alpha"
        workspaceDir="/tmp/Alpha"
        recentWorkspaces={["/tmp/Alpha", "/tmp/Beta"]}
        onNewChat={vi.fn()}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onRefreshImportSources={vi.fn()}
        onImportDetectedSessions={vi.fn()}
        onImportSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCommands={vi.fn()}
      />,
    );

    const betaGroup = screen.getByText("Beta").closest(".workspace-group");
    if (!betaGroup) throw new Error("missing Beta workspace group");
    fireEvent.click(
      within(betaGroup as HTMLElement).getByRole("button", {
        name: /Pin workspace|置顶工作区|ワークスペースをピン留め/,
      }),
    );

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
        onOpenCommands={vi.fn()}
      />,
    );

    expect(screen.getByText(/just now|刚刚|たった今|gerade eben/)).toBeTruthy();

    vi.setSystemTime(new Date(base.getTime() + 2_000));
    fireEvent.click(
      screen.getByRole("button", { name: /Sidebar options|侧边栏选项|サイドバーオプション/ }),
    );
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
        onOpenCommands={vi.fn()}
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
