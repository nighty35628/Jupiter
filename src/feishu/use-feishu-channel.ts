import { useCallback, useEffect, useMemo, useRef } from "react";
import { loadFeishuConfig, saveFeishuConfig } from "../config.js";
import { t } from "../i18n/index.js";
import { FeishuChannel } from "./channel.js";

interface FeishuLogger {
  pushInfo: (text: string) => void;
  pushWarning: (title: string, detail: string) => void;
}

interface UseFeishuChannelArgs {
  codeMode: boolean;
  initialChannel?: FeishuChannel;
  log: FeishuLogger;
  setQueuedSubmit: (text: string) => void;
  feishuSubmitRef?: { current: ((text: string) => void) | null };
  feishuErrorRef?: { current: ((msg: string) => void) | null };
}

function formatFeishuModeLabel(codeMode: boolean): string {
  return t(codeMode ? "handlers.feishu.modeCode" : "handlers.feishu.modeChat");
}

function parseMentionPolicy(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "all" || value === "false" || value === "0" || value === "no") return false;
  if (value === "mention" || value === "true" || value === "1" || value === "yes") return true;
  return fallback;
}

export function useFeishuChannel({
  codeMode,
  initialChannel,
  log,
  setQueuedSubmit,
  feishuSubmitRef,
  feishuErrorRef,
}: UseFeishuChannelArgs) {
  const channelRef = useRef<FeishuChannel | null>(initialChannel ?? null);
  const replyThisTurnRef = useRef(false);

  const sendText = useCallback(
    (message: string) => {
      channelRef.current?.sendResponse(message).catch((err) => {
        log.pushWarning("Feishu", `sendResponse error: ${(err as Error).message}`);
      });
    },
    [log],
  );

  const sendInfo = useCallback(
    (message: string) => {
      log.pushInfo(message);
      sendText(message);
    },
    [log, sendText],
  );

  const connect = useCallback(
    async (args: readonly string[]): Promise<string> => {
      const existing = loadFeishuConfig();
      const appId = args[0]?.trim() || existing.appId || "";
      const appSecret = args[1]?.trim() || existing.appSecret || "";
      const requireMentionInGroup = parseMentionPolicy(args[2], existing.requireMentionInGroup);

      if (!appId || !appSecret) {
        throw new Error(t("handlers.feishu.credentialsRequired"));
      }

      saveFeishuConfig({
        appId,
        appSecret,
        enabled: false,
        requireMentionInGroup,
      });

      if (channelRef.current) {
        saveFeishuConfig({
          appId,
          appSecret,
          enabled: true,
          requireMentionInGroup,
        });
        return t("handlers.feishu.alreadyConnected", {
          mode: formatFeishuModeLabel(codeMode),
        });
      }

      const channel = new FeishuChannel({
        onSubmitMessage: (message) => setQueuedSubmit(message),
        onError: (message) => log.pushWarning("Feishu", message),
        onInfo: (message) => log.pushInfo(message),
      });
      await channel.start();
      channelRef.current = channel;
      saveFeishuConfig({
        appId,
        appSecret,
        enabled: true,
        requireMentionInGroup,
      });
      return t("handlers.feishu.connected", {
        mode: formatFeishuModeLabel(codeMode),
      });
    },
    [codeMode, log, setQueuedSubmit],
  );

  const disconnect = useCallback(async (): Promise<string> => {
    const existing = loadFeishuConfig();
    const current = channelRef.current;
    channelRef.current = null;
    if (current) await current.stop();
    saveFeishuConfig({ ...existing, enabled: false });
    return t("handlers.feishu.disconnected");
  }, []);

  const status = useCallback((): string => {
    const config = loadFeishuConfig();
    const configured = config.appId && config.appSecret;
    const connected = !!channelRef.current;
    const appId = config.appId ? `${config.appId.slice(0, 6)}...` : t("handlers.feishu.none");
    const groupPolicy = config.requireMentionInGroup
      ? t("handlers.feishu.groupMention")
      : t("handlers.feishu.groupAll");
    return t("handlers.feishu.status", {
      connected: connected
        ? t("handlers.feishu.stateConnected")
        : t("handlers.feishu.stateDisconnected"),
      enabled: config.enabled
        ? t("handlers.feishu.stateEnabled")
        : t("handlers.feishu.stateDisabled"),
      configured: configured
        ? t("handlers.feishu.stateConfigured")
        : t("handlers.feishu.stateNotConfigured"),
      appId,
      groupPolicy,
      mode: formatFeishuModeLabel(codeMode),
    });
  }, [codeMode]);

  useEffect(() => {
    if (!feishuSubmitRef || !feishuErrorRef) return undefined;
    feishuSubmitRef.current = setQueuedSubmit;
    feishuErrorRef.current = (msg) => log.pushWarning("Feishu", msg);
    return () => {
      feishuSubmitRef.current = null;
      feishuErrorRef.current = null;
    };
  }, [feishuErrorRef, feishuSubmitRef, log, setQueuedSubmit]);

  const parseSubmit = useCallback((raw: string) => {
    let text = raw.trim();
    if (!text) return null;
    const fromFeishu = text.startsWith("[Feishu] ");
    if (fromFeishu) {
      text = text.slice(9).trimStart() || text;
    }
    return { handled: false, fromFeishu, text };
  }, []);

  const noteTurnFromFeishu = useCallback((fromFeishu: boolean) => {
    replyThisTurnRef.current = fromFeishu;
  }, []);

  const maybeSendFinalReply = useCallback(
    (lastAssistantText: string) => {
      if (channelRef.current && lastAssistantText && replyThisTurnRef.current) {
        channelRef.current.sendResponse(lastAssistantText).catch((err) => {
          log.pushWarning("Feishu", `sendResponse error: ${(err as Error).message}`);
        });
      }
    },
    [log],
  );

  const clearTurnReply = useCallback(() => {
    replyThisTurnRef.current = false;
  }, []);

  return useMemo(
    () => ({
      channelRef,
      connect,
      disconnect,
      status,
      sendInfo,
      sendText,
      parseSubmit,
      noteTurnFromFeishu,
      maybeSendFinalReply,
      clearTurnReply,
    }),
    [
      clearTurnReply,
      connect,
      disconnect,
      maybeSendFinalReply,
      noteTurnFromFeishu,
      parseSubmit,
      sendInfo,
      sendText,
      status,
    ],
  );
}
