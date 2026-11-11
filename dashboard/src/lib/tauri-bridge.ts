// Compatibility entrypoint for Tauri core/event imports used by the shared Desktop UI.
export { Channel, invoke, listen, runtimeTransport } from "./runtime-transport";
export { isWebRuntime, surfaceCapabilities } from "./surface-capabilities";
export * from "./shell-services";
