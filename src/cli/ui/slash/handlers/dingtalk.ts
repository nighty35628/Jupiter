import { t } from "../../../../i18n/index.js";
import type { SlashHandler } from "../dispatch.js";

export const handlers: Record<string, SlashHandler> = {
  dingtalk(args, _loop, ctx) {
    const subcommand = (args[0] ?? "status").toLowerCase();
    if (!ctx.dingtalk) {
      return { info: t("handlers.dingtalk.unavailable") };
    }

    if (subcommand === "connect") {
      ctx.postInfo?.(t("handlers.dingtalk.connecting"));
      void ctx.dingtalk.connect(args.slice(1)).then(
        (message) => ctx.postInfo?.(message),
        (err) =>
          ctx.postInfo?.(t("handlers.dingtalk.connectFailed", { reason: (err as Error).message })),
      );
      return {};
    }

    if (subcommand === "disconnect") {
      ctx.postInfo?.(t("handlers.dingtalk.disconnecting"));
      void ctx.dingtalk.disconnect().then(
        (message) => ctx.postInfo?.(message),
        (err) =>
          ctx.postInfo?.(
            t("handlers.dingtalk.disconnectFailed", { reason: (err as Error).message }),
          ),
      );
      return {};
    }

    if (subcommand === "status") {
      return { info: ctx.dingtalk.status() };
    }

    return {
      info: t("handlers.dingtalk.usage"),
    };
  },
};
