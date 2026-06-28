import { describe, expect, it, vi } from "vitest";
import {
  generateSessionTitle,
  makeSessionNameFromTitle,
  normalizeGeneratedSessionTitle,
  shouldAutoNameSession,
  titleFromFirstSentence,
} from "../src/session-title.js";

describe("session title generation", () => {
  it("normalizes model output into a concise title", () => {
    expect(normalizeGeneratedSessionTitle('```text\nTitle: "Fix parser cache bug"\n```')).toBe(
      "Fix parser cache bug",
    );
  });

  it("turns titles into readable safe session names", () => {
    expect(
      makeSessionNameFromTitle("Fix parser cache bug", {
        exists: () => false,
      }),
    ).toBe("Fix-parser-cache-bug");
    expect(
      makeSessionNameFromTitle("修复 会话 损坏", {
        exists: () => false,
      }),
    ).toBe("修复-会话-损坏");
  });

  it("adds a suffix when a generated title would collide with an existing session", () => {
    expect(
      makeSessionNameFromTitle("Fix login", {
        exists: (name) => name === "Fix-login",
      }),
    ).toBe("Fix-login-2");
    expect(
      makeSessionNameFromTitle("Fix login", {
        currentName: "Fix-login",
        exists: () => true,
      }),
    ).toBe("Fix-login");
    expect(makeSessionNameFromTitle("!!!", { exists: () => false })).toBeNull();
  });

  it("only auto-names default first-turn sessions that have not been named before", () => {
    expect(shouldAutoNameSession(undefined, {}, 1)).toBe(false);
    expect(shouldAutoNameSession("default", {}, 1)).toBe(true);
    expect(shouldAutoNameSession("default-20260517123456", {}, 1)).toBe(true);
    expect(shouldAutoNameSession("desktop-20260517123456-1", {}, 1)).toBe(true);
    expect(shouldAutoNameSession("desktop-20260611123456789-1-2", {}, 1)).toBe(true);
    expect(shouldAutoNameSession("20260611123456789", {}, 1)).toBe(true);
    expect(shouldAutoNameSession("20260611065427382-1-1", {}, 1)).toBe(true);
    expect(shouldAutoNameSession("default-20260517123456", {}, 2)).toBe(false);
    expect(shouldAutoNameSession("desktop-20260517123456-1", {}, 2)).toBe(false);
    expect(shouldAutoNameSession("desktop-20260611123456789-1-2", {}, 2)).toBe(false);
    expect(shouldAutoNameSession("20260611123456789", {}, 2)).toBe(false);
    expect(shouldAutoNameSession("20260611065427382-1-1", {}, 2)).toBe(false);
    expect(shouldAutoNameSession("custom-session", {}, 1)).toBe(false);
    expect(shouldAutoNameSession("default-20260517123456", { autoTitleGenerated: true }, 1)).toBe(
      false,
    );
  });

  it("uses the first Chinese sentence as a local title", () => {
    expect(titleFromFirstSentence("请修复登录失败。顺便加测试")).toBe("请修复登录失败");
    expect(titleFromFirstSentence("修复 Vite HMR 卡住的问题！后面不该进标题")).toBe(
      "修复 Vite HMR 卡住的问题",
    );
  });

  it("uses the first English sentence as a local title", () => {
    expect(titleFromFirstSentence("Fix login failure. Add tests too")).toBe("Fix login failure");
    expect(titleFromFirstSentence("Can you inspect this? Then patch it")).toBe(
      "Can you inspect this",
    );
    expect(titleFromFirstSentence("Fix login\nAdd tests too")).toBe("Fix login");
  });

  it("preserves development targets in first-sentence titles", () => {
    expect(titleFromFirstSentence("@src/session-title.ts 帮我改标题。顺便补测试")).toBe(
      "@src/session-title.ts 帮我改标题",
    );
    expect(titleFromFirstSentence("/Users/reedom/Jupiter/src/session-title.ts 帮我审核")).toBe(
      "/Users/reedom/Jupiter/src/session-title.ts 帮我审核",
    );
    expect(titleFromFirstSentence("https://example.com/a.b?x=1 看这个链接。后面忽略")).toBe(
      "https://example.com/a.b?x=1 看这个链接",
    );
    expect(titleFromFirstSentence("pnpm test 报错; 后面忽略")).toBe("pnpm test 报错");
  });

  it("returns null for empty or punctuation-only first sentences", () => {
    expect(titleFromFirstSentence("")).toBeNull();
    expect(titleFromFirstSentence("   ")).toBeNull();
    expect(titleFromFirstSentence("!!!")).toBeNull();
  });

  it("truncates long first-sentence titles", () => {
    expect(
      titleFromFirstSentence(
        "Fix the generated session title naming rule so it uses only the first user sentence before anything else.",
      ),
    ).toBe("Fix the generated session title naming rule so");
  });

  it("does not call a model when generating session titles", async () => {
    const client = {
      chat: vi.fn(async () => {
        throw new Error("title generation must not call model");
      }),
    };
    const title = await generateSessionTitle(client, "deepseek-v4-pro", {
      workspace: "/work/jupiter",
      userText: "修复会话命名。后面这句不该进标题",
      assistantText: "ignored",
    });

    expect(title).toBe("修复会话命名");
    expect(client.chat).not.toHaveBeenCalled();
  });
});
