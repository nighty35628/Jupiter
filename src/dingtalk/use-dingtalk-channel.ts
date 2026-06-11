import { useCallback, useEffect, useMemo, useRef } from "react";
import { loadDingTalkConfig, saveDingTalkConfig } from "../config.js";
import { t } from "../i18n/index.js";
import { DingTalkChannel } from "./channel.js";

interface DingTalkLogger {
  pushInfo: (text: string) => void;
  pushWarning: (title: string, detail: string) => void;
}

interface UseDingTalkChannelArgs {
  codeMode: boolean;
  initialChannel?: DingTalkChannel;
  log: DingTalkLogger;
  setQueuedSubmit: (text: string) => void;
  dingtalkSubmitRef?: { current: ((text: string) => void) | null };
  dingtalkErrorRef?: { current: ((msg: string) => void) | null };
}

function formatDingTalkModeLabel(codeMode: boolean): string {
  return t(codeMode ? "handlers.dingtalk.modeCode" : "handlers.dingtalk.modeChat");
}

function parseMentionPolicy(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "all" || value === "false" || value === "0" || value === "no") return false;
  if (value === "mention" || value === "true" || value === "1" || value === "yes") return true;
  return fallback;
}

export function useDingTalkChannel({
  codeMode,
  initialChannel,
  log,
  setQueuedSubmit,
  dingtalkSubmitRef,
  dingtalkErrorRef,
}: UseDingTalkChannelArgs) {
  const channelRef = useRef<DingTalkChannel | null>(initialChannel ?? null);
  const replyThisTurnRef = useRef(false);

  const sendText = useCallback(
    (message: string) => {
      channelRef.current?.sendResponse(message).catch((err) => {
        log.pushWarning("DingTalk", `sendResponse error: ${(err as Error).message}`);
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
      const existing = loadDingTalkConfig();
      const clientId = args[0]?.trim() || existing.clientId || "";
      const clientSecret = args[1]?.trim() || existing.clientSecret || "";
      const requireMentionInGroup = parseMentionPolicy(args[2], existing.requireMentionInGroup);

      if (!clientId || !clientSecret) {
        throw new Error(t("handlers.dingtalk.credentialsRequired"));
      }

      saveDingTalkConfig({
        clientId,
        clientSecret,
        enabled: false,
        requireMentionInGroup,
      });

      if (channelRef.current) {
        saveDingTalkConfig({
          clientId,
          clientSecret,
          enabled: true,
          requireMentionInGroup,
        });
        return t("handlers.dingtalk.alreadyConnected", {
          mode: formatDingTalkModeLabel(codeMode),
        });
      }

      const channel = new DingTalkChannel({
        onSubmitMessage: (message) => setQueuedSubmit(message),
        onError: (message) => log.pushWarning("DingTalk", message),
        onInfo: (message) => log.pushInfo(message),
      });
      await channel.start();
      channelRef.current = channel;
      saveDingTalkConfig({
        clientId,
        clientSecret,
        enabled: true,
        requireMentionInGroup,
      });
      return t("handlers.dingtalk.connected", {
        mode: formatDingTalkModeLabel(codeMode),
      });
    },
    [codeMode, log, setQueuedSubmit],
  );

  const disconnect = useCallback(async (): Promise<string> => {
    const existing = loadDingTalkConfig();
    const current = channelRef.current;
    channelRef.current = null;
    if (current) await current.stop();
    saveDingTalkConfig({ ...existing, enabled: false });
    return t("handlers.dingtalk.disconnected");
  }, []);

  const status = useCallback((): string => {
    const config = loadDingTalkConfig();
    const configured = config.clientId && config.clientSecret;
    const connected = !!channelRef.current;
    const clientId = config.clientId
      ? `${config.clientId.slice(0, 6)}...`
      : t("handlers.dingtalk.none");
    const groupPolicy = config.requireMentionInGroup
      ? t("handlers.dingtalk.groupMention")
      : t("handlers.dingtalk.groupAll");
    return t("handlers.dingtalk.status", {
      connected: connected
        ? t("handlers.dingtalk.stateConnected")
        : t("handlers.dingtalk.stateDisconnected"),
      enabled: config.enabled
        ? t("handlers.dingtalk.stateEnabled")
        : t("handlers.dingtalk.stateDisabled"),
      configured: configured
        ? t("handlers.dingtalk.stateConfigured")
        : t("handlers.dingtalk.stateNotConfigured"),
      clientId,
      groupPolicy,
      mode: formatDingTalkModeLabel(codeMode),
    });
  }, [codeMode]);

  useEffect(() => {
    if (!dingtalkSubmitRef || !dingtalkErrorRef) return undefined;
    dingtalkSubmitRef.current = setQueuedSubmit;
    dingtalkErrorRef.current = (msg) => log.pushWarning("DingTalk", msg);
    return () => {
      dingtalkSubmitRef.current = null;
      dingtalkErrorRef.current = null;
    };
  }, [dingtalkErrorRef, dingtalkSubmitRef, log, setQueuedSubmit]);

  const parseSubmit = useCallback((raw: string) => {
    let text = raw.trim();
    if (!text) return null;
    const fromDingTalk = text.startsWith("[DingTalk] ");
    if (fromDingTalk) {
      text = text.slice(11).trimStart() || text;
    }
    return { handled: false, fromDingTalk, text };
  }, []);

  const noteTurnFromDingTalk = useCallback((fromDingTalk: boolean) => {
    replyThisTurnRef.current = fromDingTalk;
  }, []);

  const maybeSendFinalReply = useCallback(
    (lastAssistantText: string) => {
      if (channelRef.current && lastAssistantText && replyThisTurnRef.current) {
        channelRef.current.sendResponse(lastAssistantText).catch((err) => {
          log.pushWarning("DingTalk", `sendResponse error: ${(err as Error).message}`);
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
      noteTurnFromDingTalk,
      maybeSendFinalReply,
      clearTurnReply,
    }),
    [
      clearTurnReply,
      connect,
      disconnect,
      maybeSendFinalReply,
      noteTurnFromDingTalk,
      parseSubmit,
      sendInfo,
      sendText,
      status,
    ],
  );
}
