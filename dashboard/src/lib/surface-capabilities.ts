export type DashboardRuntimeMode = "web" | "server" | "mock";

const modeMeta = document.querySelector('meta[name="jupiter-mode"]');
const rawMode = modeMeta?.getAttribute("content") ?? "";
const isServerMode = rawMode !== "" && rawMode !== "__JUPITER_MODE__";

export const runtimeMode = Object.freeze({
  rawMode,
  isServerMode,
  mode: (rawMode === "web" ? "web" : isServerMode ? "server" : "mock") as DashboardRuntimeMode,
});

/** True whenever the UI is served by a Jupiter CLI process rather than Tauri. */
export const isWebRuntime = runtimeMode.isServerMode;

export const surfaceCapabilities = Object.freeze({
  runtime: runtimeMode.mode,
  nativeWindow: false,
  nativeWebview: false,
  nativeDialogs: false,
  nativeMenus: false,
  nativeUpdater: false,
  browserNotifications: typeof Notification !== "undefined",
  externalBrowser: true,
});

export function initializeWebSurface(): void {
  document.documentElement.dataset.runtime = "web";
  document.body.dataset.runtime = "web";
  document.documentElement.dataset.nativeWindow = "false";
  document.body.dataset.nativeWindow = "false";
}
