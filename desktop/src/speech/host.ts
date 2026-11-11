import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SpeechCapabilities, SpeechEvent, SpeechHost } from "./controller";

export function hasSpeechHost(): boolean {
  return typeof window !== "undefined" && (
    "__TAURI_INTERNALS__" in window ||
    document.documentElement.dataset.hostPlatform === "android" ||
    document.querySelector('meta[name="jupiter-platform"]')?.getAttribute("content") === "android"
  );
}
const desktopListeners = new Set<(event: SpeechEvent) => void>();
function androidHost() {
  return document.documentElement.dataset.hostPlatform === "android" ||
    document.querySelector('meta[name="jupiter-platform"]')?.getAttribute("content") === "android";
}
export const speechHost: SpeechHost = {
  listen: async callback => {
    if (androidHost()) return listen<SpeechEvent>("jupiter:speech", event => callback(event.payload));
    desktopListeners.add(callback);
    return () => { desktopListeners.delete(callback); };
  },
  start: async (sessionId, language, mode) => {
    if (androidHost()) return invoke("speech_start", { sessionId, language, mode });
    let chunks: string[] = [], length = 0, terminal = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    type Packet = SpeechEvent & { part?: number; last?: boolean };
    const publish = (event: SpeechEvent) => {
      for (const callback of [...desktopListeners]) callback(event);
    };
    const retire = () => {
      terminal = true; chunks = [];
      if (expiry !== undefined) clearTimeout(expiry);
    };
    const fail = () => { retire(); publish({ sessionId, state: "error", error: "transport" }); };
    const onEvent = new Channel<Packet>(event => {
      if (terminal || event.sessionId !== sessionId) return;
      if (event.part !== undefined || event.last !== undefined) {
        if (event.state !== "result" || !Number.isInteger(event.part) || event.part !== chunks.length ||
            chunks.length >= 128 || typeof event.last !== "boolean" || typeof event.text !== "string" ||
            length + event.text.length > 65536 || (chunks.length === 127 && !event.last)) {
          fail();
          return;
        }
        if (!chunks.length) expiry = setTimeout(fail, 10000);
        chunks.push(event.text); length += event.text.length;
        if (!event.last) return;
        const text = chunks.join(""); retire();
        publish({ sessionId, state: "result", text });
        return;
      }
      if (event.state === "result" && (chunks.length > 0 || typeof event.text !== "string" || event.text.length > 65536)) {
        fail(); return;
      }
      if (event.state === "result" || event.state === "error" || event.state === "cancelled") {
        retire();
      }
      publish(event);
    });
    return invoke("speech_start", { sessionId, language, mode, onEvent });
  },
  finish: sessionId => invoke("speech_finish", { sessionId }),
  cancel: sessionId => invoke("speech_cancel", { sessionId }),
};
export const speechCapabilities = () => invoke<SpeechCapabilities>("speech_capabilities");

export const speechLanguages = [
  ["auto", "Auto"], ["zh", "中文"], ["en", "English"], ["ja", "日本語"],
  ["ko", "한국어"], ["de", "Deutsch"], ["fr", "Français"], ["es", "Español"],
  ["ru", "Русский"], ["ar", "العربية"], ["pt", "Português"], ["it", "Italiano"],
  ["hi", "हिन्दी"], ["nl", "Nederlands"], ["tr", "Türkçe"], ["uk", "Українська"],
] as const;
export function readSpeechLanguage(): string {
  try {
    const saved = localStorage.getItem("jupiter.speech.language");
    if (speechLanguages.some(([id]) => id === saved)) return saved!;
  } catch { /* Storage is optional. */ }
  return "auto";
}
export function saveSpeechLanguage(language: string) {
  try { localStorage.setItem("jupiter.speech.language", language); } catch { /* Storage is optional. */ }
  window.dispatchEvent(new Event("jupiter:speech-settings"));
}
export function readSpeechMode(): "local" | "system" {
  try { if (localStorage.getItem("jupiter.speech.mode") === "system") return "system"; } catch { /* Optional. */ }
  return "local";
}
