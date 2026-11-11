// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ComponentProps, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeWebSurface,
  surfaceCapabilities,
} from "../dashboard/src/lib/surface-capabilities";
import { setLang, t } from "../desktop/src/i18n";
import { BUILTIN_PETS } from "../desktop/src/pets/catalog";
import { ProviderSection, SettingsModal } from "../desktop/src/ui/settings";

type SettingsProps = ComponentProps<typeof SettingsModal>;
const settings: SettingsProps["settings"] = {
  reasoningEffort: "high",
  editMode: "review",
  budgetUsd: null,
  workspaceDir: "/tmp/android-ui-test",
  recentWorkspaces: [],
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

function renderSettings(overrides: Partial<SettingsProps> = {}) {
  const props: SettingsProps = {
    settings,
    balance: null,
    usageHistory: null,
    currency: "USD",
    usage: {
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
    },
    theme: "dark",
    themeStyle: "graphite",
    fontScale: "medium",
    fontFamily: "sans",
    customFontFamily: "",
    onSetTheme: vi.fn(),
    onSetThemeStyle: vi.fn(),
    onSetFontScale: vi.fn(),
    onSetFontFamily: vi.fn(),
    onSetCustomFontFamily: vi.fn(),
    petUi: {
      preferences: { enabled: false, selectedId: "builtin:companion-cube" },
      builtins: BUILTIN_PETS,
      selectedPet: BUILTIN_PETS[0]!,
      selectedUnavailable: false,
      catalog: {
        root: "/tmp/android-ui-test/pets",
        customPets: [],
        errors: [],
        loading: false,
        loaded: true,
        error: null,
      },
      setEnabled: vi.fn(),
      selectPet: vi.fn(),
      refreshCustomPets: vi.fn(async () => undefined),
      openCustomPetDirectory: vi.fn(async () => undefined),
    },
    mcpSpecs: [],
    mcpBridged: false,
    skills: [],
    skillRoots: [],
    memory: [],
    memoryDetail: null,
    archivedSessions: [],
    storageScan: null,
    qq: null,
    feishu: null,
    dingtalk: null,
    onClose: vi.fn(),
    onSave: vi.fn(),
    onTestProvider: vi.fn(),
    onSignOutApiKey: vi.fn(),
    onLoadQQ: vi.fn(),
    onConnectQQ: vi.fn(),
    onDisconnectQQ: vi.fn(),
    onSaveQQConfig: vi.fn(),
    onOpenQQApplyLink: vi.fn(),
    onLoadFeishu: vi.fn(),
    onConnectFeishu: vi.fn(),
    onDisconnectFeishu: vi.fn(),
    onSaveFeishuConfig: vi.fn(),
    onOpenFeishuApplyLink: vi.fn(),
    onLoadDingTalk: vi.fn(),
    onConnectDingTalk: vi.fn(),
    onDisconnectDingTalk: vi.fn(),
    onSaveDingTalkConfig: vi.fn(),
    onOpenDingTalkApplyLink: vi.fn(),
    onPickWorkspace: vi.fn(),
    onAddMcpSpec: vi.fn(),
    onRemoveMcpSpec: vi.fn(),
    onEnableMcpSpec: vi.fn(),
    onDisableMcpSpec: vi.fn(),
    onReconnectMcpSpecs: vi.fn(),
    onRefreshOptionalComponents: vi.fn(),
    onAddSkillPath: vi.fn(),
    onRemoveSkillPath: vi.fn(),
    onCreateSkill: vi.fn(),
    onSetSkillModel: vi.fn(),
    onReadMemory: vi.fn(),
    onRefreshMemory: vi.fn(),
    onDeleteMemory: vi.fn(),
    onSaveMemory: vi.fn(),
    onRefreshArchivedSessions: vi.fn(),
    onRestoreArchivedSession: vi.fn(),
    onDeleteArchivedSession: vi.fn(),
    onClearArchivedSessions: vi.fn(),
    onScanStorage: vi.fn(),
    onCleanStorage: vi.fn(),
    onOpenAbout: vi.fn(),
    ...overrides,
  };
  return { ...render(createElement(SettingsModal, props)), props };
}

beforeEach(() => {
  setLang("en");
  vi.mocked(invoke).mockReset().mockResolvedValue(false);
  vi.stubGlobal("Notification", {
    permission: "default",
    requestPermission: vi.fn(async () => "granted"),
  });
  document.head.innerHTML = '<meta name="jupiter-platform" content="android">';
  initializeWebSurface();
  document.documentElement.dataset.webMcpWrite = "true";
  document.documentElement.dataset.webSecretWrite = "true";
});

afterEach(() => {
  cleanup();
  document.head.innerHTML = "";
  for (const element of [document.documentElement, document.body]) {
    for (const key of Object.keys(element.dataset)) delete element.dataset[key];
  }
  localStorage.removeItem("jupiter.web.notifications");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Android UI surface capabilities", { retry: 0 }, () => {
  it("marks both roots as Android Web without granting desktop-native capabilities", () => {
    for (const element of [document.documentElement, document.body]) {
      expect(element.dataset).toMatchObject({
        runtime: "web",
        hostPlatform: "android",
        nativeWindow: "false",
      });
    }
    expect(surfaceCapabilities).toMatchObject({
      nativeWindow: false,
      nativeWebview: false,
      nativeDialogs: false,
      nativeMenus: false,
      nativeUpdater: false,
      externalBrowser: true,
    });
  });

  it("does not carry Android identity over to an ordinary browser", () => {
    document.head.innerHTML = "";
    initializeWebSurface();
    expect(document.documentElement.dataset.hostPlatform).toBe("browser");
    expect(document.body.dataset.hostPlatform).toBe("browser");
  });

  it("hides desktop-only settings and browser pairing on Android", async () => {
    renderSettings();
    await act(async () => {});
    for (const key of [
      "settings.pageComputerUseLabel",
      "settings.pageComponentsLabel",
      "settings.pagePetsLabel",
      "settings.pageShortcutsLabel",
    ] as const) {
      expect(
        screen.queryByRole("button", {
          name: new RegExp(t(key)),
        }),
      ).toBeNull();
    }
    expect(
      screen.getByRole("button", { name: new RegExp(t("settings.pageModelsLabel")) }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: new RegExp(t("settings.pageMcpLabel")) }),
    ).toBeTruthy();
    expect(screen.queryByPlaceholderText("cursor --goto")).toBeNull();
    expect(screen.queryByText(t("settings.desktopCloseBehavior"))).toBeNull();
    expect(screen.queryByRole("button", { name: t("settings.closeToQuit") })).toBeNull();
    expect(screen.queryByRole("button", { name: t("settings.closeToTray") })).toBeNull();
    expect(screen.queryByText(t("settings.webAccessSection"))).toBeNull();
    expect(screen.queryByRole("button", { name: t("settings.webPairDeviceCreate") })).toBeNull();
    expect(screen.queryByText(t("settings.webNotifications"))).toBeNull();
    expect(screen.getByText(t("settings.androidNotifications"))).toBeTruthy();
  });

  it.each(["computer-use", "components", "pets", "shortcuts"] as const)(
    "falls back from a direct %s page request without desktop probing",
    async (initialPage) => {
      const { container, props } = renderSettings({ initialPage });
      await act(async () => {});
      expect(
        container.querySelector('.settings-side .row[data-active="true"]')?.textContent,
      ).toContain(t("settings.pageGeneralLabel"));
      expect(screen.queryByText(t("settings.computerUseEnabled"))).toBeNull();
      expect(props.onRefreshOptionalComponents).not.toHaveBeenCalled();
    },
  );

  it("retains core General actions and settings on Android", async () => {
    const { props } = renderSettings();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: t("settings.workspaceChange") }));
    expect(props.onPickWorkspace).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: t("settings.aboutOpen") }));
    expect(props.onOpenAbout).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("switch", { name: t("settings.promptPredictions") }));
    expect(props.onSave).toHaveBeenCalledWith({ promptPredictionsEnabled: false });
    fireEvent.blur(screen.getByPlaceholderText(t("settings.budgetPlaceholder")), {
      target: { value: "12" },
    });
    expect(props.onSave).toHaveBeenCalledWith({ budgetUsd: 12 });
    for (const key of [
      "settings.pageSchedulesLabel",
      "settings.pageRulesLabel",
      "settings.pageSkillsLabel",
      "settings.pageMemoryLabel",
      "settings.pageArchivesLabel",
      "settings.pageStorageLabel",
      "settings.pageAppearanceLabel",
      "settings.pageBillingLabel",
    ] as const) {
      expect(screen.getByRole("button", { name: new RegExp(t(key)) })).toBeTruthy();
    }
    expect(screen.getByText(t("settings.language"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("settings.close") }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("retains MCP and secret-write capability gates on Android", async () => {
    document.documentElement.dataset.webSecretWrite = "false";
    renderSettings({ initialPage: "mcp" });
    await act(async () => {});
    expect(
      screen.queryByRole("button", { name: new RegExp(t("settings.pageMcpLabel")) }),
    ).toBeNull();
    expect(screen.getByText(t("settings.androidNotifications"))).toBeTruthy();
  });

  it("checks notification status and requests native permission only on click", async () => {
    renderSettings();
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("android_notifications_status");
    expect(invoke).not.toHaveBeenCalledWith("android_notifications_enable");
    vi.mocked(invoke).mockResolvedValueOnce(true);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: t("settings.webNotificationsEnable") })),
    );
    expect(invoke).toHaveBeenCalledWith("android_notifications_enable");
    expect(
      screen.getByRole("button", { name: t("settings.androidNotificationsManage") }),
    ).toBeTruthy();
    expect(Notification.requestPermission).not.toHaveBeenCalled();
    expect(localStorage.getItem("jupiter.web.notifications")).toBeNull();
  });

  it.each(["denied", "failed"])(
    "keeps %s native permission usable without an automatic retry",
    async (outcome) => {
      vi.useFakeTimers();
      renderSettings();
      await act(async () => {});
      vi.mocked(invoke).mockClear();
      if (outcome === "failed")
        vi.mocked(invoke).mockRejectedValueOnce(new Error("permission cancelled"));
      else vi.mocked(invoke).mockResolvedValueOnce(false);
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: t("settings.webNotificationsEnable") })),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenCalledWith("android_notifications_enable");
      expect(
        screen.getByRole("button", { name: t("settings.webNotificationsEnable") }),
      ).toBeTruthy();
      expect(Notification.requestPermission).not.toHaveBeenCalled();
    },
  );

  it("does not query browser device pairing when the Android UI hides Web access", async () => {
    renderSettings();
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalledWith("web_devices_get");
    expect(invoke).not.toHaveBeenCalledWith("web_pairing_create");
  });

  it.each(["android", "browser"])(
    "allows provider editing only on the local Android host (%s)",
    (platform) => {
      document.documentElement.dataset.hostPlatform = platform;
      render(
        createElement(ProviderSection, {
          settings,
          onSave: vi.fn(),
          onTestProvider: vi.fn(),
          onSignOutApiKey: vi.fn(),
        }),
      );
      if (platform === "android") {
        expect(screen.getByLabelText(t("settings.providerProtocol"))).toBeTruthy();
        expect(screen.getByLabelText(t("settings.apiKey"))).toBeTruthy();
        expect(screen.queryByText(t("settings.providerLocalOnly"))).toBeNull();
      } else {
        expect(screen.queryByLabelText(t("settings.providerProtocol"))).toBeNull();
        expect(screen.queryByLabelText(t("settings.apiKey"))).toBeNull();
        expect(screen.getByText(t("settings.providerLocalOnly"))).toBeTruthy();
      }
    },
  );

  it("preserves browser-only settings on the ordinary Web surface", async () => {
    document.documentElement.dataset.hostPlatform = "browser";
    renderSettings();
    await act(async () => {});
    expect(
      screen.getByRole("button", { name: new RegExp(t("settings.pageComputerUseLabel")) }),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText("cursor --goto")).toBeTruthy();
    expect(screen.getByRole("button", { name: t("settings.closeToTray") })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: new RegExp(t("settings.pageComponentsLabel")) }),
    ).toBeTruthy();
    expect(screen.getByText(t("settings.webAccessSection"))).toBeTruthy();
    expect(screen.getByText(t("settings.webNotifications"))).toBeTruthy();
    expect(screen.queryByText(t("settings.androidNotifications"))).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("android_notifications_status");
  });

  it("preserves desktop window controls and all desktop settings pages", async () => {
    delete document.documentElement.dataset.runtime;
    delete document.documentElement.dataset.hostPlatform;
    document.documentElement.dataset.nativeWindow = "true";
    const { props } = renderSettings();
    await act(async () => {});
    for (const key of [
      "settings.pageComputerUseLabel",
      "settings.pageComponentsLabel",
      "settings.pagePetsLabel",
      "settings.pageShortcutsLabel",
    ] as const) {
      expect(screen.getByRole("button", { name: new RegExp(t(key)) })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: t("settings.closeToTray") }));
    expect(props.onSave).toHaveBeenCalledWith({ desktopCloseBehavior: "closeToTray" });
    expect(invoke).not.toHaveBeenCalledWith("android_notifications_status");
  });
});
