import { t } from "./i18n";

export type FeishuRuntimeState = "disconnected" | "connecting" | "connected" | "failed";

export type FeishuDesktopSettingsState = {
  appId?: string;
  appSecret?: string;
  enabled: boolean;
  configured: boolean;
  requireMentionInGroup: boolean;
  runtimeState: FeishuRuntimeState;
  lastError?: string;
  appIdPreview?: string;
};

export function getFeishuConnectIntent(
  feishu: FeishuDesktopSettingsState,
): "configure" | "connect" {
  return feishu.configured ? "connect" : "configure";
}

export function getFeishuStatusLabel(feishu: FeishuDesktopSettingsState): string {
  if (feishu.runtimeState === "connected") return t("settings.feishuConnected");
  if (feishu.runtimeState === "connecting") return t("settings.feishuConnecting");
  if (feishu.runtimeState === "failed") return t("settings.feishuFailed");
  return feishu.enabled ? t("settings.feishuEnabled") : t("settings.feishuDisconnected");
}

export function describeFeishuRowSummary(feishu: FeishuDesktopSettingsState): string {
  if (!feishu.configured) return t("settings.feishuSummaryMissing");
  const appId = feishu.appIdPreview ?? feishu.appId ?? "";
  return t("settings.feishuSummaryDetail", {
    appId,
    mode: feishu.requireMentionInGroup
      ? t("settings.feishuGroupMentionRequired")
      : t("settings.feishuGroupAllMessages"),
  });
}
