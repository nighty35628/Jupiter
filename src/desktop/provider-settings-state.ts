export type ProviderRequestStatus = "pending" | "success" | "failure" | "conflict" | "unknown";
export type ProviderDraftValues = {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerDialect: "auto" | "deepseek" | "openai-compatible";
  vision: boolean;
  imageTransport: "auto" | "inline";
};
export type ProviderDraft = {
  values: ProviderDraftValues;
  dirty: Partial<Record<keyof ProviderDraftValues, number>>;
  revision: number;
};
export type ProviderSaveOutcome = {
  status: ProviderRequestStatus;
  providerVersion?: string;
  message?: string;
};
export type SettingsSaveResult = {
  type: "$settings_save_result";
  requestId: string;
  serverInstanceId: string;
  providerVersion: string;
  status: ProviderRequestStatus;
  provider?: ProviderSaveOutcome;
  settings?: { status: ProviderRequestStatus };
};
export type ProviderProbeInput = {
  requestId: string;
  expectedProviderVersion?: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  providerDialect: ProviderDraftValues["providerDialect"];
};
export type ProviderProbeResult = {
  type: "$provider_test_result";
  requestId: string;
  status: ProviderRequestStatus;
  ok: boolean;
  message: string;
  serverInstanceId: string;
  providerVersion: string;
  credentialVersion?: string;
  credentialSource: "draft" | "saved" | "none";
  validation: "none" | "models" | "chat";
  config?: Pick<ProviderDraftValues, "baseUrl" | "model" | "providerDialect">;
  models?: string[];
};

export function createProviderDraft(values: Omit<ProviderDraftValues, "apiKey">): ProviderDraft {
  return { values: { ...values, apiKey: "" }, dirty: {}, revision: 0 };
}

export function editProviderDraft<K extends keyof ProviderDraftValues>(
  draft: ProviderDraft,
  field: K,
  value: ProviderDraftValues[K],
): ProviderDraft {
  const revision = draft.revision + 1;
  return {
    values: { ...draft.values, [field]: value },
    dirty: { ...draft.dirty, [field]: revision },
    revision,
  };
}

export function refreshProviderDraft(
  draft: ProviderDraft,
  saved: Omit<ProviderDraftValues, "apiKey">,
): ProviderDraft {
  const values = { ...draft.values };
  for (const field of Object.keys(saved) as Array<keyof typeof saved>) {
    if (draft.dirty[field] === undefined) Object.assign(values, { [field]: saved[field] });
  }
  return { ...draft, values };
}

export function acknowledgeProviderDraft(
  draft: ProviderDraft,
  submitted: ProviderDraft,
  status: ProviderRequestStatus,
): ProviderDraft {
  if (status !== "success") return draft;
  const dirty = { ...draft.dirty };
  const values = { ...draft.values };
  for (const field of Object.keys(submitted.values) as Array<keyof ProviderDraftValues>) {
    if (
      draft.dirty[field] === submitted.dirty[field] &&
      draft.values[field] === submitted.values[field]
    ) {
      delete dirty[field];
      if (field === "apiKey") values.apiKey = "";
    }
  }
  return { ...draft, dirty, values };
}
