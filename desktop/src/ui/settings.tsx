import { openUrl } from "@tauri-apps/plugin-opener";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Balance, SessionInfo, Settings as SettingsType, UsageStats } from "../App";
import {
  type FeishuDesktopSettingsState,
  describeFeishuRowSummary,
  getFeishuConnectIntent,
  getFeishuStatusLabel,
} from "../feishu-settings";
import { getLangLabel, getSupportedLangs, setLang, t, useLang } from "../i18n";
import { I } from "../icons";
import type {
  McpSpecInfo,
  MemoryDetail,
  MemoryEntryInfo,
  MemoryWriteInput,
  SettingsPatch,
  SkillPackSourceInfo,
  SkillInfo,
  SkillRootInfo,
} from "../protocol";
import {
  type QQDesktopSettingsState,
  describeQQRowSummary,
  getQQConnectIntent,
  getQQStatusLabel,
} from "../qq-settings";
import {
  FONT_FAMILY,
  FONT_SCALE,
  type FontFamily,
  type FontScale,
  THEME,
  THEME_STYLES,
  type Theme,
  type ThemeStyle,
  themeForStyle,
} from "../theme";
import { displayWorkspacePath } from "../workspace-display";
import { Shortcut, type ShortcutKey } from "./shortcut";

const CHROME_DOWNLOAD_URL = "https://www.google.com/chrome/";
const EDGE_DOWNLOAD_URL = "https://www.microsoft.com/edge/download";

export type PageId =
  | "general"
  | "models"
  | "rules"
  | "mcp"
  | "skills"
  | "memory"
  | "archives"
  | "appearance"
  | "billing"
  | "shortcuts";

const PAGE_META: ReadonlyArray<{ id: PageId; icon: keyof typeof I }> = [
  { id: "general", icon: "cog" },
  { id: "models", icon: "brain" },
  { id: "rules", icon: "shield" },
  { id: "mcp", icon: "wrench" },
  { id: "skills", icon: "zap" },
  { id: "memory", icon: "bookmark" },
  { id: "archives", icon: "archive" },
  { id: "appearance", icon: "sun" },
  { id: "billing", icon: "coin" },
  { id: "shortcuts", icon: "cpu" },
];

export function SettingsModal({
  settings,
  balance,
  usage,
  currency,
  theme,
  themeStyle,
  onSetTheme,
  onSetThemeStyle,
  fontScale,
  onSetFontScale,
  fontFamily,
  onSetFontFamily,
  customFontFamily,
  onSetCustomFontFamily,
  initialPage,
  mcpSpecs,
  mcpBridged,
  skills,
  skillRoots,
  memory,
  memoryDetail,
  archivedSessions,
  qq,
  feishu,
  onClose,
  onSave,
  onSaveApiKey,
  onSignOutApiKey,
  onLoadQQ,
  onConnectQQ,
  onDisconnectQQ,
  onSaveQQConfig,
  onOpenQQApplyLink,
  onLoadFeishu,
  onConnectFeishu,
  onDisconnectFeishu,
  onSaveFeishuConfig,
  onOpenFeishuApplyLink,
  onPickWorkspace,
  onAddMcpSpec,
  onRemoveMcpSpec,
  onEnableMcpSpec,
  onDisableMcpSpec,
  onReconnectMcpSpecs,
  onAddSkillPath,
  onRemoveSkillPath,
  onCreateSkill,
  onSetSkillModel,
  onReadMemory,
  onRefreshMemory,
  onDeleteMemory,
  onSaveMemory,
  onRefreshArchivedSessions,
  onRestoreArchivedSession,
  onDeleteArchivedSession,
  onOpenAbout,
}: {
  settings: SettingsType;
  balance: Balance | null;
  usage: UsageStats;
  currency: "CNY" | "USD";
  theme: Theme;
  themeStyle: ThemeStyle;
  onSetTheme: (theme: Theme) => void;
  onSetThemeStyle: (style: ThemeStyle) => void;
  fontScale: FontScale;
  onSetFontScale: (scale: FontScale) => void;
  fontFamily: FontFamily;
  onSetFontFamily: (family: FontFamily) => void;
  customFontFamily: string;
  onSetCustomFontFamily: (family: string) => void;
  initialPage?: PageId;
  mcpSpecs: McpSpecInfo[];
  mcpBridged: boolean;
  skills: SkillInfo[];
  skillRoots: SkillRootInfo[];
  memory: MemoryEntryInfo[];
  memoryDetail: MemoryDetail | null;
  archivedSessions: SessionInfo[];
  qq: QQDesktopSettingsState | null;
  feishu: FeishuDesktopSettingsState | null;
  onClose: () => void;
  onSave: (patch: SettingsPatch) => void;
  onSaveApiKey: (key: string) => void;
  onSignOutApiKey: () => void;
  onLoadQQ: () => void;
  onConnectQQ: () => void;
  onDisconnectQQ: () => void;
  onSaveQQConfig: (patch: {
    appId?: string;
    appSecret?: string;
    sandbox: boolean;
  }) => void;
  onOpenQQApplyLink: () => void;
  onLoadFeishu: () => void;
  onConnectFeishu: () => void;
  onDisconnectFeishu: () => void;
  onSaveFeishuConfig: (patch: {
    appId?: string;
    appSecret?: string;
    requireMentionInGroup?: boolean;
  }) => void;
  onOpenFeishuApplyLink: () => void;
  onPickWorkspace: () => void;
  onAddMcpSpec: (spec: string) => void;
  onRemoveMcpSpec: (spec: string) => void;
  onEnableMcpSpec: (name: string) => void;
  onDisableMcpSpec: (name: string) => void;
  onReconnectMcpSpecs: () => void;
  onAddSkillPath: (path: string) => void;
  onRemoveSkillPath: (path: string) => void;
  onCreateSkill: (name: string, scope: "project" | "global") => void;
  onSetSkillModel: (name: string, model: "flash" | "pro" | null) => void;
  onReadMemory: (path: string) => void;
  onRefreshMemory: () => void;
  onDeleteMemory: (path: string) => void;
  onSaveMemory: (input: MemoryWriteInput) => void;
  onRefreshArchivedSessions: () => void;
  onRestoreArchivedSession: (name: string) => void;
  onDeleteArchivedSession: (name: string) => void;
  onOpenAbout: () => void;
}) {
  const [page, setPage] = useState<PageId>(initialPage ?? "general");
  const [qqConfigureOpen, setQQConfigureOpen] = useState(false);
  const [feishuConfigureOpen, setFeishuConfigureOpen] = useState(false);
  const [settingsBodyScrolling, setSettingsBodyScrolling] = useState(false);
  const settingsBodyScrollTimerRef = useRef<number | null>(null);
  const markSettingsBodyScrolling = () => {
    setSettingsBodyScrolling(true);
    if (settingsBodyScrollTimerRef.current !== null) {
      window.clearTimeout(settingsBodyScrollTimerRef.current);
    }
    settingsBodyScrollTimerRef.current = window.setTimeout(() => {
      settingsBodyScrollTimerRef.current = null;
      setSettingsBodyScrolling(false);
    }, 800);
  };
  useEffect(() => {
    setPage(initialPage ?? "general");
  }, [initialPage]);
  useEffect(() => {
    if (page === "archives") onRefreshArchivedSessions();
  }, [onRefreshArchivedSessions, page]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    return () => {
      if (settingsBodyScrollTimerRef.current !== null) {
        window.clearTimeout(settingsBodyScrollTimerRef.current);
      }
    };
  }, []);
  const currentMeta = PAGE_META.find((p) => p.id === page) ?? PAGE_META[0]!;
  return (
    <div className="settings-mask" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <nav className="settings-side">
          <div className="sg">{t("settings.title")}</div>
          {PAGE_META.map((p) => (
            <div
              key={p.id}
              className="row"
              data-active={page === p.id}
              onClick={() => setPage(p.id)}
            >
              <span className="ico">{I[p.icon]({ size: 13 })}</span>
              <span>{t(`settings.page${p.id[0]!.toUpperCase()}${p.id.slice(1)}Label` as any)}</span>
            </div>
          ))}
        </nav>
        <div className="settings-main">
          <div className="settings-head">
            <div>
              <h2>
                {t(
                  `settings.page${currentMeta.id[0]!.toUpperCase()}${currentMeta.id.slice(1)}Label` as any,
                )}
              </h2>
              <div className="desc">
                {t(
                  `settings.page${currentMeta.id[0]!.toUpperCase()}${currentMeta.id.slice(1)}Desc` as any,
                )}
              </div>
            </div>
            <span className="grow" />
            <button type="button" className="close-btn" onClick={onClose}>
              <I.x size={14} />
            </button>
          </div>
          <div
            className="settings-body"
            data-scrolling={settingsBodyScrolling ? "true" : undefined}
            onScroll={markSettingsBodyScrolling}
          >
            {page === "general" && (
              <PageGeneral
                settings={settings}
                onSave={onSave}
                onPickWorkspace={onPickWorkspace}
                onOpenAbout={onOpenAbout}
              />
            )}
            {page === "models" && <PageModels settings={settings} onSave={onSave} />}
            {page === "mcp" && (
              <>
                <ApiKeySection
                  baseUrl={settings.baseUrl}
                  apiKeyPrefix={settings.apiKeyPrefix}
                  onSave={onSave}
                  onSaveApiKey={onSaveApiKey}
                  onSignOutApiKey={onSignOutApiKey}
                />
                <WebSearchSection settings={settings} onSave={onSave} />
                <BrowserAutomationSection settings={settings} />
                <QQChannelSection
                  qq={qq}
                  configureOpen={qqConfigureOpen}
                  onOpenConfigure={() => {
                    onLoadQQ();
                    setQQConfigureOpen(true);
                  }}
                  onCloseConfigure={() => setQQConfigureOpen(false)}
                  onConnect={onConnectQQ}
                  onDisconnect={onDisconnectQQ}
                  onSaveConfig={onSaveQQConfig}
                  onSaveAndConnect={(patch) => {
                    onSaveQQConfig(patch);
                    onConnectQQ();
                  }}
                  onOpenApplyLink={onOpenQQApplyLink}
                />
                <FeishuChannelSection
                  feishu={feishu}
                  configureOpen={feishuConfigureOpen}
                  onOpenConfigure={() => {
                    onLoadFeishu();
                    setFeishuConfigureOpen(true);
                  }}
                  onCloseConfigure={() => setFeishuConfigureOpen(false)}
                  onConnect={onConnectFeishu}
                  onDisconnect={onDisconnectFeishu}
                  onSaveConfig={onSaveFeishuConfig}
                  onSaveAndConnect={(patch) => {
                    onSaveFeishuConfig(patch);
                    onConnectFeishu();
                  }}
                  onOpenApplyLink={onOpenFeishuApplyLink}
                />
                <PageMCP
                  specs={mcpSpecs}
                  bridged={mcpBridged}
                  onAdd={onAddMcpSpec}
                  onRemove={onRemoveMcpSpec}
                  onEnable={onEnableMcpSpec}
                  onDisable={onDisableMcpSpec}
                  onReconnect={onReconnectMcpSpecs}
                />
              </>
            )}
            {page === "skills" && (
              <PageSkills
                settings={settings}
                skills={skills}
                roots={skillRoots}
                subagentModels={settings.subagentModels ?? {}}
                onAddPath={onAddSkillPath}
                onRemovePath={onRemoveSkillPath}
                onCreate={onCreateSkill}
                onSetModel={onSetSkillModel}
                onSaveSettings={onSave}
              />
            )}
            {page === "memory" && (
              <PageMemory
                settings={settings}
                entries={memory}
                detail={memoryDetail}
                onRead={onReadMemory}
                onRefresh={onRefreshMemory}
                onDelete={onDeleteMemory}
                onSave={onSaveMemory}
                onSaveSettings={onSave}
              />
            )}
            {page === "archives" && (
              <PageArchives
                sessions={archivedSessions}
                onRefresh={onRefreshArchivedSessions}
                onRestore={onRestoreArchivedSession}
                onDelete={onDeleteArchivedSession}
              />
            )}
            {page === "rules" && <PageRules settings={settings} onSave={onSave} />}
            {page === "appearance" && (
              <PageAppearance
                theme={theme}
                themeStyle={themeStyle}
                onSetTheme={onSetTheme}
                onSetThemeStyle={onSetThemeStyle}
                fontScale={fontScale}
                onSetFontScale={onSetFontScale}
                fontFamily={fontFamily}
                onSetFontFamily={onSetFontFamily}
                customFontFamily={customFontFamily}
                onSetCustomFontFamily={onSetCustomFontFamily}
              />
            )}
            {page === "billing" && (
              <PageBilling balance={balance} usage={usage} currency={currency} />
            )}
            {page === "shortcuts" && <PageShortcuts />}
          </div>
        </div>
      </div>
    </div>
  );
}

