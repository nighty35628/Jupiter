import { describe, expect, it } from "vitest";
import { shouldUseLightAskForDesktopInput } from "../src/desktop/light-ask-router.js";

describe("desktop light ask router", () => {
  it("keeps settings and computer observation/actions on Agent", () => {
    for (const text of [
      "系统设置给我看看？",
      "看看我的屏幕？",
      "点击这个按钮？",
      "截图看看？",
      "Can you inspect my screen?",
      "Jupiter打开系统设置给我看看？",
      "给我看看系统设置？",
      "show me settings?",
      "截个图？",
      "现在屏幕上有什么？",
      "你看到我的桌面了吗？",
      "帮我截图？",
      "Jupiter帮我创建文件？",
    ]) {
      expect(shouldUseLightAskForDesktopInput(text)).toBe(false);
    }
    expect(shouldUseLightAskForDesktopInput("Jupiter的Computer Use怎么开启？")).toBe(true);
    expect(shouldUseLightAskForDesktopInput("那怎么开？", { recentTopic: "computer-use" })).toBe(
      true,
    );
  });
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
