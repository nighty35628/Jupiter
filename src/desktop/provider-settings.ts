import { randomUUID } from "node:crypto";
import type { ProviderSettingsInput } from "../config.js";
import type {
  ProviderProbeInput,
  ProviderProbeResult,
  ProviderSaveOutcome,
  SettingsSaveResult,
} from "./provider-settings-state.js";

type Snapshot = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  dialectPreference: ProviderSettingsInput["dialect"];
  endpointIdentity: string;
  officialDeepSeek: boolean;
  label: string;
  imageTransport?: "auto" | "inline";
  capability: { supportsImages: boolean };
};

export function createProviderVersionTracker(serverInstanceId = randomUUID()) {
  let previous: Snapshot | undefined;
  let serial = 0;
  return {
    serverInstanceId,
    observe(snapshot: Snapshot): string {
      if (
        !previous ||
        snapshot.baseUrl !== previous.baseUrl ||
        snapshot.apiKey !== previous.apiKey ||
        snapshot.model !== previous.model ||
        snapshot.dialectPreference !== previous.dialectPreference ||
        snapshot.imageTransport !== previous.imageTransport ||
        snapshot.capability.supportsImages !== previous.capability.supportsImages
      ) {
        serial++;
        // Compare only in RAM. The public token contains no credential-derived data.
        previous = { ...snapshot, capability: { ...snapshot.capability } };
      }
      return `${serverInstanceId}:${serial}`;
    },
    get version() {
      return `${serverInstanceId}:${serial}`;
    },
  };
}

type Dependencies<S extends Snapshot> = {
  resolve: (input?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    dialect?: ProviderSettingsInput["dialect"];
  }) => S;
  tracker: ReturnType<typeof createProviderVersionTracker>;
  web?: boolean;
};
type SavePatch = {
  expectedProviderVersion?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  providerDialect?: ProviderSettingsInput["dialect"];
  vision?: boolean;
  imageTransport?: "auto" | "inline";
};

export function saveDesktopProvider<S extends Snapshot>(
  patch: SavePatch,
  deps: Dependencies<S> & {
    sources: () => { baseUrlSource: string; apiKeySource: string };
    bindLegacy: () => void;
    save: (input: ProviderSettingsInput) => void;
  },
): ProviderSaveOutcome {
  if (deps.web)
    return {
      status: "failure",
      message: "Provider credentials can only be changed in Jupiter Desktop.",
    };
  let writeAttempted = false;
  try {
    const current = deps.resolve();
    const providerVersion = deps.tracker.observe(current);
    if (!patch.expectedProviderVersion || patch.expectedProviderVersion !== providerVersion)
      return {
        status: "conflict",
        providerVersion,
        message: "Provider settings changed. Review the current settings before saving again.",
      };
    const sources = deps.sources();
    if (sources.baseUrlSource.startsWith("env:"))
      return {
        status: "failure",
        providerVersion,
        message: "The endpoint is managed by an environment variable.",
      };
    const target = deps.resolve({
      baseUrl: patch.baseUrl ?? current.baseUrl,
      model: patch.model ?? current.model,
      dialect: patch.providerDialect ?? current.dialectPreference,
    });
    const draftKey = patch.apiKey?.trim();
    const apiKey =
      draftKey ||
      (target.endpointIdentity === current.endpointIdentity ? current.apiKey : undefined);
    if (!apiKey)
      return {
        status: "failure",
        providerVersion,
        message: "A new endpoint requires its own API key.",
      };
    if (
      target.officialDeepSeek &&
      sources.apiKeySource.startsWith("env:") &&
      draftKey &&
      draftKey !== current.apiKey
    )
      return {
        status: "failure",
        providerVersion,
        message: "An environment variable overrides the saved API key.",
      };
    // No await between CAS and the existing atomic provider write.
    deps.bindLegacy();
    writeAttempted = true;
    deps.save({
      baseUrl: target.baseUrl,
      apiKey,
      model: target.model,
      dialect: target.dialectPreference,
      vision: patch.vision,
      imageTransport: patch.imageTransport,
    });
    return { status: "success", providerVersion: deps.tracker.observe(deps.resolve()) };
  } catch {
    return {
      status: writeAttempted ? "unknown" : "failure",
      providerVersion: deps.tracker.version,
      message: writeAttempted
        ? "Provider save outcome is unknown. Refresh settings before trying again."
        : "Provider settings could not be saved. Check the endpoint, model and configuration file.",
    };
  }
}

