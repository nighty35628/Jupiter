// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings as SettingsType, UsageStats } from "../App";
import { setLang } from "../i18n";
import type { MemoryEntryInfo } from "../protocol";
import { SettingsModal } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  setLang("en");
});

const settings: SettingsType = {
  reasoningEffort: "high",
  editMode: "review",
  budgetUsd: null,
  workspaceDir: "/tmp/Jupiter",
  recentWorkspaces: ["/tmp/Jupiter"],
  model: "deepseek-v4-flash",
  memoryConfirmWrites: false,
  memoryGlobalEnabled: true,
  version: "0.0.0-test",
};

const usage: UsageStats = {
  totalCostUsd: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  lastCallCacheHit: null,
  lastCallCacheMiss: null,
  reservedTokens: 0,
  liveLogTokens: 0,
};

function renderSettings({
  onOpenAbout = vi.fn(),
  onSave = vi.fn(),
  memory = [],
  onReadMemory = vi.fn(),
  onRefreshMemory = vi.fn(),
  onDeleteMemory = vi.fn(),
  onSaveMemory = vi.fn(),
  initialPage,
}: {
  onOpenAbout?: () => void;
  onSave?: (...args: any[]) => void;
  memory?: MemoryEntryInfo[];
  onReadMemory?: (path: string) => void;
  onRefreshMemory?: () => void;
  onDeleteMemory?: (path: string) => void;
  onSaveMemory?: (...args: any[]) => void;
  initialPage?: "memory";
} = {}) {
  render(
    <SettingsModal
      settings={settings}
      balance={null}
      usage={usage}
      currency="USD"
      theme="dark"
      themeStyle="graphite"
      onSetTheme={vi.fn()}
      onSetThemeStyle={vi.fn()}
      fontScale="medium"
      onSetFontScale={vi.fn()}
      fontFamily="sans"
      onSetFontFamily={vi.fn()}
      customFontFamily=""
      onSetCustomFontFamily={vi.fn()}
      mcpSpecs={[]}
      mcpBridged={false}
      skills={[]}
      skillRoots={[]}
      memory={memory}
      memoryDetail={null}
      qq={null}
      initialPage={initialPage}
      onClose={vi.fn()}
      onSave={onSave}
      onSaveApiKey={vi.fn()}
      onLoadQQ={vi.fn()}
      onConnectQQ={vi.fn()}
      onDisconnectQQ={vi.fn()}
      onSaveQQConfig={vi.fn()}
      onOpenQQApplyLink={vi.fn()}
      onPickWorkspace={vi.fn()}
      onAddMcpSpec={vi.fn()}
      onRemoveMcpSpec={vi.fn()}
      onEnableMcpSpec={vi.fn()}
      onDisableMcpSpec={vi.fn()}
      onReconnectMcpSpecs={vi.fn()}
      onAddSkillPath={vi.fn()}
      onRemoveSkillPath={vi.fn()}
      onCreateSkill={vi.fn()}
      onSetSkillModel={vi.fn()}
      onReadMemory={onReadMemory}
      onRefreshMemory={onRefreshMemory}
      onDeleteMemory={onDeleteMemory}
      onSaveMemory={onSaveMemory}
      onOpenAbout={onOpenAbout}
    />,
  );
}