export function QQChannelSection({
  qq,
  configureOpen,
  onOpenConfigure,
  onCloseConfigure,
  onConnect,
  onDisconnect,
  onSaveConfig,
  onSaveAndConnect,
  onOpenApplyLink,
}: {
  qq: QQDesktopSettingsState | null;
  configureOpen: boolean;
  onOpenConfigure: () => void;
  onCloseConfigure: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onSaveConfig: (patch: {
    appId?: string;
    appSecret?: string;
    sandbox: boolean;
  }) => void;
  onSaveAndConnect: (patch: {
    appId?: string;
    appSecret?: string;
    sandbox: boolean;
  }) => void;
  onOpenApplyLink: () => void;
}) {
  const current = qq ?? {
    appId: undefined,
    appSecret: undefined,
    sandbox: true,
    enabled: false,
    configured: false,
    runtimeState: "disconnected",
    access: "open (unbound)",
  };
  const [appId, setAppId] = useState(current.appId ?? "");
  const [appSecret, setAppSecret] = useState(current.appSecret ?? "");
  const [sandbox, setSandbox] = useState(current.sandbox ?? true);

  useEffect(() => {
    setAppId(current.appId ?? "");
    setAppSecret(current.appSecret ?? "");
    setSandbox(current.sandbox ?? true);
  }, [current.appId, current.appSecret, current.sandbox, configureOpen]);

  const savePatch = { appId, appSecret, sandbox };

  return (
    <section className="section">
      <div className="stitle">{t("settings.qqSection")}</div>
      {!configureOpen ? (
        <div className="setting-row qq-setting-row">
          <div className="l">
            <div className="n">{t("settings.qqTitle")}</div>
            <div className="h">{describeQQRowSummary(current)}</div>
          </div>
          <div className="qq-row-actions">
            <button
              type="button"
              className={`btn qq-status-btn qq-status-${
                current.runtimeState === "connected"
                  ? "on"
                  : current.runtimeState === "connecting"
                    ? "connecting"
                    : current.runtimeState === "failed"
                      ? "failed"
                      : "off"
              }`}
              onClick={() => {
                if (getQQConnectIntent(current) === "configure") {
                  onOpenConfigure();
                  return;
                }
                if (current.runtimeState === "connected") {
                  onDisconnect();
                  return;
                }
                onConnect();
              }}
            >
              {getQQStatusLabel(current)}
            </button>
            <button type="button" className="btn" onClick={onOpenConfigure}>
              {t("settings.qqConfigure")}
            </button>
          </div>
        </div>
      ) : (
        <div className="qq-config-card">
          <div className="qq-config-head">
            <div>
              <div className="n">{t("settings.qqConfigureTitle")}</div>
              <div className="h">{t("settings.qqConfigureHint")}</div>
            </div>
            <button type="button" className="btn" onClick={onCloseConfigure}>
              {t("settings.qqBack")}
            </button>
          </div>
          <div className="setting-row">
            <div className="l">
              <div className="n">{t("settings.qqAppId")}</div>
            </div>
            <input
              className="field mono"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder="QQ Open Platform App ID"
            />
          </div>
          <div className="setting-row">
            <div className="l">
              <div className="n">{t("settings.qqAppSecret")}</div>
            </div>
            <input
              className="field mono"
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder="QQ Open Platform App Secret"
            />
          </div>
          <div className="setting-row">
            <div className="l">
              <div className="n">{t("settings.qqEnvironment")}</div>
            </div>
            <div className="seg-ctrl">
              <button type="button" data-on={sandbox} onClick={() => setSandbox(true)}>
                {t("settings.qqSandbox")}
              </button>
              <button type="button" data-on={!sandbox} onClick={() => setSandbox(false)}>
                {t("settings.qqProduction")}
              </button>
            </div>
          </div>
          <div className="setting-row">
            <div className="l">
              <div className="n">{t("settings.qqApplyLabel")}</div>
            </div>
            <button type="button" className="btn" onClick={onOpenApplyLink}>
              {t("settings.qqApplyAction")}
            </button>
          </div>
          <div className="qq-config-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                onSaveConfig(savePatch);
                onCloseConfigure();
              }}
            >
              {t("settings.qqSave")}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                onSaveAndConnect(savePatch);
                onCloseConfigure();
              }}
            >
              {t("settings.qqSaveAndConnect")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function FeishuChannelSection({
  feishu,
  configureOpen,
  onOpenConfigure,
  onCloseConfigure,
  onConnect,
  onDisconnect,
  onSaveConfig,
  onSaveAndConnect,
  onOpenApplyLink,
}: {
  feishu: FeishuDesktopSettingsState | null;
  configureOpen: boolean;
  onOpenConfigure: () => void;
  onCloseConfigure: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onSaveConfig: (patch: {
    appId?: string;
    appSecret?: string;
    requireMentionInGroup?: boolean;
  }) => void;
  onSaveAndConnect: (patch: {
    appId?: string;
    appSecret?: string;
    requireMentionInGroup?: boolean;
  }) => void;
  onOpenApplyLink: () => void;
}) {
  const current = feishu ?? {
    appId: undefined,
    appSecret: undefined,
    enabled: false,
    configured: false,
    requireMentionInGroup: true,
    runtimeState: "disconnected" as const,
  };
  const [appId, setAppId] = useState(current.appId ?? "");
  const [appSecret, setAppSecret] = useState(current.appSecret ?? "");
  const [requireMentionInGroup, setRequireMentionInGroup] = useState(current.requireMentionInGroup);

  useEffect(() => {
    setAppId(current.appId ?? "");
    setAppSecret(current.appSecret ?? "");
    setRequireMentionInGroup(current.requireMentionInGroup);
  }, [current.appId, current.appSecret, current.requireMentionInGroup, configureOpen]);

  const savePatch = { appId, appSecret, requireMentionInGroup };

  return (
    <section className="section">
      <div className="stitle">{t("settings.feishuSection")}</div>
      {!configureOpen ? (
        <div className="setting-row qq-setting-row">
          <div className="l">
            <div className="n">{t("settings.feishuTitle")}</div>
            <div className="h">{describeFeishuRowSummary(current)}</div>
          </div>
          <div className="qq-row-actions">
            <button
              type="button"
              className={`btn qq-status-btn qq-status-${
                current.runtimeState === "connected"
                  ? "on"
                  : current.runtimeState === "connecting"
                    ? "connecting"
                    : current.runtimeState === "failed"
                      ? "failed"
                      : "off"
              }`}
              onClick={() => {
                if (getFeishuConnectIntent(current) === "configure") {
                  onOpenConfigure();
                  return;
                }
                if (current.runtimeState === "connected") {
                  onDisconnect();
                  return;
                }
                onConnect();
              }}
            >
              {getFeishuStatusLabel(current)}
            </button>
            <button type="button" className="btn" onClick={onOpenConfigure}>
              {t("settings.feishuConfigure")}
            </button>
          </div>
        </div>
      ) : (
        <div className="qq-config-card">
          <div className="qq-config-head">
            <div>
              <div className="n">{t("settings.feishuConfigureTitle")}</div>
              <div className="h">{t("settings.feishuConfigureHint")}</div>
            </div>
            <button type="button" className="btn" onClick={onCloseConfigure}>
              {t("settings.feishuBack")}
            </button>
          </div>
          <div className="setting-row">
            <div className="l">
              <div className="n">{t("settings.feishuAppId")}</div>
            </div>
            <input
              className="field mono"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder="Feishu App ID"
            />
          </div>
          <div className="setting-row">
            <div className="l">
              <div className="n">{t("settings.feishuAppSecret")}</div>
            </div>
            <input
              className="field mono"
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder="Feishu App Secret"
            />
          </div>
          <div className="setting-row">
            <div className="l">
              <div className="n">{t("settings.feishuGroupPolicy")}</div>
              <div className="h">{t("settings.feishuGroupPolicyHint")}</div>
            </div>
            <div className="seg-ctrl">
              <button
                type="button"
                data-on={requireMentionInGroup}
                onClick={() => setRequireMentionInGroup(true)}
              >
                {t("settings.feishuGroupMentionRequired")}
              </button>
              <button
                type="button"
                data-on={!requireMentionInGroup}
                onClick={() => setRequireMentionInGroup(false)}
              >
                {t("settings.feishuGroupAllMessages")}
              </button>
            </div>
          </div>
          <div className="setting-row">
            <div className="l">
              <div className="n">{t("settings.feishuApplyLabel")}</div>
            </div>
            <button type="button" className="btn" onClick={onOpenApplyLink}>
              {t("settings.feishuApplyAction")}
            </button>
          </div>
          <div className="qq-config-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                onSaveConfig(savePatch);
                onCloseConfigure();
              }}
            >
              {t("settings.feishuSave")}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                onSaveAndConnect(savePatch);
                onCloseConfigure();
              }}
            >
              {t("settings.feishuSaveAndConnect")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function PageGeneral({
  settings,
  onSave,
  onPickWorkspace,
  onOpenAbout,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
  onPickWorkspace: () => void;
  onOpenAbout: () => void;
}) {
  const [editorDraft, setEditorDraft] = useState(settings.editor ?? "");
  const lang = useLang();
  return (
    <>
      <section className="section">
        <div className="stitle">{t("settings.workspaceSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.currentWorkspace")}</div>
            <div className="h">
              {displayWorkspacePath(settings.workspaceDir, t("settings.notSelected"))}
            </div>
          </div>
          <button type="button" className="btn" onClick={onPickWorkspace}>
            {t("settings.workspaceChange")}
          </button>
        </div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.editor")}</div>
            <div className="h">{t("settings.editorHint")}</div>
          </div>
          <input
            className="field mono"
            value={editorDraft}
            placeholder="cursor --goto"
            onChange={(e) => setEditorDraft(e.target.value)}
            onBlur={() => onSave({ editor: editorDraft.trim() })}
          />
        </div>
      </section>

      <section className="section">
        <div className="stitle">{t("settings.behaviorSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.showSystemEvents")}</div>
            <div className="h">{t("settings.showSystemEventsHint")}</div>
          </div>
          <div className="seg-ctrl">
            <button
              type="button"
              data-on={settings.showSystemEvents !== false}
              onClick={() => onSave({ showSystemEvents: true })}
            >
              {t("settings.shown")}
            </button>
            <button
              type="button"
              data-on={settings.showSystemEvents === false}
              onClick={() => onSave({ showSystemEvents: false })}
            >
              {t("settings.hidden")}
            </button>
          </div>
        </div>
        <div className="setting-row switch-row">
          <div className="l">
            <div className="n">{t("settings.processCardsDefaultOpen")}</div>
            <div className="h">{t("settings.processCardsDefaultOpenHint")}</div>
          </div>
          <div className="seg-ctrl" role="group" aria-label={t("settings.processCardsDefaultOpen")}>
            <button
              type="button"
              data-on={settings.processCardsDefaultOpen === true}
              onClick={() => onSave({ processCardsDefaultOpen: true })}
            >
              {t("settings.expanded")}
            </button>
            <button
              type="button"
              data-on={settings.processCardsDefaultOpen !== true}
              onClick={() => onSave({ processCardsDefaultOpen: false })}
            >
              {t("settings.collapsed")}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.desktopCloseBehavior")}</div>
            <div className="h">{t("settings.desktopCloseBehaviorHint")}</div>
          </div>
          <div className="seg-ctrl">
            <button
              type="button"
              data-on={(settings.desktopCloseBehavior ?? "closeToQuit") === "closeToQuit"}
              onClick={() => onSave({ desktopCloseBehavior: "closeToQuit" })}
            >
              {t("settings.closeToQuit")}
            </button>
            <button
              type="button"
              data-on={settings.desktopCloseBehavior === "closeToTray"}
              onClick={() => onSave({ desktopCloseBehavior: "closeToTray" })}
            >
              {t("settings.closeToTray")}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.language")}</div>
            <div className="h">{t("settings.languageHint")}</div>
          </div>
          <div className="seg-ctrl">
            {getSupportedLangs().map((code) => (
              <button
                type="button"
                key={code}
                data-on={lang === code}
                onClick={() => setLang(code)}
              >
                {getLangLabel(code)}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="stitle">{t("settings.aboutSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.aboutTitle")}</div>
            <div className="h">{t("settings.aboutHint")}</div>
          </div>
          <button type="button" className="btn" onClick={onOpenAbout}>
            <I.help size={13} />
            <span>{t("settings.aboutOpen")}</span>
          </button>
        </div>
      </section>

      <section className="section">
        <div className="stitle">{t("settings.usageSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.budget")}</div>
            <div className="h">{t("settings.budgetHint")}</div>
          </div>
          <input
            className="field"
            type="number"
            defaultValue={settings.budgetUsd ?? ""}
            placeholder={t("settings.budgetPlaceholder")}
            onBlur={(e) => {
              const v = e.target.value.trim();
              onSave({ budgetUsd: v === "" ? null : Number(v) });
            }}
          />
        </div>
      </section>
    </>
  );
}

function WebSearchSection({
  settings,
  onSave,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
}) {
  return (
    <section className="section">
      <div className="stitle">{t("settings.webSearchSection")}</div>
      <div className="setting-row">
        <div className="l">
          <div className="n">{t("settings.webSearchEngine")}</div>
          <div className="h">{t("settings.webSearchEngineNote")}</div>
        </div>
        <select
          className="field"
          value={settings.webSearchEngine ?? "bing"}
          onChange={(e) =>
            onSave({
              webSearchEngine: e.target.value as
                | "bing"
                | "bing-intl"
                | "searxng"
                | "metaso"
                | "baidu"
                | "tavily"
                | "perplexity"
                | "exa"
                | "brave"
                | "ollama",
            })
          }
        >
          <option value="bing">{t("settings.webSearchEngineBing")}</option>
          <option value="bing-intl">{t("settings.webSearchEngineBingIntl")}</option>
          <option value="searxng">{t("settings.webSearchEngineSearxng")}</option>
          <option value="metaso">{t("settings.webSearchEngineMetaso")}</option>
          <option value="baidu">{t("settings.webSearchEngineBaidu")}</option>
          <option value="tavily">{t("settings.webSearchEngineTavily")}</option>
          <option value="perplexity">{t("settings.webSearchEnginePerplexity")}</option>
          <option value="exa">{t("settings.webSearchEngineExa")}</option>
          <option value="brave">{t("settings.webSearchEngineBrave")}</option>
          <option value="ollama">{t("settings.webSearchEngineOllama")}</option>
        </select>
      </div>
      <WebSearchEngineCredentials settings={settings} onSave={onSave} />
    </section>
  );
}

function BrowserAutomationSection({ settings }: { settings: SettingsType }) {
  const status = settings.browserAutomation ?? { state: "unavailable" };
  const isAvailable = status.state === "available";

  return (
    <section className="section">
      <div className="stitle">{t("settings.browserAutomationSection")}</div>
      <div className="setting-row">
        <div className="l">
          <div className="n">{t("settings.browserAutomation")}</div>
          <div className="h">
            {isAvailable
              ? t("settings.browserAutomationAvailable", { name: status.name })
              : t("settings.browserAutomationFallback")}
          </div>
          <div className="h">
            {isAvailable
              ? t("settings.browserAutomationAvailableHint")
              : t("settings.browserAutomationFallbackHint")}
          </div>
          {isAvailable && <code>{status.executablePath}</code>}
        </div>
        {!isAvailable && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void openUrl(CHROME_DOWNLOAD_URL);
              }}
            >
              <span>{t("settings.browserAutomationInstallChrome")}</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void openUrl(EDGE_DOWNLOAD_URL);
              }}
            >
              <span>{t("settings.browserAutomationInstallEdge")}</span>
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function PageAppearance({
  theme,
  themeStyle,
  onSetTheme,
  onSetThemeStyle,
  fontScale,
  onSetFontScale,
  fontFamily,
  onSetFontFamily,
  customFontFamily,
  onSetCustomFontFamily,
}: {
  theme: Theme;
  themeStyle: ThemeStyle;
  onSetTheme: (theme: Theme) => void;
  onSetThemeStyle: (style: ThemeStyle) => void;
  fontScale: FontScale;
  onSetFontScale: (scale: FontScale) => void;
  fontFamily: FontFamily;
  onSetFontFamily: (family: FontFamily) => void;
  customFontFamily: string;
  onSetCustomFontFamily: (family: string) => void;
}) {
  const [customFontDraft, setCustomFontDraft] = useState(customFontFamily);
  useEffect(() => {
    setCustomFontDraft(customFontFamily);
  }, [customFontFamily]);
  const commitCustomFont = (value: string) => {
    const next = value.trim();
    setCustomFontDraft(next);
    onSetCustomFontFamily(next);
  };
  return (
    <>
      <section className="section">
        <div className="stitle">{t("settings.appearanceSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.theme")}</div>
            <div className="h">{t("settings.themeHint")}</div>
          </div>
          <div className="seg-ctrl">
            <button
              type="button"
              data-on={theme === THEME.DARK}
              onClick={() => onSetTheme(THEME.DARK)}
            >
              {t("settings.themeDark")}
            </button>
            <button
              type="button"
              data-on={theme === THEME.LIGHT}
              onClick={() => onSetTheme(THEME.LIGHT)}
            >
              {t("settings.themeLight")}
            </button>
          </div>
        </div>
        <div className="setting-row theme-style-row">
          <div className="l">
            <div className="n">{t("settings.themeStyle")}</div>
            <div className="h">{t("settings.themeStyleHint")}</div>
          </div>
          <div className="style-grid">
            {THEME_STYLES.map((style) => (
              <button
                key={style}
                type="button"
                className="style-card"
                data-on={themeStyle === style}
                data-style={style}
                onClick={() => onSetThemeStyle(style)}
              >
                <span className="style-card-head">
                  <span className="style-name">
                    {t(`settings.themeStyle${style[0]!.toUpperCase()}${style.slice(1)}` as any)}
                  </span>
                  <span className="style-mode">
                    {themeForStyle(style) === THEME.DARK
                      ? t("settings.themeDark")
                      : t("settings.themeLight")}
                  </span>
                </span>
                <span className="style-swatches" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="style-desc">
                  {t(`settings.themeStyle${style[0]!.toUpperCase()}${style.slice(1)}Desc` as any)}
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="stitle">{t("settings.typographySection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.fontScale")}</div>
            <div className="h">{t("settings.fontScaleHint")}</div>
          </div>
          <div className="seg-ctrl">
            <button
              type="button"
              data-on={fontScale === FONT_SCALE.SMALL}
              onClick={() => onSetFontScale(FONT_SCALE.SMALL)}
            >
              {t("settings.fontScaleSmall")}
            </button>
            <button
              type="button"
              data-on={fontScale === FONT_SCALE.MEDIUM}
              onClick={() => onSetFontScale(FONT_SCALE.MEDIUM)}
            >
              {t("settings.fontScaleMedium")}
            </button>
            <button
              type="button"
              data-on={fontScale === FONT_SCALE.LARGE}
              onClick={() => onSetFontScale(FONT_SCALE.LARGE)}
            >
              {t("settings.fontScaleLarge")}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.fontFamily")}</div>
            <div className="h">{t("settings.fontFamilyHint")}</div>
          </div>
          <div className="seg-ctrl">
            <button
              type="button"
              data-on={fontFamily === FONT_FAMILY.SANS}
              onClick={() => onSetFontFamily(FONT_FAMILY.SANS)}
            >
              {t("settings.fontFamilySans")}
            </button>
            <button
              type="button"
              data-on={fontFamily === FONT_FAMILY.SYSTEM}
              onClick={() => onSetFontFamily(FONT_FAMILY.SYSTEM)}
            >
              {t("settings.fontFamilySystem")}
            </button>
            <button
              type="button"
              data-on={fontFamily === FONT_FAMILY.SERIF}
              onClick={() => onSetFontFamily(FONT_FAMILY.SERIF)}
            >
              {t("settings.fontFamilySerif")}
            </button>
            <button
              type="button"
              data-on={fontFamily === FONT_FAMILY.CUSTOM}
              onClick={() => onSetFontFamily(FONT_FAMILY.CUSTOM)}
            >
              {t("settings.fontFamilyCustom")}
            </button>
          </div>
        </div>
        {fontFamily === FONT_FAMILY.CUSTOM ? (
          <div className="setting-row">
            <div className="l">
              <div className="n">{t("settings.customFontFamily")}</div>
              <div className="h">{t("settings.customFontFamilyHint")}</div>
            </div>
            <input
              className="field font-family-field"
              value={customFontDraft}
              placeholder={`"Microsoft YaHei", "PingFang SC", sans-serif`}
              onChange={(e) => {
                setCustomFontDraft(e.target.value);
                onSetCustomFontFamily(e.target.value);
              }}
              onBlur={(e) => commitCustomFont(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </div>
        ) : null}
      </section>
    </>
  );
}

const SEARCH_ENGINE_API_KEY_FIELDS: ReadonlyArray<{
  engine: "metaso" | "baidu" | "tavily" | "perplexity" | "exa" | "brave" | "ollama";
  patchKey:
    | "metasoApiKey"
    | "baiduApiKey"
    | "tavilyApiKey"
    | "perplexityApiKey"
    | "exaApiKey"
    | "braveApiKey"
    | "ollamaApiKey";
  signupUrl: string;
}> = [
  {
    engine: "metaso",
    patchKey: "metasoApiKey",
    signupUrl: "https://metaso.cn/settings/api",
  },
  {
    engine: "baidu",
    patchKey: "baiduApiKey",
    signupUrl: "https://cloud.baidu.com/doc/qianfan/s/2mh4su4uy",
  },
  {
    engine: "tavily",
    patchKey: "tavilyApiKey",
    signupUrl: "https://app.tavily.com",
  },
  {
    engine: "perplexity",
    patchKey: "perplexityApiKey",
    signupUrl: "https://www.perplexity.ai/settings/api",
  },
  {
    engine: "exa",
    patchKey: "exaApiKey",
    signupUrl: "https://dashboard.exa.ai/api-keys",
  },
  {
    engine: "brave",
    patchKey: "braveApiKey",
    signupUrl: "https://brave.com/search/api/",
  },
  {
    engine: "ollama",
    patchKey: "ollamaApiKey",
    signupUrl: "https://ollama.com/settings/keys",
  },
];

function WebSearchEngineCredentials({
  settings,
  onSave,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
}) {
  const engine = settings.webSearchEngine ?? "bing";
  if (engine === "bing" || engine === "bing-intl") return null;
  if (engine === "searxng") {
    return <SearxngEndpointRow settings={settings} onSave={onSave} />;
  }
  const field = SEARCH_ENGINE_API_KEY_FIELDS.find((f) => f.engine === engine);
  if (!field) return null;
  const prefix = settings.webSearchApiKeys?.[engine];
  return (
    <WebSearchApiKeyRow
      engine={engine}
      patchKey={field.patchKey}
      signupUrl={field.signupUrl}
      prefix={prefix}
      onSave={onSave}
    />
  );
}

function SearxngEndpointRow({
  settings,
  onSave,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
}) {
  const [draft, setDraft] = useState(settings.webSearchEndpoint ?? "");
  useEffect(() => {
    setDraft(settings.webSearchEndpoint ?? "");
  }, [settings.webSearchEndpoint]);
  return (
    <div className="setting-row">
      <div className="l">
        <div className="n">{t("settings.webSearchEndpoint")}</div>
        <div className="h">{t("settings.webSearchEndpointHint")}</div>
      </div>
      <input
        className="field mono"
        value={draft}
        placeholder="http://localhost:8080"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next === (settings.webSearchEndpoint ?? "")) return;
          onSave({ webSearchEndpoint: next || null });
        }}
      />
    </div>
  );
}

function WebSearchApiKeyRow({
  engine,
  patchKey,
  signupUrl,
  prefix,
  onSave,
}: {
  engine: "metaso" | "baidu" | "tavily" | "perplexity" | "exa" | "brave" | "ollama";
  patchKey:
    | "metasoApiKey"
    | "baiduApiKey"
    | "tavilyApiKey"
    | "perplexityApiKey"
    | "exaApiKey"
    | "braveApiKey"
    | "ollamaApiKey";
  signupUrl: string;
  prefix?: string;
  onSave: (patch: SettingsPatch) => void;
}) {
  const [draft, setDraft] = useState("");
  const label = t(`settings.webSearchApiKey.${engine}` as const);
  return (
    <div className="setting-row">
      <div className="l">
        <div className="n">{label}</div>
        <div className="h">
          {prefix ? t("settings.apiKeySet", { prefix }) : t("settings.apiKeyNotSet")}{" "}
          <a
            href={signupUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault();
              void openUrl(signupUrl).catch(() => undefined);
            }}
          >
            {t("settings.webSearchApiKeySignup")}
          </a>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="field mono"
          type="password"
          value={draft}
          placeholder={prefix ?? ""}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          className="btn primary"
          disabled={!draft.trim()}
          onClick={() => {
            const trimmed = draft.trim();
            if (!trimmed) return;
            onSave({ [patchKey]: trimmed } as SettingsPatch);
            setDraft("");
          }}
        >
          {t("settings.apiKeySave")}
        </button>
        {prefix ? (
          <button
            type="button"
            className="btn"
            onClick={() => onSave({ [patchKey]: null } as SettingsPatch)}
          >
            {t("settings.webSearchApiKeyClear")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ApiKeySection({
  baseUrl,
  apiKeyPrefix,
  onSave,
  onSaveApiKey,
  onSignOutApiKey,
}: {
  baseUrl?: string;
  apiKeyPrefix?: string;
  onSave: (patch: SettingsPatch) => void;
  onSaveApiKey: (key: string) => void;
  onSignOutApiKey: () => void;
}) {
  const [key, setKey] = useState("");
  const [urlDraft, setUrlDraft] = useState(baseUrl ?? "");
  return (
    <section className="section">
      <div className="stitle">{t("settings.apiSection")}</div>
      <div className="setting-row">
        <div className="l">
          <div className="n">{t("settings.apiKey")}</div>
          <div className="h">
            {apiKeyPrefix
              ? t("settings.apiKeySet", { prefix: apiKeyPrefix })
              : t("settings.apiKeyNotSet")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="field mono"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-…"
          />
          <button
            type="button"
            className="btn primary"
            disabled={!key}
            onClick={() => {
              if (!key) return;
              onSaveApiKey(key);
              setKey("");
            }}
          >
            {t("settings.apiKeySave")}
          </button>
          {apiKeyPrefix ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setKey("");
                onSignOutApiKey();
              }}
            >
              {t("settings.apiKeySignOut")}
            </button>
          ) : null}
        </div>
      </div>
      <div className="setting-row">
        <div className="l">
          <div className="n">{t("settings.baseUrl")}</div>
          <div className="h">{t("settings.baseUrlHint")}</div>
        </div>
        <input
          className="field mono"
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onBlur={() => onSave({ baseUrl: urlDraft.trim() })}
        />
      </div>
    </section>
  );
}

const KNOWN_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

const EFFORT_VALUES = ["low", "medium", "high", "max"] as const;
type EffortValue = (typeof EFFORT_VALUES)[number];

function PageModels({
  settings,
  onSave,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
}) {
  const [draft, setDraft] = useState(settings.model);
  useEffect(() => setDraft(settings.model), [settings.model]);
  const isKnown = (KNOWN_MODELS as readonly string[]).includes(settings.model);
  return (
    <>
      <section className="section">
        <div className="stitle">{t("settings.defaultModelCurrent", { model: settings.model })}</div>
        <div className="model-grid">
          {KNOWN_MODELS.map((id) => (
            <div
              key={id}
              className="mcard"
              data-on={settings.model === id}
              onClick={() => onSave({ model: id })}
            >
              <div className="nm">{id}</div>
            </div>
          ))}
        </div>
        <div className="setting-row" style={{ marginTop: 12 }}>
          <div className="l">
            <div className="n">{t("settings.modelCustom")}</div>
            <div className="h">{t("settings.modelCustomHint")}</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="field mono"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="deepseek-v4-flash"
            />
            <button
              type="button"
              className="btn primary"
              disabled={!draft.trim() || draft.trim() === settings.model}
              onClick={() => onSave({ model: draft.trim() })}
            >
              {t("settings.apiKeySave")}
            </button>
          </div>
        </div>
        {!isKnown ? (
          <div className="h" style={{ marginTop: 6 }}>
            {t("settings.modelCustomActive", { model: settings.model })}
          </div>
        ) : null}
        <div className="setting-row" style={{ marginTop: 12 }}>
          <div className="l">
            <div className="n">{t("settings.contextTokensLabel")}</div>
            <div className="h">{t("settings.contextTokensHint")}</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="field mono"
              type="number"
              min={1}
              value={settings.contextTokens?.[settings.model] ?? ""}
              onChange={(e) => {
                const raw = e.target.value.trim();
                const num = raw ? Number.parseInt(raw, 10) : 0;
                const next = { ...(settings.contextTokens ?? {}) };
                if (num > 0 && Number.isFinite(num)) {
                  next[settings.model] = num;
                } else {
                  delete next[settings.model];
                }
                onSave({
                  contextTokens: Object.keys(next).length > 0 ? next : undefined,
                });
              }}
              placeholder={t("settings.contextTokensPlaceholder")}
            />
          </div>
        </div>
      </section>
      <section className="section">
        <div className="stitle">{t("settings.effortSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.reasoningEffort")}</div>
            <div className="h">{t("settings.reasoningEffortHint")}</div>
          </div>
          <div className="seg-ctrl">
            {EFFORT_VALUES.map((e) => (
              <button
                type="button"
                key={e}
                data-on={settings.reasoningEffort === e}
                onClick={() => onSave({ reasoningEffort: e as EffortValue })}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function PageMCP({
  specs,
  bridged,
  onAdd,
  onRemove,
  onEnable,
  onDisable,
  onReconnect,
}: {
  specs: McpSpecInfo[];
  bridged: boolean;
  onAdd: (spec: string) => void;
  onRemove: (spec: string) => void;
  onEnable: (name: string) => void;
  onDisable: (name: string) => void;
  onReconnect: () => void;
}) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    const v = draft.trim();
    if (!v) return;
    onAdd(v);
    setDraft("");
  };
  const statusLabel = (status: McpSpecInfo["status"]) => t(`settings.mcpStatus.${status}` as const);
  return (
    <>
      <section className="section">
        <div className="settings-toolbar">
          <div>
            <div className="stitle">{t("settings.mcpConfigured", { count: specs.length })}</div>
            <div className="h">
              {bridged ? t("settings.mcpBridged") : t("settings.mcpNotBridged")}
            </div>
          </div>
          <button type="button" className="btn ghost" onClick={onReconnect}>
            <I.rotate size={12} />
            <span>{t("settings.mcpReconnect")}</span>
          </button>
        </div>
        {specs.length === 0 ? (
          <div className="muted-card">{t("settings.mcpEmpty")}</div>
        ) : (
          specs.map((s) => {
            const canToggle = Boolean(s.name) && !s.parseError;
            const disabled = s.status === "disabled";
            return (
              <div className="scard mcp-config-card" key={s.raw}>
                <div className="top">
                  <span className="ico">
                    <I.wrench size={14} />
                  </span>
                  <div className="mcp-spec-body">
                    <div className="nm">{s.name ?? "(anonymous)"}</div>
                    <div className="sub mcp-spec-summary" title={s.summary}>
                      {s.summary}
                    </div>
                  </div>
                  <span className="status-pill" data-status={s.status}>
                    {statusLabel(s.status)}
                  </span>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={!canToggle}
                    title={disabled ? t("settings.mcpEnable") : t("settings.mcpDisable")}
                    onClick={() => {
                      if (!s.name) return;
                      disabled ? onEnable(s.name) : onDisable(s.name);
                    }}
                  >
                    {disabled ? <I.play size={12} /> : <I.stop size={12} />}
                    <span>{disabled ? t("settings.mcpEnable") : t("settings.mcpDisable")}</span>
                  </button>
                  <button
                    type="button"
                    className="btn ghost mcp-remove"
                    title={t("settings.mcpRemove")}
                    onClick={() => onRemove(s.raw)}
                  >
                    <I.trash size={12} />
                  </button>
                </div>
                {s.parseError ? (
                  <div className="desc" style={{ color: "var(--danger)" }}>
                    {t("settings.parseError", { error: s.parseError })}
                  </div>
                ) : null}
                {s.statusReason ? <div className="desc">{s.statusReason}</div> : null}
              </div>
            );
          })
        )}
      </section>
      <section className="section">
        <div className="stitle">{t("settings.mcpAddSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.mcpSpecLabel")}</div>
            <div className="h" dangerouslySetInnerHTML={{ __html: t("settings.mcpSpecFormat") }} />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="field mono"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="github=npx -y @smithery/cli ..."
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            <button type="button" className="btn primary" disabled={!draft.trim()} onClick={submit}>
              <I.plus size={12} />
              {t("settings.mcpAdd")}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

function PageSkills({
  settings,
  skills,
  roots,
  subagentModels,
  onAddPath,
  onRemovePath,
  onCreate,
  onSetModel,
  onSaveSettings,
}: {
  settings: SettingsType;
  skills: SkillInfo[];
  roots: SkillRootInfo[];
  subagentModels: Record<string, "flash" | "pro">;
  onAddPath: (path: string) => void;
  onRemovePath: (path: string) => void;
  onCreate: (name: string, scope: "project" | "global") => void;
  onSetModel: (name: string, model: "flash" | "pro" | null) => void;
  onSaveSettings: (patch: SettingsPatch) => void;
}) {
  const [pathDraft, setPathDraft] = useState("");
  const [sourceDraft, setSourceDraft] = useState("");
  const [skillName, setSkillName] = useState("");
  const [scope, setScope] = useState<"project" | "global">("project");
  const sources = settings.skillPackSources ?? [];
  const sourceIdForUrl = (url: string): string => {
    try {
      const host = new URL(url).hostname.split(".").filter(Boolean)[0] ?? "source";
      return host.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "source";
    } catch {
      return "source";
    }
  };
  const uniqueSourceId = (base: string): string => {
    const used = new Set(sources.map((source) => source.id));
    if (!used.has(base)) return base;
    for (let index = 2; ; index++) {
      const next = `${base}-${index}`;
      if (!used.has(next)) return next;
    }
  };
  const addSource = () => {
    const url = sourceDraft.trim();
    if (!url) return;
    if (sources.some((source) => source.url === url)) {
      setSourceDraft("");
      return;
    }
    const id = uniqueSourceId(sourceIdForUrl(url));
    const next: SkillPackSourceInfo = { id, name: id, url, trusted: false };
    onSaveSettings({ skillPackSources: [...sources, next] });
    setSourceDraft("");
  };
  const removeSource = (id: string) => {
    onSaveSettings({ skillPackSources: sources.filter((source) => source.id !== id) });
  };
  const addPath = () => {
    const next = pathDraft.trim();
    if (!next) return;
    onAddPath(next);
    setPathDraft("");
  };
  const create = () => {
    const next = skillName.trim();
    if (!next) return;
    onCreate(next, scope);
    setSkillName("");
  };
  return (
    <>
      <section className="section">
        <div className="stitle">{t("settings.skillPackSources")}</div>
        <div className="inline-form">
          <input
            className="field mono"
            value={sourceDraft}
            onChange={(e) => setSourceDraft(e.target.value)}
            placeholder="https://example.com/skill-packs.json"
            onKeyDown={(e) => {
              if (e.key === "Enter") addSource();
            }}
          />
          <button
            type="button"
            className="btn primary"
            disabled={!sourceDraft.trim()}
            onClick={addSource}
          >
            <I.plus size={12} />
            <span>{t("settings.skillPackSourceAdd")}</span>
          </button>
        </div>
        {sources.length === 0 ? (
          <div className="muted-card">{t("settings.skillPackSourcesDefault")}</div>
        ) : (
          <div className="skill-root-grid">
            {sources.map((source) => (
              <div className="scard skill-root" key={source.id}>
                <div className="top">
                  <span className="ico">
                    <I.zap size={14} />
                  </span>
                  <div className="mcp-spec-body">
                    <div className="nm">{source.name}</div>
                    <div className="sub mcp-spec-summary" title={source.url}>
                      {source.url}
                    </div>
                  </div>
                  <span
                    className="status-pill"
                    data-status={source.trusted ? "connected" : "configured"}
                  >
                    {source.trusted
                      ? t("settings.skillPackSourceTrusted")
                      : t("settings.skillPackSourceThirdParty")}
                  </span>
                  <button
                    type="button"
                    className="btn ghost mcp-remove"
                    title={t("settings.skillPackSourceRemove")}
                    onClick={() => removeSource(source.id)}
                  >
                    <I.trash size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="section">
        <div className="stitle">{t("settings.skillRoots")}</div>
        <div className="inline-form">
          <input
            className="field mono"
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            placeholder="~/jupiter-skills"
            onKeyDown={(e) => {
              if (e.key === "Enter") addPath();
            }}
          />
          <button
            type="button"
            className="btn primary"
            disabled={!pathDraft.trim()}
            onClick={addPath}
          >
            <I.plus size={12} />
            <span>{t("settings.skillPathAdd")}</span>
          </button>
        </div>
        <div className="skill-root-grid">
          {roots.map((root) => (
            <div className="scard skill-root" key={`${root.scope}:${root.dir}`}>
              <div className="top">
                <span className="ico">
                  <I.folder size={14} />
                </span>
                <div className="mcp-spec-body">
                  <div className="nm">{root.scope}</div>
                  <div className="sub mcp-spec-summary" title={root.dir}>
                    {root.dir}
                  </div>
                </div>
                <span
                  className="status-pill"
                  data-status={root.status === "ok" ? "connected" : "failed"}
                >
                  {root.status}
                </span>
                {root.scope === "custom" ? (
                  <button
                    type="button"
                    className="btn ghost mcp-remove"
                    title={t("settings.skillPathRemove")}
                    onClick={() => onRemovePath(root.dir)}
                  >
                    <I.trash size={12} />
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="section">
        <div className="stitle">{t("settings.skillCreate")}</div>
        <div className="inline-form">
          <input
            className="field mono"
            value={skillName}
            onChange={(e) => setSkillName(e.target.value)}
            placeholder="jupiter-review"
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
          />
          <select
            className="field"
            value={scope}
            onChange={(e) => setScope(e.target.value as "project" | "global")}
          >
            <option value="project">{t("settings.skillScopeProject")}</option>
            <option value="global">{t("settings.skillScopeGlobal")}</option>
          </select>
          <button
            type="button"
            className="btn primary"
            disabled={!skillName.trim()}
            onClick={create}
          >
            <I.plus size={12} />
            <span>{t("settings.skillCreateAction")}</span>
          </button>
        </div>
      </section>
      <section className="section">
        <div className="stitle">{t("settings.skillsLoaded", { count: skills.length })}</div>
        {skills.length === 0 ? (
          <div className="muted-card">{t("settings.skillsEmpty")}</div>
        ) : (
          skills.map((s) => (
            <div className="scard" key={`${s.scope}:${s.name}`}>
              <div className="top">
                <span className="ico">
                  <I.zap size={14} />
                </span>
                <div className="mcp-spec-body">
                  <div className="nm">
                    <span className="slash-name">/{s.name}</span>
                  </div>
                  <div className="sub">
                    {s.scope} · {s.runAs}
                    {s.model ? ` · ${s.model}` : ""}
                  </div>
                </div>
                {s.runAs === "subagent" ? (
                  <select
                    className="field"
                    style={{ marginLeft: "auto", minWidth: 118 }}
                    value={subagentModels[s.name] ?? ""}
                    onChange={(e) => {
                      const value = e.target.value;
                      onSetModel(s.name, value === "" ? null : (value as "flash" | "pro"));
                    }}
                    title={t("settings.subagentModelHint")}
                  >
                    <option value="">{t("settings.subagentModelDefault")}</option>
                    <option value="flash">{t("settings.subagentModelFlash")}</option>
                    <option value="pro">{t("settings.subagentModelPro")}</option>
                  </select>
                ) : null}
              </div>
              <div className="desc">{s.description}</div>
              <div className="mono-path">{s.path}</div>
            </div>
          ))
        )}
      </section>
    </>
  );
}

function PageArchives({
  sessions,
  onRefresh,
  onRestore,
  onDelete,
}: {
  sessions: SessionInfo[];
  onRefresh: () => void;
  onRestore: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const sorted = [...sessions].sort((a, b) => {
    const aTime = a.archivedAt ?? Date.parse(a.mtime);
    const bTime = b.archivedAt ?? Date.parse(b.mtime);
    return bTime - aTime;
  });
  return (
    <section className="section">
      <div className="setting-row">
        <div className="l">
          <div className="n">{t("settings.archivesTitle")}</div>
          <div className="h">{t("settings.archivesHint")}</div>
        </div>
        <button type="button" className="btn" onClick={onRefresh}>
          <I.refresh size={12} />
          <span>{t("settings.archivesRefresh")}</span>
        </button>
      </div>
      {sorted.length === 0 ? (
        <div className="muted-card">{t("settings.archivesEmpty")}</div>
      ) : (
        <div className="settings-archive-list">
          {sorted.map((session) => {
            const title = session.summary?.trim() || session.name.replace(/^desktop-/, "");
            const when = session.archivedAt
              ? new Date(session.archivedAt).toLocaleString()
              : new Date(session.mtime).toLocaleString();
            return (
              <div className="settings-archive-card" key={session.name}>
                <div className="archive-main">
                  <div className="archive-title">{title}</div>
                  <div className="archive-meta">
                    <span>{when}</span>
                    {session.workspace ? (
                      <span>{displayWorkspacePath(session.workspace, session.workspace)}</span>
                    ) : null}
                  </div>
                  <div className="archive-id">{session.name}</div>
                </div>
                <div className="archive-actions">
                  <button type="button" className="btn" onClick={() => onRestore(session.name)}>
                    {t("settings.archivesRestore")}
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    onClick={() => onDelete(session.name)}
                  >
                    {t("settings.archivesDelete")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PageMemory({
  settings,
  entries,
  detail,
  onRead,
  onRefresh,
  onDelete,
  onSave,
  onSaveSettings,
}: {
  settings: SettingsType;
  entries: MemoryEntryInfo[];
  detail: MemoryDetail | null;
  onRead: (path: string) => void;
  onRefresh: () => void;
  onDelete: (path: string) => void;
  onSave: (input: MemoryWriteInput) => void;
  onSaveSettings: (patch: SettingsPatch) => void;
}) {
  type MemoryDraft = {
    name: string;
    scope: "project" | "global";
    type: string;
    description: string;
    body: string;
    priority: "" | "low" | "medium" | "high";
    expires: "" | "project_end";
  };
  const emptyDraft: MemoryDraft = {
    name: "",
    scope: "project",
    type: "user",
    description: "",
    body: "",
    priority: "",
    expires: "",
  };
  const [draft, setDraft] = useState(emptyDraft);
  const [editingPath, setEditingPath] = useState<string | undefined>();
  const [editorOpen, setEditorOpen] = useState(false);
  const openNewDraft = () => {
    setDraft(emptyDraft);
    setEditingPath(undefined);
    setEditorOpen(true);
  };
  const openEditDraft = () => {
    if (!detail || detail.kind !== "structured") return;
    setDraft({
      name: detail.name,
      scope: detail.scope,
      type: detail.type ?? "user",
      description: detail.description,
      body: detail.body,
      priority: detail.priority ?? "",
      expires: detail.expires ?? "",
    });
    setEditingPath(detail.path);
    setEditorOpen(true);
  };
  const closeEditor = () => {
    setEditorOpen(false);
  };
  const submitDraft = () => {
    const input: MemoryWriteInput = {
      name: draft.name.trim(),
      scope: draft.scope,
      type: draft.type.trim() || "user",
      description: draft.description.trim(),
      body: draft.body.trim(),
    };
    if (editingPath) input.path = editingPath;
    if (draft.priority) input.priority = draft.priority;
    if (draft.expires) input.expires = draft.expires;
    onSave(input);
    setEditorOpen(false);
  };
  const groups = [
    {
      key: "project",
      title: t("settings.memoryProjectRules"),
      desc: t("settings.memoryProjectRulesDesc"),
      entries: entries.filter((entry) => entry.kind === "project_file"),
    },
    {
      key: "global",
      title: t("settings.memoryGlobalRules"),
      desc: t("settings.memoryGlobalRulesDesc"),
      entries: entries.filter((entry) => entry.kind === "global_file"),
    },
    {
      key: "structured",
      title: t("settings.memoryLongTerm"),
      desc: t("settings.memoryLongTermDesc"),
      entries: entries.filter((entry) => entry.kind === "structured"),
    },
  ];
  const globalMemoryOn = settings.memoryGlobalEnabled !== false;
  const confirmMemoryWritesOn = settings.memoryConfirmWrites === true;
  return (
    <section className="section">
      <div className="memory-settings">
        <div className="setting-row memory-switch-row">
          <span className="l">
            <span className="n">{t("settings.memoryGlobalEnabled")}</span>
            <span className="h">{t("settings.memoryGlobalRulesDesc")}</span>
          </span>
          <div className="seg-ctrl" role="group" aria-label={t("settings.memoryGlobalEnabled")}>
            <button
              type="button"
              data-on={globalMemoryOn}
              onClick={() => onSaveSettings({ memoryGlobalEnabled: true })}
            >
              {t("settings.enabled")}
            </button>
            <button
              type="button"
              data-on={!globalMemoryOn}
              onClick={() => onSaveSettings({ memoryGlobalEnabled: false })}
            >
              {t("settings.disabled")}
            </button>
          </div>
        </div>
        <div className="setting-row memory-switch-row">
          <span className="l">
            <span className="n">{t("settings.memoryConfirmWrites")}</span>
            <span className="h">{t("settings.memoryLongTermDesc")}</span>
          </span>
          <div className="seg-ctrl" role="group" aria-label={t("settings.memoryConfirmWrites")}>
            <button
              type="button"
              data-on={confirmMemoryWritesOn}
              onClick={() => onSaveSettings({ memoryConfirmWrites: true })}
            >
              {t("settings.enabled")}
            </button>
            <button
              type="button"
              data-on={!confirmMemoryWritesOn}
              onClick={() => onSaveSettings({ memoryConfirmWrites: false })}
            >
              {t("settings.disabled")}
            </button>
          </div>
        </div>
      </div>
      <div className="memory-toolbar">
        <div>
          <div className="stitle">{t("settings.memorySection")}</div>
          <div className="section-hint">{t("settings.memoryEffectHint")}</div>
        </div>
        <div className="memory-toolbar-actions">
          <button type="button" className="ghost-btn" onClick={openNewDraft}>
            <I.plus size={13} />
            {t("settings.memoryNew")}
          </button>
          <button type="button" className="ghost-btn" onClick={onRefresh}>
            <I.refresh size={13} />
            {t("settings.memoryRefresh")}
          </button>
        </div>
      </div>
      <div className="memory-browser">
        <div className="memory-list">
          {groups.map((group) => (
            <div className="memory-group" key={group.key}>
              <div className="memory-group-head">
                <div className="memory-group-title">{group.title}</div>
                <div className="memory-group-desc">{group.desc}</div>
              </div>
              {group.entries.length === 0 ? (
                <div className="memory-empty">{t("settings.memoryEmptyGroup")}</div>
              ) : (
                group.entries.map((m) => {
                  const label = m.description || m.name;
                  return (
                    <div className="memory-item" data-active={detail?.path === m.path} key={m.path}>
                      <button type="button" className="memory-read" onClick={() => onRead(m.path)}>
                        <span className="memory-kind">
                          {m.scope} / {m.type ?? m.kind.replace("_", " ")}
                        </span>
                        <span className="memory-name">{label}</span>
                        {m.priority || m.expires ? (
                          <span className="memory-badges">
                            {m.priority ? (
                              <span className="memory-badge">
                                {t(`settings.memoryPriority_${m.priority}`)}
                              </span>
                            ) : null}
                            {m.expires ? (
                              <span className="memory-badge">
                                {t("settings.memoryExpiresProjectEnd")}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                        <span className="memory-path">{m.path}</span>
                      </button>
                      <button
                        type="button"
                        className="memory-delete"
                        aria-label={t("settings.memoryDeleteLabel", {
                          name: label,
                        })}
                        title={t("settings.memoryDeleteLabel", { name: label })}
                        onClick={() => onDelete(m.path)}
                      >
                        <I.trash size={13} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          ))}
        </div>
        <div className="memory-detail-panel">
          {detail ? (
            <>
              <div className="memory-detail-head">
                <div>
                  <div className="memory-detail-title">{detail.description || detail.name}</div>
                  <div className="memory-detail-meta">
                    {detail.scope} / {detail.type ?? detail.kind.replace("_", " ")}
                  </div>
                </div>
                {detail.kind === "structured" ? (
                  <button type="button" className="ghost-btn" onClick={openEditDraft}>
                    {t("settings.memoryEdit")}
                  </button>
                ) : null}
              </div>
              <pre className="memory-detail">{detail.body}</pre>
            </>
          ) : (
            <div className="memory-detail-placeholder">{t("settings.memoryDetailPlaceholder")}</div>
          )}
          {editorOpen ? (
            <div
              className="memory-editor-drawer"
              role="dialog"
              aria-label={t("settings.memoryEditorTitle")}
            >
              <div className="memory-editor-head">
                <div>
                  <div className="memory-editor-title">
                    {editingPath
                      ? t("settings.memoryEditStructured")
                      : t("settings.memoryNewStructured")}
                  </div>
                  <div className="memory-editor-desc">{t("settings.memoryStructuredHint")}</div>
                </div>
                <button
                  type="button"
                  className="memory-icon-btn"
                  aria-label={t("settings.memoryEditorClose")}
                  onClick={closeEditor}
                >
                  <I.x size={13} />
                </button>
              </div>
              <div className="memory-form-stack">
                <label className="memory-field">
                  <span>{t("settings.memoryNameLabel")}</span>
                  <input
                    className="field"
                    value={draft.name}
                    onChange={(e) => setDraft((v) => ({ ...v, name: e.target.value }))}
                  />
                </label>
                <div className="memory-inline-fields">
                  <label className="memory-field">
                    <span>{t("settings.memoryScopeLabel")}</span>
                    <select
                      className="field"
                      value={draft.scope}
                      onChange={(e) =>
                        setDraft((v) => ({
                          ...v,
                          scope: e.target.value as "project" | "global",
                        }))
                      }
                    >
                      <option value="project">{t("settings.memoryScopeProject")}</option>
                      <option value="global">{t("settings.memoryScopeGlobal")}</option>
                    </select>
                  </label>
                  <label className="memory-field">
                    <span>{t("settings.memoryTypeLabel")}</span>
                    <select
                      className="field"
                      value={draft.type}
                      onChange={(e) => setDraft((v) => ({ ...v, type: e.target.value }))}
                    >
                      <option value="user">{t("settings.memoryTypeUser")}</option>
                      <option value="feedback">{t("settings.memoryTypeFeedback")}</option>
                      <option value="project">{t("settings.memoryTypeProject")}</option>
                      <option value="reference">{t("settings.memoryTypeReference")}</option>
                    </select>
                  </label>
                </div>
                <div className="memory-inline-fields">
                  <label className="memory-field">
                    <span>{t("settings.memoryPriorityLabel")}</span>
                    <select
                      className="field"
                      value={draft.priority}
                      onChange={(e) =>
                        setDraft((v) => ({
                          ...v,
                          priority: e.target.value as "" | "low" | "medium" | "high",
                        }))
                      }
                    >
                      <option value="">{t("settings.memoryPriorityDefault")}</option>
                      <option value="low">{t("settings.memoryPriority_low")}</option>
                      <option value="medium">{t("settings.memoryPriority_medium")}</option>
                      <option value="high">{t("settings.memoryPriority_high")}</option>
                    </select>
                  </label>
                  <label className="memory-field">
                    <span>{t("settings.memoryExpiresLabel")}</span>
                    <select
                      className="field"
                      value={draft.expires}
                      onChange={(e) =>
                        setDraft((v) => ({
                          ...v,
                          expires: e.target.value as "" | "project_end",
                        }))
                      }
                    >
                      <option value="">{t("settings.memoryExpiresNone")}</option>
                      <option value="project_end">{t("settings.memoryExpiresProjectEnd")}</option>
                    </select>
                  </label>
                </div>
                <label className="memory-field">
                  <span>{t("settings.memoryDescriptionLabel")}</span>
                  <input
                    className="field"
                    value={draft.description}
                    onChange={(e) =>
                      setDraft((v) => ({
                        ...v,
                        description: e.target.value,
                      }))
                    }
                  />
                </label>
                <label className="memory-field">
                  <span>{t("settings.memoryBodyLabel")}</span>
                  <textarea
                    className="field memory-body-field"
                    value={draft.body}
                    onChange={(e) => setDraft((v) => ({ ...v, body: e.target.value }))}
                  />
                </label>
              </div>
              <div className="memory-editor-actions">
                <button type="button" className="ghost-btn" onClick={closeEditor}>
                  {t("settings.memoryCancel")}
                </button>
                <button type="button" className="primary-btn" onClick={submitDraft}>
                  {t("settings.memorySave")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function PageRules({
  settings,
  onSave,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
}) {
  return (
    <>
      <section className="section">
        <div className="stitle">{t("settings.editMode")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.appMode")}</div>
            <div className="h">{t("settings.editModeHint")}</div>
          </div>
          <div className="seg-ctrl">
            {(["review", "auto", "yolo"] as const).map((m) => (
              <button
                type="button"
                key={m}
                data-on={settings.editMode === m}
                onClick={() => onSave({ editMode: m })}
              >
                {t(`editMode.${m}` as any)}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="section">
        <div className="stitle">{t("settings.ruleAutoApprovalSection")}</div>
        <div
          style={{
            padding: 12,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 12,
            color: "var(--muted)",
          }}
        >
          {t("settings.ruleAutoApprovalHint")}
        </div>
      </section>
    </>
  );
}

function PageBilling({
  balance,
  usage,
  currency,
}: {
  balance: Balance | null;
  usage: UsageStats;
  currency: "CNY" | "USD";
}) {
  const symbol = currency === "CNY" ? "¥" : "$";
  const sessionCost = currency === "CNY" ? usage.totalCostUsd * 7.2 : usage.totalCostUsd;
  const totalTokens = usage.cacheHitTokens + usage.cacheMissTokens;
  const hitPct = totalTokens > 0 ? Math.round((usage.cacheHitTokens / totalTokens) * 100) : 0;
  return (
    <>
      <div className="bill-grid">
        <div className="bill-card">
          <div className="l">{t("settings.balanceLabel")}</div>
          <div className="v ok">
            {balance
              ? `${balance.currency === "USD" ? "$" : "¥"} ${balance.total.toFixed(2)}`
              : "—"}
          </div>
          <div className="sub">
            {balance && !balance.isAvailable
              ? t("settings.balanceLow")
              : t("settings.balanceAvailable")}
          </div>
        </div>
        <div className="bill-card">
          <div className="l">{t("settings.sessionCost")}</div>
          <div className="v">
            {symbol} {sessionCost.toFixed(4)}
          </div>
          <div className="sub">prompt {usage.totalPromptTokens.toLocaleString()} t</div>
        </div>
        <div className="bill-card">
          <div className="l">{t("settings.cacheHitRate")}</div>
          <div className="v acc">{hitPct}%</div>
          <div className="sub">
            hit {usage.cacheHitTokens.toLocaleString()} / miss{" "}
            {usage.cacheMissTokens.toLocaleString()}
          </div>
        </div>
      </div>
    </>
  );
}

function PageShortcuts() {
  const rows: { nm: string; keys: ShortcutKey[] }[] = [
    { nm: t("settings.shortcutNewChat"), keys: ["mod", "N"] },
    { nm: t("settings.shortcutNewTab"), keys: ["mod", "T"] },
    { nm: t("settings.shortcutCloseTab"), keys: ["mod", "W"] },
    { nm: t("settings.shortcutCommandPalette"), keys: ["mod", "K"] },
    { nm: t("settings.shortcutFocusComposer"), keys: ["mod", "L"] },
    { nm: t("settings.shortcutSwitchTab"), keys: ["mod", "tab"] },
    { nm: t("settings.shortcutAbort"), keys: ["esc"] },
    { nm: t("settings.shortcutSettings"), keys: ["mod", ","] },
  ];
  return (
    <section className="section">
      <div className="kbd-grid">
        {rows.map((s, i) => (
          <SectionRow key={i} nm={s.nm} keys={s.keys} />
        ))}
      </div>
    </section>
  );
}

function SectionRow({
  nm,
  keys,
}: {
  nm: string;
  keys: ShortcutKey[];
}): ReactNode {
  return (
    <>
      <div className="nm">{nm}</div>
      <div className="keys">
        <Shortcut keys={keys} />
      </div>
    </>
  );
}
