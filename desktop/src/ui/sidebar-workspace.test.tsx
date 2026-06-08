// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./sidebar";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const revealItemInDir = vi.fn();

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: (...args: unknown[]) => revealItemInDir(...args),
}));

afterEach(() => {
  cleanup();
  globalThis.localStorage?.removeItem?.("jupiter.sidebar.pinnedSessions");
  globalThis.localStorage?.removeItem?.("jupiter.sidebar.workspacePinnedSessions");
  globalThis.localStorage?.removeItem?.("jupiter.sidebar.pinnedWorkspaces");
  globalThis.localStorage?.removeItem?.("jupiter.sidebar.collapsedWorkspaces");
  globalThis.localStorage?.removeItem?.("jupiter.sidebar.archivedSessions");
  globalThis.localStorage?.removeItem?.("jupiter.sidebar.unreadSessions");
  revealItemInDir.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("desktop Sidebar workspace grouping", () => {
  it("opens a blank chat directly from the new chat button without showing workspace choices", () => {
    const onNewChat = vi.fn();
    render(
      <Sidebar
        sessions={[]}
        importSources={[]}
        activeName="desktop-current"
        workspaceDir="/tmp/11"
        recentWorkspaces={["/tmp/11", "/tmp/other"]}
        onNewChat={onNewChat}
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

    fireEvent.click(screen.getByRole("button", { name: /New chat|新建会话|新規チャット/ }));

    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onNewChat).toHaveBeenCalledWith();
    expect(document.querySelector(".new-chat-menu")).toBeNull();
    expect(screen.queryByText("/tmp/other")).toBeNull();
  });

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

  it("keeps sidebar sorting submenus closed until a sorting row is chosen", () => {
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
        ]}
        importSources={[]}
        activeName="desktop-beta"
        workspaceDir="/tmp/Beta"
        recentWorkspaces={["/tmp/Beta"]}
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

    fireEvent.click(
      screen.getByRole("button", { name: /Sidebar options|侧边栏选项|サイドバーオプション/ }),
    );

    expect(screen.getByRole("button", { name: /Sort by|排序方式|並び替え方式/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Workspace order|工作区排序|ワークスペース順/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /By workspace|按工作区|ワークスペース別/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Recent workspaces|按最近时间|最近順/ }),
    ).toBeNull();
  });

  it("keeps main sort mode separate from workspace group ordering", () => {
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
    fireEvent.click(screen.getByRole("button", { name: /Sort by|排序方式|並び替え方式/ }));
    fireEvent.click(screen.getByRole("button", { name: /By time|按时间|時刻順/ }));

    let titles = Array.from(document.querySelectorAll(".session-item .title")).map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(["Beta chat", "Alpha chat"]);
    expect(document.querySelectorAll(".workspace-group-head .name")).toHaveLength(0);

    fireEvent.click(
      screen.getByRole("button", { name: /Sidebar options|侧边栏选项|サイドバーオプション/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Sort by|排序方式|並び替え方式/ }));
    fireEvent.click(screen.getByRole("button", { name: /By title|按标题|タイトル順/ }));

    titles = Array.from(document.querySelectorAll(".session-item .title")).map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(["Alpha chat", "Beta chat"]);

    fireEvent.click(
      screen.getByRole("button", { name: /Sidebar options|侧边栏选项|サイドバーオプション/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Sort by|排序方式|並び替え方式/ }));
    fireEvent.click(screen.getByRole("button", { name: /By workspace|按工作区|ワークスペース別/ }));

    let names = Array.from(document.querySelectorAll(".workspace-group-head .name")).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["Alpha", "Beta"]);

    fireEvent.click(
      screen.getByRole("button", { name: /Sidebar options|侧边栏选项|サイドバーオプション/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Workspace order|工作区排序|ワークスペース順/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Recent workspaces|按最近时间|最近順/ }));

    names = Array.from(document.querySelectorAll(".workspace-group-head .name")).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["Beta", "Alpha"]);
  });

  it("opens a session context menu with per-session actions", () => {
    render(
      <Sidebar
        sessions={[
          {
            name: "desktop-alpha",
            messageCount: 1,
            mtime: new Date("2026-05-31T12:00:00Z").toISOString(),
            path: "/Users/jrc/.jupiter/sessions/desktop-alpha.jsonl",
            summary: "Alpha chat",
            workspace: "/tmp/Alpha",
          },
        ]}
        importSources={[]}
        activeName="desktop-alpha"
        workspaceDir="/tmp/Alpha"
        recentWorkspaces={["/tmp/Alpha"]}
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

    fireEvent.contextMenu(screen.getByTitle(/Alpha chat/), { clientX: 42, clientY: 64 });

    expect(
      screen.getByRole("menu", { name: /Session actions|会话操作|セッション操作/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Pin conversation|置顶会话|会話をピン留め/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Rename conversation|重命名会话|会話名を変更/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Archive conversation|归档会话|会話をアーカイブ/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Mark unread|标记为未读|未読にする/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Show in folder|在文件夹中显示|フォルダーで表示/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", {
        name: /Copy workspace path|复制工作目录|作業ディレクトリをコピー/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Copy session ID|复制会话 ID|セッション ID をコピー/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Delete conversation|删除会话|会話を削除/ }),
    ).toBeTruthy();
  });

  it("archives sessions through the backend archive command", () => {
    const onArchiveSession = vi.fn();
    const baseSession = {
      name: "desktop-alpha",
      messageCount: 1,
      mtime: new Date("2026-05-31T12:00:00Z").toISOString(),
      summary: "Alpha chat",
      workspace: "/tmp/Alpha",
    };
    render(
      <Sidebar
        sessions={[baseSession]}
        importSources={[]}
        activeName="desktop-alpha"
        workspaceDir="/tmp/Alpha"
        recentWorkspaces={["/tmp/Alpha"]}
        onNewChat={vi.fn()}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSession={onArchiveSession}
        onRefreshImportSources={vi.fn()}
        onImportDetectedSessions={vi.fn()}
        onImportSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCommands={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByTitle(/Alpha chat/), { clientX: 42, clientY: 64 });
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Archive conversation|归档会话|会話をアーカイブ/ }),
    );

    expect(onArchiveSession).toHaveBeenCalledWith("desktop-alpha");
  });

  it("exposes unread actions and unread row state", () => {
    const onMarkSessionRead = vi.fn();
    const onMarkSessionUnread = vi.fn();
    render(
      <Sidebar
        sessions={[
          {
            name: "desktop-alpha",
            messageCount: 1,
            mtime: new Date("2026-05-31T12:00:00Z").toISOString(),
            summary: "Alpha chat",
            unread: true,
            workspace: "/tmp/Alpha",
          },
        ]}
        importSources={[]}
        activeName="desktop-other"
        workspaceDir="/tmp/Alpha"
        recentWorkspaces={["/tmp/Alpha"]}
        onNewChat={vi.fn()}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onMarkSessionRead={onMarkSessionRead}
        onMarkSessionUnread={onMarkSessionUnread}
        onRefreshImportSources={vi.fn()}
        onImportDetectedSessions={vi.fn()}
        onImportSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCommands={vi.fn()}
      />,
    );

    const row = screen.getByTitle(/Alpha chat/);
    fireEvent.contextMenu(row, { clientX: 42, clientY: 64 });

    fireEvent.click(screen.getByRole("menuitem", { name: /Mark read|标记为已读|既読にする/ }));

    expect(row.closest(".session-item")?.getAttribute("data-unread")).toBe("true");
    expect(row.closest(".session-item")?.querySelector(".session-state-dot")).toBeTruthy();
    expect(onMarkSessionRead).toHaveBeenCalledWith("desktop-alpha");
    expect(onMarkSessionUnread).not.toHaveBeenCalled();
  });

  it("shows a right-edge spinner while a session is busy", () => {
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
        ]}
        sessionActivity={{ "desktop-alpha": { busy: true } }}
        importSources={[]}
        activeName="desktop-alpha"
        workspaceDir="/tmp/Alpha"
        recentWorkspaces={["/tmp/Alpha"]}
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

    const row = screen.getByTitle(/Alpha chat/).closest(".session-item");
    expect(row?.querySelector(".session-busy-spinner")).toBeTruthy();
    expect(row?.querySelector(".session-state-dot")).toBeNull();
  });

  it("marks completed busy sessions unread", () => {
    const onLoadSession = vi.fn();
    const onPatchSessionMeta = vi.fn();
    const onMarkSessionRead = vi.fn();
    const sessions = [
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
        mtime: new Date("2026-05-31T12:01:00Z").toISOString(),
        summary: "Beta chat",
        workspace: "/tmp/Beta",
      },
    ];

    const { rerender } = render(
      <Sidebar
        sessions={sessions}
        sessionActivity={{ "desktop-beta": { busy: true } }}
        importSources={[]}
        activeName="desktop-alpha"
        workspaceDir="/tmp/Alpha"
        recentWorkspaces={["/tmp/Alpha", "/tmp/Beta"]}
        onNewChat={vi.fn()}
        onLoadSession={onLoadSession}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onPatchSessionMeta={onPatchSessionMeta}
        onMarkSessionRead={onMarkSessionRead}
        onRefreshImportSources={vi.fn()}
        onImportDetectedSessions={vi.fn()}
        onImportSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCommands={vi.fn()}
      />,
    );

    rerender(
      <Sidebar
        sessions={[
          sessions[0]!,
          sessions[1]!,
        ]}
        sessionActivity={{}}
        importSources={[]}
        activeName="desktop-alpha"
        workspaceDir="/tmp/Alpha"
        recentWorkspaces={["/tmp/Alpha", "/tmp/Beta"]}
        onNewChat={vi.fn()}
        onLoadSession={onLoadSession}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onPatchSessionMeta={onPatchSessionMeta}
        onMarkSessionRead={onMarkSessionRead}
        onRefreshImportSources={vi.fn()}
        onImportDetectedSessions={vi.fn()}
        onImportSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCommands={vi.fn()}
      />,
    );

    expect(onPatchSessionMeta).toHaveBeenCalledWith("desktop-beta", {
      lastAssistantCompletedAt: expect.any(Number),
    });
    onMarkSessionRead.mockClear();

    rerender(
      <Sidebar
        sessions={[
          sessions[0]!,
          {
            ...sessions[1]!,
            unread: true,
          },
        ]}
        sessionActivity={{}}
        importSources={[]}
        activeName="desktop-alpha"
        workspaceDir="/tmp/Alpha"
        recentWorkspaces={["/tmp/Alpha", "/tmp/Beta"]}
        onNewChat={vi.fn()}
        onLoadSession={onLoadSession}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onPatchSessionMeta={onPatchSessionMeta}
        onMarkSessionRead={onMarkSessionRead}
        onRefreshImportSources={vi.fn()}
        onImportDetectedSessions={vi.fn()}
        onImportSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCommands={vi.fn()}
      />,
    );

    const betaRow = screen.getByTitle(/Beta chat/).closest(".session-item");
    expect(betaRow?.getAttribute("data-unread")).toBe("true");
    expect(betaRow?.querySelector(".session-state-dot")).toBeTruthy();

    fireEvent.click(screen.getByTitle(/Beta chat/));
    expect(onMarkSessionRead).toHaveBeenCalledWith("desktop-beta");
    expect(onLoadSession).toHaveBeenCalledWith("desktop-beta");
  });

  it("reveals and copies session context menu metadata", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <Sidebar
        sessions={[
          {
            name: "desktop-alpha",
            messageCount: 1,
            mtime: new Date("2026-05-31T12:00:00Z").toISOString(),
            path: "/Users/jrc/.jupiter/sessions/desktop-alpha.jsonl",
            summary: "Alpha chat",
            workspace: "/tmp/Alpha",
          },
        ]}
        importSources={[]}
        activeName="desktop-alpha"
        workspaceDir="/tmp/Alpha"
        recentWorkspaces={["/tmp/Alpha"]}
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

    fireEvent.contextMenu(screen.getByTitle(/Alpha chat/), { clientX: 42, clientY: 64 });
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Show in folder|在文件夹中显示|フォルダーで表示/ }),
    );
    await waitFor(() =>
      expect(revealItemInDir).toHaveBeenCalledWith(
        "/Users/jrc/.jupiter/sessions/desktop-alpha.jsonl",
      ),
    );

    fireEvent.contextMenu(screen.getByTitle(/Alpha chat/), { clientX: 42, clientY: 64 });
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: /Copy workspace path|复制工作目录|作業ディレクトリをコピー/,
      }),
    );
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("/tmp/Alpha"));

    fireEvent.contextMenu(screen.getByTitle(/Alpha chat/), { clientX: 42, clientY: 64 });
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Copy session ID|复制会话 ID|セッション ID をコピー/ }),
    );
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("desktop-alpha"));
  });

  it("uses the styled delete confirmation from the session context menu", () => {
    const onDeleteSession = vi.fn();

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
        ]}
        importSources={[]}
        activeName="desktop-alpha"
        workspaceDir="/tmp/Alpha"
        recentWorkspaces={["/tmp/Alpha"]}
        onNewChat={vi.fn()}
        onLoadSession={vi.fn()}
        onDeleteSession={onDeleteSession}
        onRenameSession={vi.fn()}
        onRefreshImportSources={vi.fn()}
        onImportDetectedSessions={vi.fn()}
        onImportSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCommands={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByTitle(/Alpha chat/), { clientX: 42, clientY: 64 });
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Delete conversation|删除会话|会話を削除/ }),
    );

    const dialog = screen.getByRole("dialog", {
      name: /Delete conversation|删除会话|会話を削除/,
    });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText("Alpha chat")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: /Delete|删除|削除/ }));
    expect(onDeleteSession).toHaveBeenCalledWith("desktop-alpha");
  });

  it("pins a session only inside its workspace group", () => {
    const onPatchSessionMeta = vi.fn();
    const sessions = [
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
    ];
    const { rerender } = render(
      <Sidebar
        sessions={sessions}
        importSources={[]}
        activeName="desktop-beta"
        workspaceDir="/tmp/Beta"
        recentWorkspaces={["/tmp/Beta", "/tmp/Alpha"]}
        onNewChat={vi.fn()}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onPatchSessionMeta={onPatchSessionMeta}
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

    expect(onPatchSessionMeta).toHaveBeenCalledWith("desktop-alpha-main", {
      pinnedAt: expect.any(Number),
    });
    rerender(
      <Sidebar
        sessions={[sessions[0]!, { ...sessions[1]!, pinnedAt: 1_000 }, sessions[2]!]}
        importSources={[]}
        activeName="desktop-beta"
        workspaceDir="/tmp/Beta"
        recentWorkspaces={["/tmp/Beta", "/tmp/Alpha"]}
        onNewChat={vi.fn()}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onPatchSessionMeta={onPatchSessionMeta}
        onRefreshImportSources={vi.fn()}
        onImportDetectedSessions={vi.fn()}
        onImportSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCommands={vi.fn()}
      />,
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

  it("reorders a workspace session immediately after pinning it", () => {
    const onPatchSessionMeta = vi.fn();
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
        ]}
        importSources={[]}
        activeName="desktop-alpha-recent"
        workspaceDir="/tmp/Alpha"
        recentWorkspaces={["/tmp/Alpha"]}
        onNewChat={vi.fn()}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onPatchSessionMeta={onPatchSessionMeta}
        onRefreshImportSources={vi.fn()}
        onImportDetectedSessions={vi.fn()}
        onImportSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenCommands={vi.fn()}
      />,
    );

    const alphaGroup = screen.getByText("Alpha").closest(".workspace-group");
    if (!alphaGroup) throw new Error("missing workspace group");
    expect(
      Array.from(alphaGroup.querySelectorAll(".session-item .title")).map((el) => el.textContent),
    ).toEqual(["Alpha recent", "Alpha main"]);

    fireEvent.click(
      within(screen.getByTitle(/Alpha main/)).getByRole("button", {
        name: /Pin in workspace|工作区内置顶|ワークスペース内でピン留め/,
      }),
    );

    expect(onPatchSessionMeta).toHaveBeenCalledWith("desktop-alpha-main", {
      pinnedAt: expect.any(Number),
    });
    expect(
      Array.from(alphaGroup.querySelectorAll(".session-item .title")).map((el) => el.textContent),
    ).toEqual(["Alpha main", "Alpha recent"]);
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
        name: /Workspace actions|工作区操作|ワークスペース操作/,
      }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: /Pin workspace|置顶工作区|ワークスペースをピン留め/,
      }),
    );

    const names = Array.from(document.querySelectorAll(".workspace-group-head .name")).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["Beta", "Alpha"]);
  });

  it("archives workspace chats and opens archived settings from the workspace menu", () => {
    const onArchiveSessions = vi.fn();
    const onOpenSettingsPage = vi.fn();
    render(
      <Sidebar
        sessions={[
          {
            name: "desktop-alpha-1",
            messageCount: 1,
            mtime: new Date("2026-05-31T12:00:00Z").toISOString(),
            summary: "Alpha one",
            workspace: "/tmp/Alpha",
          },
          {
            name: "desktop-alpha-2",
            messageCount: 1,
            mtime: new Date("2026-05-30T12:00:00Z").toISOString(),
            summary: "Alpha two",
            workspace: "/tmp/Alpha",
          },
        ]}
        importSources={[]}
        activeName="desktop-alpha-1"
        workspaceDir="/tmp/Alpha"
        recentWorkspaces={["/tmp/Alpha"]}
        onNewChat={vi.fn()}
        onLoadSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSessions={onArchiveSessions}
        onRefreshImportSources={vi.fn()}
        onImportDetectedSessions={vi.fn()}
        onImportSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenSettingsPage={onOpenSettingsPage}
        onOpenCommands={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Workspace actions|工作区操作/ }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: /Archive workspace chats|归档工作区对话|ワークスペースの会話をアーカイブ/,
      }),
    );
    expect(onArchiveSessions).toHaveBeenCalledWith(["desktop-alpha-1", "desktop-alpha-2"]);

    fireEvent.click(screen.getByRole("button", { name: /Workspace actions|工作区操作/ }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: /View archived chats|查看已归档|アーカイブ済みを表示/,
      }),
    );
    expect(onOpenSettingsPage).toHaveBeenCalledWith("archives");
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
