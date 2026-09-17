// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings as SettingsType, UsageStats } from "../App";
import { setLang } from "../i18n";
import { BUILTIN_PETS } from "../pets/catalog";
import type { DesktopPetUi } from "../pets/types";
import type { MemoryEntryInfo, UsageHistoryEvent } from "../protocol";
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
  baseUrl: "https://api.deepseek.com",
  providerDialect: "auto",
  providerLabel: "DeepSeek Official",
  providerId: "deepseek-official",
  officialDeepSeek: true,
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
  contextDiagnostics: null,
};

const petUi: DesktopPetUi = {
  preferences: { enabled: false, selectedId: "builtin:companion-cube" },
  builtins: BUILTIN_PETS,
  catalog: {
    root: "/tmp/.jupiter/pets",
    customPets: [],
    errors: [],
    loading: false,
    loaded: true,
    error: null,
  },
  selectedPet: BUILTIN_PETS[0]!,
  selectedUnavailable: false,
  setEnabled: vi.fn(),
  selectPet: vi.fn(),
  refreshCustomPets: vi.fn(async () => undefined),
  openCustomPetDirectory: vi.fn(async () => undefined),
};

function renderSettings({
  settings: settingsOverride,
  onOpenAbout = vi.fn(),
  onSave = vi.fn(),
  onTestProvider = vi.fn(),
  onSignOutApiKey = vi.fn(),
  memory = [],
  onReadMemory = vi.fn(),
  onRefreshMemory = vi.fn(),
  onDeleteMemory = vi.fn(),
  onSaveMemory = vi.fn(),
  archivedSessions = [],
  onRefreshArchivedSessions = vi.fn(),
  onRestoreArchivedSession = vi.fn(),
  onDeleteArchivedSession = vi.fn(),
  onClearArchivedSessions = vi.fn(),
  initialPage,
  storageScan = null,
  onScanStorage = vi.fn(),
  onCleanStorage = vi.fn(),
  onRefreshOptionalComponents = vi.fn(),
  usage: usageOverride,
  usageHistory = null,
  petUi: petUiOverride = petUi,
  onClose = vi.fn(),
  rerenderOnPetToggle = false,
}: {
  settings?: Partial<SettingsType>;
  onOpenAbout?: () => void;
  onSave?: (...args: any[]) => void;
  onTestProvider?: (...args: any[]) => void;
  onSignOutApiKey?: () => void;
  memory?: MemoryEntryInfo[];
  onReadMemory?: (path: string) => void;
  onRefreshMemory?: () => void;
  onDeleteMemory?: (path: string) => void;
  onSaveMemory?: (...args: any[]) => void;
  archivedSessions?: any[];
  onRefreshArchivedSessions?: () => void;
  onRestoreArchivedSession?: (name: string) => void;
  onDeleteArchivedSession?: (name: string) => void;
  onClearArchivedSessions?: () => void;
  initialPage?:
    | "mcp"
    | "memory"
    | "archives"
    | "shortcuts"
    | "storage"
    | "billing"
    | "components"
    | "pets";
  storageScan?: any;
  onScanStorage?: () => void;
  onCleanStorage?: (itemIds: string[]) => void;
  onRefreshOptionalComponents?: () => void;
  usage?: UsageStats;
  usageHistory?: UsageHistoryEvent | null;
  petUi?: DesktopPetUi;
  onClose?: () => void;
  rerenderOnPetToggle?: boolean;
} = {}) {
  function TestSettingsModal() {
    const [petEnabled, setPetEnabled] = useState(petUiOverride.preferences.enabled);
    const resolvedPetUi = rerenderOnPetToggle
      ? {
          ...petUiOverride,
          preferences: { ...petUiOverride.preferences, enabled: petEnabled },
          setEnabled(enabled: boolean) {
            petUiOverride.setEnabled(enabled);
            setPetEnabled(enabled);
          },
        }
      : petUiOverride;
    const resolvedOnClose = rerenderOnPetToggle ? () => onClose() : onClose;
    return (
      <SettingsModal
        settings={{ ...settings, ...settingsOverride }}
        balance={null}
        usage={usageOverride ?? usage}
        usageHistory={usageHistory}
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
        petUi={resolvedPetUi}
        mcpSpecs={[]}
        mcpBridged={false}
        skills={[]}
        skillRoots={[]}
        memory={memory}
        memoryDetail={null}
        archivedSessions={archivedSessions}
        storageScan={storageScan}
        qq={null}
        feishu={null}
        dingtalk={null}
        initialPage={initialPage}
        onClose={resolvedOnClose}
        onSave={onSave}
        onTestProvider={onTestProvider}
        onSaveApiKey={vi.fn()}
        onSignOutApiKey={onSignOutApiKey}
        onLoadQQ={vi.fn()}
        onConnectQQ={vi.fn()}
        onDisconnectQQ={vi.fn()}
        onSaveQQConfig={vi.fn()}
        onOpenQQApplyLink={vi.fn()}
        onLoadFeishu={vi.fn()}
        onConnectFeishu={vi.fn()}
        onDisconnectFeishu={vi.fn()}
        onSaveFeishuConfig={vi.fn()}
        onOpenFeishuApplyLink={vi.fn()}
        onLoadDingTalk={vi.fn()}
        onConnectDingTalk={vi.fn()}
        onDisconnectDingTalk={vi.fn()}
        onSaveDingTalkConfig={vi.fn()}
        onOpenDingTalkApplyLink={vi.fn()}
        onPickWorkspace={vi.fn()}
        onAddMcpSpec={vi.fn()}
        onRemoveMcpSpec={vi.fn()}
        onEnableMcpSpec={vi.fn()}
        onDisableMcpSpec={vi.fn()}
        onReconnectMcpSpecs={vi.fn()}
        onRefreshOptionalComponents={onRefreshOptionalComponents}
        onAddSkillPath={vi.fn()}
        onRemoveSkillPath={vi.fn()}
        onCreateSkill={vi.fn()}
        onSetSkillModel={vi.fn()}
        onReadMemory={onReadMemory}
        onRefreshMemory={onRefreshMemory}
        onDeleteMemory={onDeleteMemory}
        onSaveMemory={onSaveMemory}
        onRefreshArchivedSessions={onRefreshArchivedSessions}
        onRestoreArchivedSession={onRestoreArchivedSession}
        onDeleteArchivedSession={onDeleteArchivedSession}
        onClearArchivedSessions={onClearArchivedSessions}
        onScanStorage={onScanStorage}
        onCleanStorage={onCleanStorage}
        onOpenAbout={onOpenAbout}
      />
    );
  }

  return render(<TestSettingsModal />);
}

