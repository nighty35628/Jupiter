import { Mic, StopCircle } from "lucide-react";
import { I } from "../icons";
import { speechCopy } from "./copy";
import type { SpeechUi } from "./use-speech-draft";
import "./speech.css";

export function SpeechButton({ speech }: { speech: SpeechUi }) {
  if (!speech.capabilities?.available) return null;
  const copy = speechCopy();
  const recording = speech.phase === "recording";
  return <button type="button" className="composer-plus-btn speech-mic"
    aria-label={recording ? copy.finish : copy.start} title={recording ? copy.finish : copy.start}
    aria-pressed={recording}
    disabled={!!speech.candidate || speech.phase === "preparing" || speech.phase === "transcribing"}
    onClick={() => void speech.toggle()}>
    {recording ? <StopCircle size={16} /> : <Mic size={16} />}
  </button>;
}

export function SpeechStatus({ speech }: { speech: SpeechUi }) {
  const copy = speechCopy();
  if (speech.error) return <div className="speech-status" role="alert">
    <span>{copy.error}</span><button type="button" className="icon-btn" title={copy.discard}
      aria-label={copy.discard} onClick={speech.discard}><I.x size={13} /></button>
  </div>;
  if (speech.candidate) return <div className="speech-status speech-candidate" role="status">
    <span dir="auto">{speech.candidate}</span>
    <button type="button" className="btn" onClick={speech.insert}>{copy.insert}</button>
    <button type="button" className="icon-btn" title={copy.discard} aria-label={copy.discard}
      onClick={speech.discard}><I.x size={13} /></button>
  </div>;
  if (speech.phase === "idle") return null;
  return <div className="speech-status" role="status">
    <span>{copy[speech.phase]}{speech.phase === "recording" ? ` · ${copy.limit}` : ""}</span>
    {speech.preview && <span className="speech-preview" dir="auto">{speech.preview}</span>}
    <button type="button" className="icon-btn" title={copy.cancel} aria-label={copy.cancel}
      onClick={speech.cancel}><I.x size={13} /></button>
  </div>;
}
