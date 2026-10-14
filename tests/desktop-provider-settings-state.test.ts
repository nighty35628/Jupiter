import { describe, expect, it } from "vitest";
import {
  acknowledgeProviderDraft,
  createProviderDraft,
  editProviderDraft,
  refreshProviderDraft,
} from "../src/desktop/provider-settings-state.js";

const saved = {
  baseUrl: "https://relay.example/v1",
  model: "mock-model",
  providerDialect: "auto" as const,
  vision: false,
  imageTransport: "auto" as const,
};

describe("provider RAM draft", { retry: 0 }, () => {
  it("preserves dirty fields across same-value and unrelated refreshes", () => {
    const draft = editProviderDraft(createProviderDraft(saved), "model", "draft-model");
    expect(refreshProviderDraft(draft, saved).values.model).toBe("draft-model");
    expect(refreshProviderDraft(draft, { ...saved, vision: true }).values.model).toBe(
      "draft-model",
    );
    expect(refreshProviderDraft(draft, { ...saved, vision: true }).values.vision).toBe(true);
  });

  it("only clears the key on success for the matching submitted edit", () => {
    const submitted = editProviderDraft(createProviderDraft(saved), "apiKey", "mock-key");
    expect(acknowledgeProviderDraft(submitted, submitted, "failure").values.apiKey).toBe(
      "mock-key",
    );
    expect(acknowledgeProviderDraft(submitted, submitted, "success").values.apiKey).toBe("");
    const edited = editProviderDraft(submitted, "apiKey", "mock-new-key");
    expect(acknowledgeProviderDraft(edited, submitted, "success").values.apiKey).toBe(
      "mock-new-key",
    );
    const back = editProviderDraft(edited, "apiKey", "mock-key");
    expect(acknowledgeProviderDraft(back, submitted, "success").values.apiKey).toBe("mock-key");
  });
});
