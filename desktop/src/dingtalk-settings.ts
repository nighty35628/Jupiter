import { t } from "./i18n";

export type DingTalkRuntimeState = "disconnected" | "connecting" | "connected" | "failed";

export type DingTalkDesktopSettingsState = {
  clientId?: string;
  clientSecret?: string;
  enabled: boolean;
  configured: boolean;
  requireMentionInGroup: boolean;
  runtimeState: DingTalkRuntimeState;
  lastError?: string;
  clientIdPreview?: string;
};

export function getDingTalkConnectIntent(
  dingtalk: DingTalkDesktopSettingsState,
): "configure" | "connect" {
  return dingtalk.configured ? "connect" : "configure";
}

export function getDingTalkStatusLabel(dingtalk: DingTalkDesktopSettingsState): string {
  if (dingtalk.runtimeState === "connected") return t("settings.dingtalkConnected");
  if (dingtalk.runtimeState === "connecting") return t("settings.dingtalkConnecting");
  if (dingtalk.runtimeState === "failed") return t("settings.dingtalkFailed");
  return dingtalk.enabled ? t("settings.dingtalkEnabled") : t("settings.dingtalkDisconnected");
}

export function describeDingTalkRowSummary(dingtalk: DingTalkDesktopSettingsState): string {
  if (!dingtalk.configured) return t("settings.dingtalkSummaryMissing");
  const clientId = dingtalk.clientIdPreview ?? dingtalk.clientId ?? "";
  return t("settings.dingtalkSummaryDetail", {
    clientId,
    mode: dingtalk.requireMentionInGroup
      ? t("settings.dingtalkGroupMentionRequired")
      : t("settings.dingtalkGroupAllMessages"),
  });
}
