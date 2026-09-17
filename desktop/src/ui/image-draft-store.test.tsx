// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ImageAttachment } from "../../../src/attachments/types";
import { useImageDraft } from "./image-attachments";
import {
  acknowledgeImageSubmission,
  imageSubmissionId,
  readImageDraft,
  rememberImageSubmission,
  writeImageDraft,
} from "./image-draft-store";

const image: ImageAttachment = {
  kind: "image",
  id: "a".repeat(64),
  name: "test.png",
  mime: "image/png",
  width: 2,
  height: 1,
  bytes: 12,
};

describe("durable image drafts", () => {
  it("keeps late asynchronous image intake attached to the original session", () => {
    const key: string = crypto.randomUUID();
    const hook = renderHook(({ session }: { session: string }) => useImageDraft(session), {
      initialProps: { session: key },
    });
    const originalSetter = hook.result.current.setImages;
    hook.rerender({ session: `${key}other` });
    act(() => originalSetter([image]));
    expect(hook.result.current.images).toEqual([]);
    hook.rerender({ session: key });
    expect(hook.result.current.images).toEqual([image]);
    hook.unmount();
    const reopened = renderHook(() => useImageDraft(key));
    expect(reopened.result.current.images).toEqual([image]);
    reopened.unmount();
  });
  it("reuses the original unknown-delivery ID and removes it only on acknowledgement", () => {
    const key = crypto.randomUUID();
    const draft = { text: "", attachments: [image] };
    rememberImageSubmission(key, "stable-id", draft, { ask: true });
    expect(imageSubmissionId(key, draft)).toBe("stable-id");
    expect(imageSubmissionId(key, { ...draft, text: "different intent" })).toBeUndefined();
    writeImageDraft(key, (value) => ({ ...value, text: "next draft" }));
    expect(readImageDraft(key).pending?.ask).toBe(true);
    acknowledgeImageSubmission("stable-id");
    expect(readImageDraft(key).pending).toBeUndefined();
    expect(readImageDraft(key).text).toBe("next draft");
  });
  it("persists pure-image queue entries together with their mode and submission ID", () => {
    const key = crypto.randomUUID();
    const queue = [
      {
        text: "",
        payload: { attachments: [image], ask: true, plan: false, clientId: "queued-id" },
      },
    ];
    writeImageDraft(key, (value) => ({ ...value, queue }));
    expect(JSON.parse(localStorage.getItem(`jupiter.image-draft.v1:${key}`)!).queue).toEqual(queue);
  });
});
