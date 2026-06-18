import type { SlashHandler } from "../dispatch.js";

const ask: SlashHandler = (args, _loop, ctx) => {
  const question = args.join(" ").trim();
  if (!question) {
    return { info: "usage: /ask <question>" };
  }
  if (!ctx.runLightAsk) {
    return { info: "/ask is only available inside an interactive Jupiter session." };
  }
  void ctx.runLightAsk(question).then(
    (answer) => ctx.postInfo?.(`≫ ask\n${answer}`),
    (error: Error) => ctx.postInfo?.(`/ask failed: ${error.message}`),
  );
  return { info: "asking without tools..." };
};

export const handlers: Record<string, SlashHandler> = {
  ask,
};