export function summarizeSettingsSave(
  requestId: string,
  provider: ProviderSaveOutcome | undefined,
  settings: SettingsSaveResult["settings"],
  tracker: ReturnType<typeof createProviderVersionTracker>,
): SettingsSaveResult {
  const statuses = [provider?.status, settings?.status].filter(Boolean);
  const status = statuses.includes("pending")
    ? "pending"
    : statuses.includes("unknown")
      ? "unknown"
      : statuses.includes("conflict")
        ? "conflict"
        : statuses.includes("failure")
          ? "failure"
          : "success";
  return {
    type: "$settings_save_result",
    requestId,
    status,
    provider,
    settings,
    serverInstanceId: tracker.serverInstanceId,
    providerVersion: tracker.version,
  };
}

export async function probeDesktopProvider<S extends Snapshot>(
  input: ProviderProbeInput,
  deps: Dependencies<S> & {
    createClient: (snapshot: S) => {
      listModels: (input: { signal: AbortSignal }) => Promise<
        { data: { id: string }[] } | null | undefined
      >;
      chat: (input: {
        model: string;
        messages: { role: "user"; content: string }[];
        thinking: "disabled";
        maxTokens: number;
        signal: AbortSignal;
        disableRetry: boolean;
      }) => Promise<unknown>;
    };
  },
): Promise<ProviderProbeResult> {
  const result: ProviderProbeResult = {
    type: "$provider_test_result",
    requestId: input.requestId,
    status: "failure",
    ok: false,
    message: "Provider test failed. Check the endpoint, model and credentials.",
    serverInstanceId: deps.tracker.serverInstanceId,
    providerVersion: deps.tracker.version,
    credentialSource: "none",
    validation: "none",
  };
  if (deps.web)
    return { ...result, message: "Provider tests are only available in Jupiter Desktop." };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  try {
    const current = deps.resolve();
    result.providerVersion = deps.tracker.observe(current);
    if (input.expectedProviderVersion && input.expectedProviderVersion !== result.providerVersion)
      return {
        ...result,
        status: "conflict",
        message: "Provider settings changed. Test again with the current settings.",
      };
    const targetWithoutKey = deps.resolve({
      baseUrl: input.baseUrl,
      model: input.model,
      dialect: input.providerDialect,
    });
    const draftKey = input.apiKey?.trim();
    const apiKey =
      draftKey ||
      (targetWithoutKey.endpointIdentity === current.endpointIdentity ? current.apiKey : undefined);
    if (!apiKey)
      return { ...result, message: "Enter an API key for this endpoint before testing." };
    result.credentialSource = draftKey ? "draft" : "saved";
    result.credentialVersion = draftKey ? input.requestId : result.providerVersion;
    const target = deps.resolve({
      baseUrl: input.baseUrl,
      model: input.model,
      dialect: input.providerDialect,
      apiKey,
    });
    result.config = {
      baseUrl: target.baseUrl,
      model: target.model,
      providerDialect: target.dialectPreference,
    };
    const client = deps.createClient(target);
    controller = new AbortController();
    const signal = controller.signal;
    timeout = setTimeout(() => controller?.abort(), 20_000);
    result.validation = "models";
    const listed = await client.listModels({ signal });
    const models = listed?.data
      ?.map((entry) => entry.id)
      .filter((id) => typeof id === "string" && id.length > 0);
    if (!models?.length) {
      result.validation = "chat";
      await client.chat({
        model: target.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        thinking: "disabled",
        maxTokens: 8,
        signal,
        disableRetry: true,
      });
    }
    if (signal.aborted)
      return {
        ...result,
        status: "unknown",
        message: "Connection test outcome is unknown. Test again.",
      };
    if (deps.tracker.observe(deps.resolve()) !== result.providerVersion)
      return {
        ...result,
        status: "conflict",
        message: "Provider credentials or settings changed during the test. Test again.",
      };
    return {
      ...result,
      status: "success",
      ok: true,
      models,
      message:
        result.validation === "models" ? "Models endpoint verified." : "Chat endpoint verified.",
    };
  } catch {
    return controller?.signal.aborted
      ? { ...result, status: "unknown", message: "Connection test outcome is unknown. Test again." }
      : result;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
