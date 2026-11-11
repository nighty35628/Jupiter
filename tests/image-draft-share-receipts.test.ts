import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageAttachment } from "../src/attachments/types";

const PREFIX = "jupiter.image-draft.v1:";
const image: ImageAttachment = {
  kind: "image",
  id: "a".repeat(64),
  name: "shared.png",
  mime: "image/png",
  bytes: 5,
  width: 1,
  height: 1,
};
let values: Map<string, string>;
let setItem: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  values = new Map();
  setItem = vi.fn((key: string, value: string) => {
    values.set(key, value);
  });
  vi.stubGlobal("localStorage", {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem,
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("share receipts in the existing draft record", { retry: 0 }, () => {
  it("persists text, attachment metadata and receipt in one write before notifying readers", async () => {
    const store = await import("../desktop/src/ui/image-draft-store");
    const observed = vi.fn(() => {
      expect(JSON.parse(values.get(`${PREFIX}draft`)!)).toMatchObject({
        text: "caption",
        attachments: [image],
        shareIntakeIds: ["intake"],
      });
    });
    store.subscribeImageDraft("draft", observed);
    store.writeImageDraftIntake("draft", "intake", (draft) => ({
      ...draft,
      text: "caption",
      attachments: [image],
    }));
    expect(setItem).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledOnce();
    expect([...values.keys()]).toEqual([`${PREFIX}draft`]);
    expect(store.findImageDraftIntake("intake")).toBe("draft");
  });

  it("keeps the old live and stored draft unchanged on quota failure, then retries exactly once", async () => {
    const store = await import("../desktop/src/ui/image-draft-store");
    store.writeImageDraft("draft", () => ({ text: "existing", attachments: [] }));
    const observed = vi.fn();
    store.subscribeImageDraft("draft", observed);
    setItem.mockImplementationOnce(() => {
      throw new Error("quota");
    });
    const append = vi.fn((draft) => ({
      ...draft,
      text: `${draft.text} shared`,
      attachments: [image],
    }));
    expect(() => store.writeImageDraftIntake("draft", "intake", append)).toThrow("quota");
    expect(store.readImageDraft("draft")).toMatchObject({ text: "existing", attachments: [] });
    expect(store.findImageDraftIntake("intake")).toBeUndefined();
    expect(observed).not.toHaveBeenCalled();
    store.writeImageDraftIntake("draft", "intake", append);
    expect(store.readImageDraft("draft")).toMatchObject({
      text: "existing shared",
      attachments: [image],
      shareIntakeIds: ["intake"],
    });
  });

  it("restores receipts from storage after a cold module load and deduplicates reapplication", async () => {
    const warm = await import("../desktop/src/ui/image-draft-store");
    warm.writeImageDraftIntake("original-tab", "intake", (draft) => ({
      ...draft,
      text: "once",
      attachments: [image],
    }));
    vi.resetModules();
    const cold = await import("../desktop/src/ui/image-draft-store");
    expect(cold.readImageDraft("original-tab").shareIntakeIds).toEqual(["intake"]);
    const append = vi.fn();
    cold.writeImageDraftIntake("original-tab", "intake", append);
    expect(append).not.toHaveBeenCalled();
    expect(cold.readImageDraft("original-tab")).toMatchObject({
      text: "once",
      attachments: [image],
    });
    cold.writeImageDraft("original-tab", (draft) => ({
      ...draft,
      text: "edited after intake",
      attachments: [],
    }));
    expect(cold.findImageDraftIntake("intake")).toBe("original-tab");
  });

  it("moves a receipt-only new-tab draft into an already populated bound draft", async () => {
    const store = await import("../desktop/src/ui/image-draft-store");
    store.writeImageDraftIntake("new:tab", "intake", (draft) => draft);
    store.writeImageDraft("bound", () => ({ text: "keep target text", attachments: [image] }));
    expect(store.handoffImageDraft("new:tab", "bound")).toBe(true);
    expect(store.readImageDraft("bound")).toMatchObject({
      text: "keep target text",
      attachments: [image],
      shareIntakeIds: ["intake"],
    });
    expect(store.findImageDraftIntake("intake")).toBe("bound");
    expect(values.has(`${PREFIX}new:tab`)).toBe(false);
  });

  it("preserves receipts during legacy/default-view migration without replacing real target content", async () => {
    const store = await import("../desktop/src/ui/image-draft-store");
    store.writeImageDraftIntake("session", "intake", (draft) => draft);
    store.writeImageDraftIntake("legacy-name", "other-intake", (draft) => draft);
    const target = store.conversationDraftKey("session", "default");
    store.writeImageDraft(target, () => ({ text: "current target" }));
    expect(store.migrateConversationDraft("session", "default", ["legacy-name"])).toBe(true);
    expect(store.readImageDraft(target)).toMatchObject({
      text: "current target",
      shareIntakeIds: ["intake", "other-intake"],
    });
    expect(store.findImageDraftIntake("intake")).toBe(target);
    expect(store.findImageDraftIntake("other-intake")).toBe(target);
  });

  it.each(["", "existing draft"])(
    "forwards a late bound intake after successful handoff (%s)",
    async (text) => {
      const store = await import("../desktop/src/ui/image-draft-store");
      const bound = store.bindImageDraftIntake("new:tab");
      if (text) store.writeImageDraft("new:tab", () => ({ text }));
      expect(store.handoffImageDraft("new:tab", "formal")).toBe(true);
      bound.setIntake("intake", (draft) => ({
        ...draft,
        text: `${draft.text} shared`,
        attachments: [image],
      }));
      expect(store.readImageDraft("formal")).toMatchObject({
        text: `${text} shared`,
        attachments: [image],
        shareIntakeIds: ["intake"],
      });
      expect(values.has(`${PREFIX}new:tab`)).toBe(false);
      expect(bound.intakePersisted("intake")).toBe(true);
      expect(store.findImageDraftIntake("intake")).toBe("formal");
    },
  );

  it("follows a chain of handoffs and appends to the latest target snapshot", async () => {
    const store = await import("../desktop/src/ui/image-draft-store");
    const bound = store.bindImageDraftIntake("new:tab");
    expect(store.handoffImageDraft("new:tab", "provisional")).toBe(true);
    expect(store.handoffImageDraft("provisional", "formal")).toBe(true);
    store.writeImageDraft("formal", () => ({ text: "typed while upload was pending" }));
    bound.setIntake("intake", (draft) => ({
      ...draft,
      text: `${draft.text} shared`,
    }));
    expect(store.readImageDraft("formal").text).toBe("typed while upload was pending shared");
    expect([...values.keys()]).toEqual([`${PREFIX}formal`]);
  });

  it("does not forward failed handoffs or redirect an ordinary A/B bound intake", async () => {
    const store = await import("../desktop/src/ui/image-draft-store");
    store.writeImageDraft("a", () => ({ text: "source" }));
    store.writeImageDraft("b", () => ({ text: "different target" }));
    expect(store.handoffImageDraft("a", "b")).toBe(false);
    store.writeImageDraftIntake("a", "intake", (draft) => ({
      ...draft,
      text: `${draft.text} shared`,
    }));
    expect(store.readImageDraft("a").text).toBe("source shared");
    expect(store.readImageDraft("b").text).toBe("different target");
    expect(store.findImageDraftIntake("intake")).toBe("a");
  });

  it("does not mix old in-flight setters with a reused new-tab key's next generation", async () => {
    const store = await import("../desktop/src/ui/image-draft-store");
    const old = store.bindImageDraftIntake("new:tab");
    expect(store.handoffImageDraft("new:tab", "conversation-a")).toBe(true);
    const next = store.bindImageDraftIntake("new:tab");
    expect(store.handoffImageDraft("new:tab", "conversation-b")).toBe(true);
    old.setIntake("old-intake", (draft) => ({ ...draft, text: "old share" }));
    next.setIntake("new-intake", (draft) => ({ ...draft, text: "new share" }));
    expect(store.readImageDraft("conversation-a").text).toBe("old share");
    expect(store.readImageDraft("conversation-b").text).toBe("new share");
    expect(old.intakePersisted("old-intake")).toBe(true);
    expect(next.intakePersisted("new-intake")).toBe(true);
    expect(values.has(`${PREFIX}new:tab`)).toBe(false);
  });
});
