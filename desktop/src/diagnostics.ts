import { invoke } from "@tauri-apps/api/core";

export interface DesktopDiagnosticEvent {
  name: string;
  durationMs?: number;
  sizeBytes?: number;
  count?: number;
  code?: number;
}

type PendingDiagnostic = Required<Pick<DesktopDiagnosticEvent, "name" | "count">> &
  Omit<DesktopDiagnosticEvent, "name" | "count">;

const pending = new Map<string, PendingDiagnostic>();
const pendingUserSends = new Map<string, number>();
let flushTimer: number | undefined;

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function flushDiagnostics(): Promise<void> {
  flushTimer = undefined;
  const events = [...pending.values()];
  pending.clear();
  await Promise.allSettled(events.map((event) => invoke("desktop_diagnostic_event", { event })));
}

export function reportDesktopDiagnostic(event: DesktopDiagnosticEvent): void {
  const name = event.name.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 64);
  if (!name) return;
  const current = pending.get(name);
  const count = Math.max(1, Math.floor(finiteNonNegative(event.count) ?? 1));
  pending.set(name, {
    name,
    count: (current?.count ?? 0) + count,
    durationMs: Math.max(current?.durationMs ?? 0, finiteNonNegative(event.durationMs) ?? 0),
    sizeBytes: (current?.sizeBytes ?? 0) + (finiteNonNegative(event.sizeBytes) ?? 0),
    code: event.code ?? current?.code,
  });
  if (flushTimer === undefined) {
    flushTimer = window.setTimeout(() => void flushDiagnostics(), 2_000);
  }
}

export function recordUserSend(clientId: string): void {
  pendingUserSends.set(clientId, performance.now());
  while (pendingUserSends.size > 64) {
    const oldest = pendingUserSends.keys().next().value;
    if (typeof oldest !== "string") break;
    pendingUserSends.delete(oldest);
  }
}

export function recordIncomingDiagnostic(
  event: {
    type: string;
    clientId?: string;
    batchCount?: number;
    snapshot?: { payloadBytes?: number };
  },
  wireBytes: number,
): void {
  if (event.type === "user.message" && event.clientId) {
    const startedAt = pendingUserSends.get(event.clientId);
    if (startedAt !== undefined) {
      pendingUserSends.delete(event.clientId);
      reportDesktopDiagnostic({
        name: "user_persist_ack",
        durationMs: performance.now() - startedAt,
      });
    }
    return;
  }
  if (event.type === "model.delta") {
    reportDesktopDiagnostic({
      name: "rpc_model_delta",
      sizeBytes: wireBytes,
      count: event.batchCount,
    });
    return;
  }
  if (event.type === "$session_loaded" || event.type === "$session_reconciled") {
    reportDesktopDiagnostic({
      name: "rpc_session_snapshot",
      sizeBytes: event.snapshot?.payloadBytes ?? wireBytes,
    });
  }
}

export function installRendererDiagnostics(): () => void {
  reportDesktopDiagnostic({ name: "renderer_started" });
  const onError = (): void => reportDesktopDiagnostic({ name: "renderer_error" });
  const onUnhandledRejection = (): void =>
    reportDesktopDiagnostic({ name: "renderer_unhandled_rejection" });
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  let expectedAt = performance.now() + 1_000;
  const interval = window.setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - expectedAt);
    expectedAt = now + 1_000;
    if (document.visibilityState === "visible" && lag >= 250) {
      reportDesktopDiagnostic({ name: "renderer_event_loop_lag", durationMs: lag });
    }
  }, 1_000);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    window.clearInterval(interval);
    if (flushTimer !== undefined) window.clearTimeout(flushTimer);
    void flushDiagnostics();
  };
}
