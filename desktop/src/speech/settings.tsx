import { invoke } from "@tauri-apps/api/core";
import { Download, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SpeechCapabilities } from "./controller";
import { speechCopy } from "./copy";
import { hasSpeechHost, readSpeechLanguage, readSpeechMode, saveSpeechLanguage, speechCapabilities, speechLanguages } from "./host";
import "./speech.css";

export function SpeechSettings() {
  const [caps, setCaps] = useState<SpeechCapabilities | null>(null);
  const [language, setLanguage] = useState(readSpeechLanguage);
  const [mode, setMode] = useState(readSpeechMode);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(false);
  const operationId = useRef(0);
  const capabilityId = useRef(0);
  const copy = speechCopy();
  useEffect(() => {
    if (!hasSpeechHost()) return;
    let disposed = false;
    const refresh = () => {
      const id = ++capabilityId.current;
      void speechCapabilities().then(value => {
        if (!disposed && id === capabilityId.current) setCaps(value);
      }).catch(() => {});
    };
    refresh();
    return () => { disposed = true; operationId.current++; capabilityId.current++; };
  }, []);
  useEffect(() => {
    if (!caps?.modelDownloading) return;
    let disposed = false;
    const timer = setInterval(() => {
      const id = ++capabilityId.current;
      void speechCapabilities().then(value => {
        if (!disposed && id === capabilityId.current) setCaps(value);
      }).catch(() => {});
    }, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [caps?.modelDownloading]);
  if (!caps) return null;
  const operation = async (command: string) => {
    const id = ++operationId.current;
    setWorking(true); setError(false);
    if (command === "speech_download_model") setCaps(value => value && ({ ...value, modelDownloading: true }));
    try { await invoke(command); }
    catch { if (id === operationId.current) setError(true); }
    finally {
      if (id === operationId.current) {
        setWorking(false);
        const statusId = ++capabilityId.current;
        const status = await speechCapabilities().catch(() => caps);
        if (id === operationId.current && statusId === capabilityId.current) setCaps(status);
        window.dispatchEvent(new Event("jupiter:speech-settings"));
      }
    }
  };
  const android = caps.backend === "android";
  return <section className="section speech-settings">
    <div className="stitle">{copy.title}</div>
    {!caps.available ? <div className="h" role="status">{copy.unavailable}</div> : <>
      <div className="setting-row">
        <label htmlFor="speech-language">{copy.language}</label>
        <select id="speech-language" className="field" value={!caps.autoLanguage && language === "auto" ? "" : language}
          onChange={e => { setLanguage(e.target.value); saveSpeechLanguage(e.target.value); }}>
          {!caps.autoLanguage && <option value="" disabled>{copy.language}</option>}
          {speechLanguages.filter(([id]) => id !== "auto" || caps.autoLanguage).map(([id, name]) =>
            <option key={id} value={id}>{id === "auto" ? copy.automatic : name}</option>)}
        </select>
      </div>
      {android ? <div className="setting-row">
        <label htmlFor="speech-mode">{copy.mode}</label>
        <select id="speech-mode" className="field" value={mode} onChange={e => {
          const selected = e.target.value === "system" ? "system" : "local";
          setMode(selected);
          try { localStorage.setItem("jupiter.speech.mode", selected); } catch { /* Optional storage. */ }
          window.dispatchEvent(new Event("jupiter:speech-settings"));
        }}>
          <option value="local" disabled={!caps.localAvailable}>{copy.local}</option>
          <option value="system" disabled={!caps.networkAvailable}>{copy.system}</option>
        </select>
      </div> : <div className="setting-row">
        <div className="l">
          <div className="n">{copy.model}</div>
          <div className="h">Hugging Face · ggerganov/whisper.cpp · ggml-base.bin</div>
          <div className="h">{caps.modelDownloading ? copy.downloading : caps.modelReady ? copy.installed : copy.missing}
            {caps.modelBytes > 0 ? ` · ${Math.ceil(caps.modelBytes / 1048576)} MiB` : ""}</div>
          {caps.modelDownloading && <progress aria-label={copy.downloading} max={1}
            value={typeof caps.modelProgress === "number" && Number.isFinite(caps.modelProgress)
              ? Math.max(0, Math.min(1, caps.modelProgress)) : undefined} />}
        </div>
        <button type="button" className="btn" disabled={working && !caps.modelDownloading}
          onClick={() => {
            if (caps.modelDownloading || caps.modelReady) void operation("speech_remove_model");
            else if (window.confirm(copy.consent)) void operation("speech_download_model");
          }}>
          {caps.modelReady || caps.modelDownloading ? <Trash2 size={14} /> : <Download size={14} />}
          {caps.modelDownloading ? copy.cancel : caps.modelReady ? copy.remove : copy.download}
        </button>
      </div>}
      <div className="h">{android && mode === "system" ? copy.privacy : copy.localPrivacy}</div>
      {error && <div role="alert" className="h">{copy.downloadError}</div>}
    </>}
  </section>;
}
