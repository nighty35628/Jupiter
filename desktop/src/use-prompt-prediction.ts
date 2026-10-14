import { useCallback, useEffect, useRef, useState } from "react";
import type { OutgoingCommand } from "./protocol";
import { hasNativeWindow } from "./ui/surface";

const NOTICE_KEY = "jupiter:prediction-cost-notice:v1";

export function usePromptPrediction(args: {
  candidate?: { completionId: string; text?: string | null };
  active: boolean;
  ready: boolean;
  busy: boolean;
  enabled: boolean;
  blocked: boolean;
  hasDraft: boolean;
  transportAvailable: boolean;
  send: (command: OutgoingCommand) => Promise<void>;
  clear: () => void;
}) {
  const [visible, setVisible] = useState(() => !document.hidden);
  const [writable, setWritable] = useState(() => hasNativeWindow() || document.documentElement.dataset.webWriter === "true");
  const [noticeSeen, setNoticeSeen] = useState(() => {
    try { return localStorage.getItem(NOTICE_KEY) === "seen"; } catch { return false; }
  });
  const [noticeLingering, setNoticeLingering] = useState(false);
  useEffect(() => {
    if (!noticeLingering) return;
    const timer = window.setTimeout(() => setNoticeLingering(false), 8000);
    return () => window.clearTimeout(timer);
  }, [noticeLingering]);
  const attempted = useRef(new Set<string>());
  const invalidated = useRef(new Set<string>());
  const id = args.candidate?.completionId;
  const latest = useRef(args);
  latest.current = args;

  const dismiss = useCallback(() => {
    const current = latest.current;
    const completionId = current.candidate?.completionId;
    if (!completionId || invalidated.current.has(completionId)) return;
    invalidated.current.add(completionId);
    current.clear();
    if (current.transportAvailable && (hasNativeWindow() || document.documentElement.dataset.webWriter === "true")) {
      void current.send({ cmd: "prompt_prediction_dismiss", completionId }).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const visibility = () => { setVisible(!document.hidden); if (document.hidden) dismiss(); };
    const writer = (event: Event) => {
      const next = (event as CustomEvent<{ writable: boolean }>).detail?.writable === true;
      setWritable(next);
      if (!next) dismiss();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("jupiter:web-writer", writer);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("jupiter:web-writer", writer);
    };
  }, [dismiss]);

  const eligible = args.active && args.ready && !args.busy && args.enabled && !args.blocked &&
    !args.hasDraft && args.transportAvailable && visible && writable;
  useEffect(() => {
    if (!id || invalidated.current.has(id)) return;
    if (!args.active || args.busy || !args.enabled || args.hasDraft || !args.transportAvailable || !visible || !writable) {
      dismiss();
      return;
    }
    if (!eligible || !noticeSeen || attempted.current.has(id)) return;
    attempted.current.add(id);
    // Bound local markers; server-side admission remains authoritative.
    if (attempted.current.size > 64) attempted.current.delete(attempted.current.values().next().value!);
    if (invalidated.current.size > 64) invalidated.current.delete(invalidated.current.values().next().value!);
    void args.send({ cmd: "prompt_prediction_get", completionId: id }).catch(() => {
      if (latest.current.candidate?.completionId === id) dismiss();
    });
  }, [id, eligible, noticeSeen, args.active, args.busy, args.enabled, args.hasDraft, args.transportAvailable, visible, writable, args.send, dismiss]);

  const markNoticeSeen = useCallback(() => {
    try { localStorage.setItem(NOTICE_KEY, "seen"); } catch { /* This runtime still remembers the notice. */ }
    setNoticeSeen(true);
    setNoticeLingering(true);
  }, []);

  const text = args.candidate?.text;
  return {
    prediction: eligible && id && text && !invalidated.current.has(id) ? { id, text } : undefined,
    notice: eligible && !!id && (!noticeSeen || noticeLingering),
    markNoticeSeen,
    dismiss,
  };
}
