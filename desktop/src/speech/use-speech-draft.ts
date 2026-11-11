import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { RefObject } from "react";
import { imageDraftTextRevision, readImageDraft, writeImageDraft } from "../ui/image-draft-store";
import { DictationController, type SpeechCapabilities } from "./controller";
import { hasSpeechHost, readSpeechLanguage, readSpeechMode, speechCapabilities, speechHost } from "./host";

const live = new Map<string, Set<DictationController>>();
export function cancelSpeechDraft(key: string) {
  for (const controller of live.get(key) ?? []) controller.cancel();
}

export function useSpeechDraft(key: string, active: boolean, ready: boolean, textarea: RefObject<HTMLTextAreaElement | null>, bindingId = 0) {
  const current = useRef({ key, bindingId, active, ready });
  current.current = { key, bindingId, active, ready };
  // Composer is keyed by draftKey, not by backend binding generation.
  const composing = useMemo(() => ({ current: false }), [key]);
  const [capabilities, setCapabilities] = useState<SpeechCapabilities | null>(null);
  const [language, setLanguage] = useState(readSpeechLanguage);
  const controller = useMemo(() => new DictationController(speechHost, {
    current: () => current.current.key === key && current.current.bindingId === bindingId && current.current.active && current.current.ready,
    revision: () => imageDraftTextRevision(key),
    composing: () => composing.current,
    insert: (text, start, end, revision) => {
      if (current.current.key !== key || current.current.bindingId !== bindingId || !current.current.active || !current.current.ready ||
          composing.current || imageDraftTextRevision(key) !== revision) return false;
      writeImageDraft(key, draft => ({ ...draft, text: draft.text.slice(0, start) + text + draft.text.slice(end) }));
      requestAnimationFrame(() => {
        if (current.current.key !== key || current.current.bindingId !== bindingId || !current.current.active) return;
        textarea.current?.focus();
        textarea.current?.setSelectionRange(start + text.length, start + text.length);
      });
      return true;
    },
  }), [key, bindingId, textarea, composing]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => {
    const bucket = live.get(key) ?? new Set<DictationController>();
    live.set(key, bucket); bucket.add(controller);
    return () => { controller.cancel(); bucket.delete(controller); if (!bucket.size) live.delete(key); };
  }, [key, controller]);
  useEffect(() => {
    if (!active || !ready) { controller.cancel(); composing.current = false; }
  }, [active, ready, controller]);
  useEffect(() => {
    if (!hasSpeechHost() || !active) return;
    let disposed = false, request = 0;
    const refresh = () => {
      const id = ++request;
      setLanguage(readSpeechLanguage());
      void speechCapabilities().then(value => { if (!disposed && request === id) setCapabilities(value); }).catch(() => {
        if (!disposed && request === id) setCapabilities(null);
      });
    };
    refresh(); window.addEventListener("jupiter:speech-settings", refresh);
    return () => { disposed = true; window.removeEventListener("jupiter:speech-settings", refresh); };
  }, [active]);
  return {
    ...state, capabilities, language,
    pending: state.phase !== "idle" || !!state.candidate,
    onComposition(value: boolean) { composing.current = value; },
    async toggle() {
      if (state.phase === "recording") { await controller.finish(); return; }
      if (!capabilities?.available || state.phase !== "idle" || state.candidate) return;
      if (!capabilities.modelReady) {
        window.dispatchEvent(new Event("jupiter:open-speech-settings"));
        return;
      }
      const selected = readSpeechLanguage();
      if (!capabilities.autoLanguage && selected === "auto") {
        window.dispatchEvent(new Event("jupiter:open-speech-settings"));
        return;
      }
      const mode = readSpeechMode();
      if ((mode === "local" && !capabilities.localAvailable) ||
          (mode === "system" && !capabilities.networkAvailable)) {
        window.dispatchEvent(new Event("jupiter:open-speech-settings"));
        return;
      }
      const length = readImageDraft(key).text.length;
      await controller.start(selected, mode, textarea.current?.selectionStart ?? length,
        textarea.current?.selectionEnd ?? length);
    },
    cancel: controller.cancel,
    discard: controller.discard,
    insert() {
      const length = readImageDraft(key).text.length;
      controller.insertCandidate(textarea.current?.selectionStart ?? length, textarea.current?.selectionEnd ?? length);
    },
  };
}
export type SpeechUi = ReturnType<typeof useSpeechDraft>;
