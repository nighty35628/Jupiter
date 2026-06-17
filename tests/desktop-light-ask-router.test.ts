import { describe, expect, it } from "vitest";
import { shouldUseLightAskForDesktopInput } from "../src/desktop/light-ask-router.js";

describe("desktop light ask router", () => {
  it("routes obvious short casual chat to lightweight ask", () => {
    expect(shouldUseLightAskForDesktopInput("你好")).toBe(true);
    expect(shouldUseLightAskForDesktopInput("谢谢")).toBe(true);
    expect(shouldUseLightAskForDesktopInput("讲个笑话")).toBe(true);
    expect(shouldUseLightAskForDesktopInput("what is prefix cache?")).toBe(true);
  });

  it("keeps agent-like requests on the full tool loop", () => {
    expect(shouldUseLightAskForDesktopInput("/compact")).toBe(false);
    expect(shouldUseLightAskForDesktopInput("修复粘贴文件的问题")).toBe(false);
    expect(shouldUseLightAskForDesktopInput("看一下 src/loop.ts 为什么报错")).toBe(false);
    expect(shouldUseLightAskForDesktopInput("搜索资料库里的论文")).toBe(false);
    expect(shouldUseLightAskForDesktopInput("提交并推送改动")).toBe(false);
    expect(shouldUseLightAskForDesktopInput("帮我写一个倒计时网页")).toBe(false);
  });

  it("does not route one-shot plan sends or long prompts to lightweight ask", () => {
    expect(shouldUseLightAskForDesktopInput("你好", { planOneShot: true })).toBe(false);
    expect(shouldUseLightAskForDesktopInput("解释一下 ".repeat(80))).toBe(false);
  });
});