describe("SettingsModal", () => {
  it("opens About from the general settings page", () => {
    const onOpenAbout = vi.fn();
    renderSettings({ onOpenAbout });

    fireEvent.click(
      screen.getByRole("button", { name: /About Jupiter|关于 Jupiter/ }),
    );

    expect(onOpenAbout).toHaveBeenCalledTimes(1);
  });

  it("shows the settings body scrollbar only while the user is scrolling", () => {
    vi.useFakeTimers();
    renderSettings();

    const body = document.querySelector(".settings-body");
    if (!(body instanceof HTMLElement)) throw new Error("missing settings body");

    expect(body.getAttribute("data-scrolling")).toBeNull();
    fireEvent.scroll(body);
    expect(body.getAttribute("data-scrolling")).toBe("true");

    act(() => {
      vi.advanceTimersByTime(900);
    });

    expect(body.getAttribute("data-scrolling")).toBeNull();
  });

  it("saves the default process-card expansion setting", () => {
    const onSave = vi.fn();
    renderSettings({ onSave });

    const processGroup = screen.getByRole("group", {
      name: /Process details|过程细节/,
    });
    expect(
      within(processGroup)
        .getByRole("button", { name: /collapsed|收起/ })
        .getAttribute("data-on"),
    ).toBe("true");

    fireEvent.click(
      within(processGroup).getByRole("button", { name: /expanded|展开/ }),
    );

    expect(onSave).toHaveBeenCalledWith({ processCardsDefaultOpen: true });
  });

  it("saves the model memory confirmation setting", () => {
    const onSave = vi.fn();
    renderSettings({ initialPage: "memory", onSave });

    fireEvent.click(
      within(
        screen.getByRole("group", {
          name: /Ask before saving model memory|保存模型记忆前询问/,
        }),
      ).getByRole("button", { name: /enabled|开启/ }),
    );

    expect(onSave).toHaveBeenCalledWith({ memoryConfirmWrites: true });
  });

  it("saves the cross-chat global memory setting", () => {
    const onSave = vi.fn();
    renderSettings({ initialPage: "memory", onSave });

    fireEvent.click(
      within(
        screen.getByRole("group", {
          name: /Cross-chat global memory|跨对话全局记忆/,
        }),
      ).getByRole("button", { name: /disabled|关闭/ }),
    );

    expect(onSave).toHaveBeenCalledWith({ memoryGlobalEnabled: false });
  });

  it("manages rules and memory from the settings memory page", () => {
    const onReadMemory = vi.fn();
    const onRefreshMemory = vi.fn();
    const onDeleteMemory = vi.fn();
    renderSettings({
      initialPage: "memory",
      onReadMemory,
      onRefreshMemory,
      onDeleteMemory,
      memory: [
        {
          kind: "project_file",
          scope: "project",
          name: "JUPITER.md",
          path: "/tmp/Jupiter/JUPITER.md",
          description: "Project rules",
          type: "freeform",
        },
        {
          kind: "structured",
          scope: "global",
          name: "pref_one",
          path: "/tmp/home/.jupiter/memory/global/pref_one.md",
          description: "Prefer concise answers",
          type: "user",
        },
      ],
    });

    expect(
      screen.getAllByText(/Rules and memory|记忆与规则/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Project rules|项目规则/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Long-term memory|长期记忆/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText(/takes effect in new chats|新会话生效/),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Refresh memory|刷新记忆/ }),
    );
    expect(onRefreshMemory).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen
        .getAllByRole("button", { name: /Prefer concise answers/ })
        .find(
          (button) => !button.getAttribute("aria-label")?.startsWith("Delete"),
        )!,
    );
    expect(onReadMemory).toHaveBeenCalledWith(
      "/tmp/home/.jupiter/memory/global/pref_one.md",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Delete Prefer concise answers|删除 Prefer concise answers/,
      }),
    );
    expect(onDeleteMemory).toHaveBeenCalledWith(
      "/tmp/home/.jupiter/memory/global/pref_one.md",
    );
  });

  it("saves structured memory from the settings memory page", () => {
    const onSaveMemory = vi.fn();
    renderSettings({
      initialPage: "memory",
      onSaveMemory,
    });

    expect(screen.queryByLabelText(/Memory name|记忆名称/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /New memory|新建记忆/ }),
    );

    const editor = screen.getByRole("dialog", {
      name: /Structured memory editor|结构化记忆编辑器/,
    });
    expect(editor.querySelector(".memory-form-stack")).toBeTruthy();
    expect(editor.querySelector(".memory-form-grid")).toBeNull();

    fireEvent.change(screen.getByLabelText(/Memory name|记忆名称/), {
      target: { value: "response_style" },
    });
    fireEvent.change(screen.getByLabelText(/Description|描述/), {
      target: { value: "Prefer compact release notes" },
    });
    fireEvent.change(screen.getByLabelText(/Memory body|记忆内容/), {
      target: {
        value: "Keep release notes concise and grouped by visible change.",
      },
    });
    fireEvent.change(screen.getByLabelText(/Scope|范围/), {
      target: { value: "project" },
    });
    fireEvent.change(screen.getByLabelText(/Priority|优先级/), {
      target: { value: "high" },
    });
    fireEvent.change(screen.getByLabelText(/Expiry|过期/), {
      target: { value: "project_end" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Save memory|保存记忆/ }),
    );

    expect(onSaveMemory).toHaveBeenCalledWith({
      name: "response_style",
      scope: "project",
      type: "user",
      description: "Prefer compact release notes",
      body: "Keep release notes concise and grouped by visible change.",
      priority: "high",
      expires: "project_end",
    });
  });
});