describe("SettingsModal", () => {
  it("configures DeepSeek native search and explains the active credential", () => {
    const onSave = vi.fn();
    renderSettings({
      initialPage: "mcp",
      onSave,
      settings: {
        webSearchEngine: "deepseek-native",
        deepseekNativeCredentialStatus: { state: "ready_reusing_main_key" },
      },
    });

    const engineSelect = screen.getByDisplayValue(
      "DeepSeek native search (experimental) — full model-call latency and token cost",
    );
    expect(engineSelect).toBeTruthy();
    expect(screen.getByText("Ready — securely reusing the official DeepSeek key.")).toBeTruthy();

    fireEvent.change(engineSelect, { target: { value: "tavily" } });
    expect(onSave).toHaveBeenCalledWith({ webSearchEngine: "tavily" });

    fireEvent.change(engineSelect, { target: { value: "deepseek-native" } });
    const keyInput = screen.getByLabelText("DeepSeek native search API key");
    fireEvent.change(keyInput, { target: { value: "  ds-search-key  " } });
    fireEvent.click(within(keyInput.parentElement!).getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ deepseekSearchApiKey: "ds-search-key" });
  });

  it("toggles the desktop pet and selects a preset from the pets page", () => {
    const setEnabled = vi.fn();
    const selectPet = vi.fn();
    renderSettings({
      initialPage: "pets",
      petUi: { ...petUi, setEnabled, selectPet },
    });

    fireEvent.click(screen.getByRole("switch", { name: /Desktop pet/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Ink Dragon/ }));

    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(selectPet).toHaveBeenCalledWith("builtin:ink-dragon");
  });

  it("keeps keyboard focus on the pet switch when parent callbacks change", () => {
    vi.useFakeTimers();
    renderSettings({
      initialPage: "pets",
      rerenderOnPetToggle: true,
    });
    act(() => vi.runOnlyPendingTimers());
    const toggle = screen.getByRole("switch", { name: /Desktop pet/ });
    toggle.focus();

    fireEvent.click(toggle);
    act(() => vi.runOnlyPendingTimers());

    expect(document.activeElement).toBe(toggle);
  });

  it("expands custom pets and selects a validated package", () => {
    const selectPet = vi.fn();
    const customPet = {
      ...BUILTIN_PETS[0]!,
      id: "custom:paper-friend",
      packageId: "paper-friend",
      displayName: "Paper Friend",
      source: "custom" as const,
    };
    renderSettings({
      initialPage: "pets",
      petUi: {
        ...petUi,
        selectPet,
        catalog: { ...petUi.catalog, customPets: [customPet] },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /Custom|自定义/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Paper Friend" }));

    expect(selectPet).toHaveBeenCalledWith("custom:paper-friend");
  });

  it("keeps Tab inside settings when unselected custom radios follow the last action", () => {
    const offsetParent = vi
      .spyOn(HTMLElement.prototype, "offsetParent", "get")
      .mockReturnValue(document.body);
    const customPet = {
      ...BUILTIN_PETS[0]!,
      id: "custom:paper-friend",
      packageId: "paper-friend",
      displayName: "Paper Friend",
      source: "custom" as const,
    };
    renderSettings({
      initialPage: "pets",
      petUi: {
        ...petUi,
        catalog: { ...petUi.catalog, customPets: [customPet] },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /Custom|自定义/ }));
    const refresh = screen.getByRole("button", { name: /Refresh|刷新/ });
    refresh.focus();

    expect(fireEvent.keyDown(window, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(document.querySelector(".settings-side .row"));
    offsetParent.mockRestore();
  });

  it("opens About from the general settings page", () => {
    const onOpenAbout = vi.fn();
    renderSettings({ onOpenAbout });

    fireEvent.click(screen.getByRole("button", { name: /About Jupiter|关于 Jupiter/ }));

    expect(onOpenAbout).toHaveBeenCalledTimes(1);
  });

  it("clears archived conversations from the archive settings page", () => {
    const onClearArchivedSessions = vi.fn();
    renderSettings({
      initialPage: "archives",
      archivedSessions: [
        {
          name: "archived-a",
          messageCount: 1,
          mtime: new Date(1_000).toISOString(),
          archivedAt: 1_000,
          summary: "Archived A",
        },
      ],
      onClearArchivedSessions,
    });

    fireEvent.click(screen.getByRole("button", { name: /Clear archive/ }));

    expect(onClearArchivedSessions).toHaveBeenCalledTimes(1);
  });

  it("renders expanded desktop shortcut declarations from the shortcuts page", () => {
    renderSettings({ initialPage: "shortcuts" });

    expect(screen.getByText("Switch to tab 1")).toBeTruthy();
    expect(screen.getByText("Previous tab")).toBeTruthy();
    expect(screen.getByText("Stop current run")).toBeTruthy();
    expect(screen.getByText("Open Files panel")).toBeTruthy();
    expect(screen.getByText("Open Terminal panel")).toBeTruthy();
    expect(screen.getByText("Toggle bottom bar")).toBeTruthy();
    expect(screen.getByText("Keyboard shortcuts")).toBeTruthy();
  });

  it("scans and cleans selected Jupiter storage items from the storage settings page", () => {
    const onScanStorage = vi.fn();
    const onCleanStorage = vi.fn();
    renderSettings({
      initialPage: "storage",
      onScanStorage,
      onCleanStorage,
      storageScan: {
        type: "$storage_scan",
        scannedAt: 1_000,
        totalBytes: 4_500,
        safeBytes: 1_000,
        optionalBytes: 2_000,
        reviewBytes: 1_500,
        items: [
          {
            id: "safe:jupiter-cache",
            tier: "safe",
            title: "Jupiter cache",
            description: "Temporary files that can be regenerated.",
            path: "/tmp/.jupiter/cache",
            sizeBytes: 1_000,
            cleanup: "delete",
          },
          {
            id: "optional:archived-sessions",
            tier: "optional",
            title: "Archived conversations",
            description: "Archived transcripts.",
            path: "/tmp/.jupiter/sessions/archive",
            sizeBytes: 2_000,
            cleanup: "delete",
          },
          {
            id: "review:workspace-meta:abc",
            tier: "review",
            title: "Workspace metadata",
            description: "Open and review manually.",
            path: "/tmp/work/.jupiter",
            sizeBytes: 1_500,
            cleanup: "none",
          },
        ],
      },
    });

    expect(onScanStorage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Storage" })).toBeTruthy();
    expect(screen.getByText("Jupiter cache")).toBeTruthy();
    expect(screen.getByText("Archived conversations")).toBeTruthy();
    expect(screen.getByText("Workspace metadata")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /Jupiter cache/ }));
    fireEvent.click(screen.getByRole("button", { name: /Clean selected/ }));

    expect(onCleanStorage).toHaveBeenCalledWith(["safe:jupiter-cache"]);
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

    fireEvent.click(within(processGroup).getByRole("button", { name: /expanded|展开/ }));

    expect(onSave).toHaveBeenCalledWith({ processCardsDefaultOpen: true });
  });

  it("saves the AI visible content detail preference", () => {
    const onSave = vi.fn();
    renderSettings({ onSave });

    const group = screen.getByRole("group", {
      name: /AI visible content|AI 可见内容/,
    });
    expect(
      within(group)
        .getByRole("button", { name: /shown|显示/ })
        .getAttribute("data-on"),
    ).toBe("true");

    fireEvent.click(within(group).getByRole("button", { name: /hidden|隐藏/ }));

    expect(onSave).toHaveBeenCalledWith({ showAiVisibleDetails: false });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("saves the workspace library retrieval mode and warns about always-on token use", () => {
    const onSave = vi.fn();
    renderSettings({ onSave });

    const group = screen.getByRole("group", {
      name: /Workspace library retrieval|资料库检索/,
    });
    expect(
      within(group)
        .getByRole("button", { name: /on demand|按需/ })
        .getAttribute("data-on"),
    ).toBe("true");

    fireEvent.click(within(group).getByRole("button", { name: /always|始终/ }));

    expect(onSave).toHaveBeenCalledWith({ libraryRetrievalMode: "always" });
    expect(
      screen.getByText(/Always mode can increase token usage|始终模式会增加 token 使用量/),
    ).toBeTruthy();
  });

  it("signs out of the current API key from the models page", () => {
    const onSignOutApiKey = vi.fn();
    renderSettings({
      settings: { apiKeyPrefix: "sk-abc…xyz" },
      onSignOutApiKey,
    });

    fireEvent.click(screen.getByText("Models"));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(onSignOutApiKey).toHaveBeenCalledTimes(1);
  });

  it("tests and saves a provider tuple from the models page", () => {
    const onSave = vi.fn();
    const onTestProvider = vi.fn();
    renderSettings({ onSave, onTestProvider });

    fireEvent.click(screen.getByText("Models"));
    fireEvent.change(screen.getByLabelText("API protocol"), {
      target: { value: "openai-compatible" },
    });
    fireEvent.change(screen.getByLabelText("Provider base URL"), {
      target: { value: "https://relay.example/v1" },
    });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "relay-key" },
    });
    fireEvent.change(screen.getByLabelText("Custom model id"), {
      target: { value: "relay-model" },
    });

    const expected = {
      baseUrl: "https://relay.example/v1",
      apiKey: "relay-key",
      model: "relay-model",
      providerDialect: "openai-compatible",
      vision: false,
      imageTransport: "auto",
    };
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(onTestProvider).toHaveBeenCalledWith(expected);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(expected);
  });

  it("shows detected browser automation status in components", () => {
    renderSettings({
      settings: {
        browserAutomation: {
          state: "available",
          browser: "chrome",
          name: "Google Chrome",
          executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        },
      },
    });

    fireEvent.click(screen.getByText("Components"));

    expect(screen.getByText("Browser automation")).toBeTruthy();
    expect(screen.getByText("Enabled through Google Chrome.")).toBeTruthy();
    expect(screen.getByText(/Google Chrome.app/)).toBeTruthy();
  });

  it("shows browser install guidance when automation is unavailable", () => {
    renderSettings({
      settings: { browserAutomation: { state: "unavailable" } },
    });

    fireEvent.click(screen.getByText("Components"));
    fireEvent.click(screen.getByRole("button", { name: "Install Chrome" }));
    fireEvent.click(screen.getByRole("button", { name: "Install Edge" }));

    expect(screen.getByText("WebView fallback active.")).toBeTruthy();
    expect(openUrl).toHaveBeenCalledWith("https://www.google.com/chrome/");
    expect(openUrl).toHaveBeenCalledWith("https://www.microsoft.com/edge/download");
  });

  it("lists optional components and refreshes detection", () => {
    const onRefreshOptionalComponents = vi.fn();
    renderSettings({
      initialPage: "components",
      onRefreshOptionalComponents,
      settings: {
        optionalComponents: [
          {
            id: "browser-chrome",
            name: "Google Chrome",
            capability: "browser-automation",
            state: "available",
            executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            version: "126.0.0",
            recommended: true,
          },
          {
            id: "libreoffice",
            name: "LibreOffice",
            capability: "office-preview",
            state: "missing",
            homepageUrl: "https://www.libreoffice.org/download/download-libreoffice/",
            installHint: "brew install --cask libreoffice",
          },
        ],
      },
    });

    expect(onRefreshOptionalComponents).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Local components")).toBeTruthy();
    expect(screen.getByText("Google Chrome")).toBeTruthy();
    expect(screen.getAllByText("Browser automation").length).toBeGreaterThan(0);
    expect(screen.getByText("126.0.0")).toBeTruthy();
    expect(screen.getByText("LibreOffice")).toBeTruthy();
    expect(screen.getByText("brew install --cask libreoffice")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open install page" }));
    fireEvent.click(screen.getByRole("button", { name: "Detect again" }));

    expect(openUrl).toHaveBeenCalledWith(
      "https://www.libreoffice.org/download/download-libreoffice/",
    );
    expect(onRefreshOptionalComponents).toHaveBeenCalledTimes(2);
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

    expect(screen.getAllByText(/Rules and memory|记忆与规则/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Project rules|项目规则/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Long-term memory|长期记忆/).length).toBeGreaterThan(0);
    expect(screen.getByText(/takes effect in new chats|新会话生效/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Refresh memory|刷新记忆/ }));
    expect(onRefreshMemory).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen
        .getAllByRole("button", { name: /Prefer concise answers/ })
        .find((button) => !button.getAttribute("aria-label")?.startsWith("Delete"))!,
    );
    expect(onReadMemory).toHaveBeenCalledWith("/tmp/home/.jupiter/memory/global/pref_one.md");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Delete Prefer concise answers|删除 Prefer concise answers/,
      }),
    );
    expect(onDeleteMemory).toHaveBeenCalledWith("/tmp/home/.jupiter/memory/global/pref_one.md");
  });

  it("saves structured memory from the settings memory page", () => {
    const onSaveMemory = vi.fn();
    renderSettings({
      initialPage: "memory",
      onSaveMemory,
    });

    expect(screen.queryByLabelText(/Memory name|记忆名称/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /New memory|新建记忆/ }));

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
    fireEvent.click(screen.getByRole("button", { name: /Save memory|保存记忆/ }));

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

  it("shows historical token and cost usage in the billing settings page", () => {
    renderSettings({
      initialPage: "billing",
      usageHistory: {
        type: "$usage_history",
        generatedAt: Date.UTC(2026, 5, 17),
        recordCount: 2,
        months: [
          {
            month: "2026-06",
            label: "June 2026",
            start: Date.UTC(2026, 5, 1),
            end: Date.UTC(2026, 6, 1),
            total: {
              day: "2026-06",
              turns: 2,
              promptTokens: 3000,
              completionTokens: 500,
              cacheHitTokens: 2000,
              cacheMissTokens: 1000,
              costUsd: 0.42,
              claudeEquivUsd: 3,
              cacheSavingsUsd: 0.2,
            },
            days: [
              {
                day: "2026-06-17",
                turns: 2,
                promptTokens: 3000,
                completionTokens: 500,
                cacheHitTokens: 2000,
                cacheMissTokens: 1000,
                costUsd: 0.42,
                claudeEquivUsd: 3,
                cacheSavingsUsd: 0.2,
              },
            ],
          },
          {
            month: "2026-05",
            label: "May 2026",
            start: Date.UTC(2026, 4, 1),
            end: Date.UTC(2026, 5, 1),
            total: {
              day: "2026-05",
              turns: 1,
              promptTokens: 1000,
              completionTokens: 100,
              cacheHitTokens: 700,
              cacheMissTokens: 300,
              costUsd: 0.12,
              claudeEquivUsd: 1,
              cacheSavingsUsd: 0.1,
            },
            days: [],
          },
        ],
      },
      usage: {
        ...usage,
        totalPromptTokens: 15097,
        cacheHitTokens: 14000,
        cacheMissTokens: 1097,
        contextDiagnostics: {
          systemTokens: 5516,
          toolsTokens: 9479,
          logTokens: 102,
          inputTokens: 0,
          memoryTokens: 300,
          summaryTokens: 0,
          ctxMax: 1_000_000,
          toolsCount: 46,
          logMessages: 2,
          topTools: [{ name: "run_command", tokens: 430, turn: 1 }],
          lastPromptTokens: 15097,
          lastCacheHitTokens: 14000,
          lastCacheMissTokens: 1097,
          sessionCacheHitRatio: 0.927,
          totalCostUsd: 0.002,
          turns: 1,
        },
      },
    });

    expect(screen.getByText("Usage history")).toBeTruthy();
    expect(screen.getAllByText("June 2026").length).toBeGreaterThan(0);
    expect(screen.getAllByText("3,500").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$ 0.4200").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "May 2026" }));
    expect(screen.getByText("1,100")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(screen.getByText(/Weekly usage/)).toBeTruthy();
  });
});
