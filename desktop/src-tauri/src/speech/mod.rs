//! Local, request-scoped dictation. Audio never touches disk or the network.
//! The worker retains its lease until capture/context teardown has completed.

#[cfg(speech_native)]
mod model;
#[cfg(speech_native)]
mod native;
#[cfg(test)]
mod tests;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{mpsc, Arc};
use tauri::{ipc::Channel, Manager};

pub const MODEL_BYTES: u64 = 147_951_465;
pub const MODEL_SHA256: &str = "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
pub const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin";
const MODEL_NAME: &str = "ggml-base.bin";
const SUPPORTED: bool = cfg!(speech_native);
const RUNNING: u8 = 0;
const FINISH: u8 = 1;
const CANCEL: u8 = 2;
const MAX_SESSION_IDS: usize = 65_536;
const CHANNEL_DIRECT_JSON_LIMIT: usize = 8192;
const RESULT_FRAGMENT_BYTES: usize = 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCapabilities {
    available: bool,
    backend: &'static str,
    local_available: bool,
    network_available: bool,
    auto_language: bool,
    model_ready: bool,
    model_bytes: u64,
    model_downloading: bool,
    model_progress: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechEvent {
    session_id: String,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    part: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last: Option<bool>,
}

// Keep every payload on Tauri's direct-eval Channel path. Its large-message
// fallback uses an application-wide IPC queue, not a webview-owned queue.
fn channel_messages(event: SpeechEvent) -> Result<Vec<SpeechEvent>, String> {
    let bytes = serde_json::to_vec(&event).map_err(|_| "speech_event_encoding")?;
    if bytes.len() < CHANNEL_DIRECT_JSON_LIMIT {
        return Ok(vec![event]);
    }
    if event.state != "result" || event.text.is_none() {
        return Err("speech_event_too_large".into());
    }
    let text = event.text.as_deref().unwrap_or_default();
    let mut messages = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + RESULT_FRAGMENT_BYTES).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let message = SpeechEvent {
            session_id: event.session_id.clone(),
            state: "result".into(),
            text: Some(text[start..end].to_owned()),
            error: None,
            part: Some(messages.len()),
            last: Some(end == text.len()),
        };
        if serde_json::to_vec(&message)
            .map_err(|_| "speech_event_encoding")?
            .len()
            >= CHANNEL_DIRECT_JSON_LIMIT
        {
            return Err("speech_event_too_large".into());
        }
        messages.push(message);
        start = end;
    }
    if messages.is_empty() {
        return Err("speech_event_too_large".into());
    }
    Ok(messages)
}

struct Session {
    id: String,
    language: String,
    control: AtomicU8,
    cancelled: Arc<AtomicBool>,
    terminal: AtomicBool,
    wake: mpsc::SyncSender<()>,
    on_event: Channel<SpeechEvent>,
    // Only short activation/request calls, never permission waits or device setup.
    activation: Mutex<()>,
}

struct Download {
    epoch: u64,
    cancelled: AtomicBool,
    bytes: std::sync::atomic::AtomicU64,
    #[cfg(speech_native)]
    wake: tokio::sync::Notify,
}

impl Download {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        #[cfg(speech_native)]
        self.wake.notify_one();
    }
}

#[derive(Default)]
struct Inner {
    session: Option<Arc<Session>>,
    used_ids: HashSet<String>,
    model_ready: bool,
    model_epoch: u64,
    download: Option<Arc<Download>>,
}

struct Shared {
    inner: Mutex<Inner>,
    model_path: PathBuf,
    foreground: AtomicBool,
    page_ready: AtomicBool,
    shutdown: AtomicBool,
}

#[derive(Clone)]
pub struct SpeechState(Arc<Shared>);

trait Backend: Send + Sync + 'static {
    fn capture(
        &self,
        state: &SpeechState,
        session: &Arc<Session>,
        wake: mpsc::Receiver<()>,
    ) -> Result<Vec<f32>, String>;
    fn transcribe(
        &self,
        path: &std::path::Path,
        language: &str,
        audio: Vec<f32>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<String, String>;
}

// Scope guards own a particular generation, never just a reused string ID.
struct WorkerLease(SpeechState, Arc<Session>);
impl Drop for WorkerLease {
    fn drop(&mut self) {
        let mut inner = self.0 .0.inner.lock();
        if inner
            .session
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &self.1))
        {
            inner.session = None;
        }
    }
}

impl SpeechState {
    fn new(path: PathBuf) -> Self {
        Self(Arc::new(Shared {
            inner: Mutex::new(Inner::default()),
            model_path: path,
            foreground: AtomicBool::new(true),
            page_ready: AtomicBool::new(true),
            shutdown: AtomicBool::new(false),
        }))
    }

    fn capabilities(&self) -> SpeechCapabilities {
        let inner = self.0.inner.lock();
        SpeechCapabilities {
            available: SUPPORTED,
            backend: "whisper",
            local_available: SUPPORTED,
            network_available: false,
            auto_language: true,
            model_ready: SUPPORTED && inner.model_ready,
            model_bytes: MODEL_BYTES,
            model_downloading: inner.download.is_some(),
            model_progress: inner.download.as_ref().map_or(0.0, |download| {
                (download.bytes.load(Ordering::Relaxed) as f64 / MODEL_BYTES as f64).clamp(0.0, 1.0)
            }),
        }
    }

    fn is_current(inner: &Inner, session: &Arc<Session>) -> bool {
        inner
            .session
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, session))
            && !session.terminal.load(Ordering::SeqCst)
    }

    fn event(&self, session: &Session, state: &'static str, value: Option<String>) {
        let message = SpeechEvent {
            session_id: session.id.clone(),
            state: state.into(),
            text: if state == "result" {
                value.clone()
            } else {
                None
            },
            error: if state == "error" { value } else { None },
            part: None,
            last: None,
        };
        let delivered = channel_messages(message).and_then(|messages| {
            for message in messages {
                session
                    .on_event
                    .send(message)
                    .map_err(|_| "speech_channel_closed")?;
            }
            Ok(())
        });
        if delivered.is_err() {
            session.cancelled.store(true, Ordering::SeqCst);
            session.control.store(CANCEL, Ordering::SeqCst);
            session.terminal.store(true, Ordering::SeqCst);
            let _ = session.wake.try_send(());
        }
    }

    fn transition(&self, session: &Arc<Session>, state: &'static str) -> bool {
        let inner = self.0.inner.lock();
        if !Self::is_current(&inner, session) {
            return false;
        }
        self.event(session, state, None);
        true
    }

    fn complete(&self, session: &Arc<Session>, result: Result<String, String>) {
        let inner = self.0.inner.lock();
        if !Self::is_current(&inner, session) {
            return;
        }
        session.terminal.store(true, Ordering::SeqCst);
        match result {
            Ok(text) => self.event(session, "result", Some(text)),
            Err(error) => self.event(session, "error", Some(error)),
        }
    }

    fn start_with(
        &self,
        id: String,
        language: String,
        on_event: Channel<SpeechEvent>,
        backend: Arc<dyn Backend>,
    ) -> Result<(), String> {
        validate_id(&id)?;
        let (tx, rx) = mpsc::sync_channel(1);
        let session = Arc::new(Session {
            id,
            language,
            control: AtomicU8::new(RUNNING),
            cancelled: Arc::new(AtomicBool::new(false)),
            terminal: AtomicBool::new(false),
            wake: tx,
            on_event,
            activation: Mutex::new(()),
        });
        {
            let mut inner = self.0.inner.lock();
            if self.0.shutdown.load(Ordering::SeqCst)
                || !self.0.foreground.load(Ordering::SeqCst)
                || !self.0.page_ready.load(Ordering::SeqCst)
            {
                return Err("speech_not_foreground".into());
            }
            if inner.session.is_some() {
                return Err("speech_busy_cleanup_pending".into());
            }
            if inner.download.is_some() || !inner.model_ready {
                return Err("speech_model_not_ready".into());
            }
            if inner.used_ids.contains(&session.id) {
                return Err("speech_session_id_reused".into());
            }
            if inner.used_ids.len() >= MAX_SESSION_IDS {
                return Err("speech_session_limit_restart_required".into());
            }
            inner.used_ids.insert(session.id.clone());
            inner.session = Some(session.clone());
            self.event(&session, "preparing", None);
        }
        let state = self.clone();
        let worker_session = session.clone();
        if std::thread::Builder::new()
            .name("jupiter-speech".into())
            .spawn(move || {
                let _lease = WorkerLease(state.clone(), worker_session.clone());
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let audio = backend.capture(&state, &worker_session, rx)?;
                    if !state.transition(&worker_session, "transcribing") {
                        return Ok(String::new());
                    }
                    backend.transcribe(
                        &state.0.model_path,
                        &worker_session.language,
                        audio,
                        worker_session.cancelled.clone(),
                    )
                }))
                .unwrap_or_else(|_| Err("speech_worker_failed".into()));
                state.complete(&worker_session, result);
            })
            .is_err()
        {
            self.complete(&session, Err("speech_worker_unavailable".into()));
            drop(WorkerLease(self.clone(), session));
            return Err("speech_worker_unavailable".into());
        }
        Ok(())
    }

    fn finish(&self, id: &str) -> Result<(), String> {
        let inner = self.0.inner.lock();
        let session = matching_session(&inner, id)?;
        let _activation = session.activation.lock();
        let _ =
            session
                .control
                .compare_exchange(RUNNING, FINISH, Ordering::SeqCst, Ordering::SeqCst);
        let _ = session.wake.try_send(());
        Ok(())
    }

    fn cancel_locked(&self, session: &Session) {
        let _activation = session.activation.lock();
        session.cancelled.store(true, Ordering::SeqCst);
        session.control.store(CANCEL, Ordering::SeqCst);
        let _ = session.wake.try_send(());
        if !session.terminal.swap(true, Ordering::SeqCst) {
            self.event(session, "cancelled", None);
        }
    }

    fn cancel(&self, id: &str) -> Result<(), String> {
        let inner = self.0.inner.lock();
        self.cancel_locked(matching_session(&inner, id)?);
        Ok(())
    }

    pub fn cancel_current(&self) {
        let inner = self.0.inner.lock();
        if let Some(session) = &inner.session {
            self.cancel_locked(session);
        }
    }

    pub fn set_foreground(&self, foreground: bool) {
        self.0.foreground.store(foreground, Ordering::SeqCst);
        if !foreground {
            self.cancel_current();
        }
    }

    fn capture_side_effect<T>(
        &self,
        session: &Session,
        effect: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _activation = session.activation.lock();
        if session.control.load(Ordering::SeqCst) != RUNNING
            || session.terminal.load(Ordering::SeqCst)
            || !self.0.foreground.load(Ordering::SeqCst)
            || !self.0.page_ready.load(Ordering::SeqCst)
            || self.0.shutdown.load(Ordering::SeqCst)
        {
            return Err("speech_cancelled".into());
        }
        effect()
    }

    pub fn page_load(&self, label: &str, loading: bool) {
        if label != "main" {
            return;
        }
        self.0.page_ready.store(!loading, Ordering::SeqCst);
        if loading {
            self.cancel_current();
        }
    }

    pub fn shutdown(&self) {
        self.0.shutdown.store(true, Ordering::SeqCst);
        self.set_foreground(false);
        if let Some(download) = &self.0.inner.lock().download {
            download.cancel();
        }
    }
}

fn matching_session<'a>(inner: &'a Inner, id: &str) -> Result<&'a Arc<Session>, String> {
    validate_id(id)?;
    inner
        .session
        .as_ref()
        .filter(|session| session.id == id)
        .ok_or_else(|| "speech_session_not_current".into())
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("speech_invalid_session_id".into());
    }
    Ok(())
}

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("speech_main_window_only".into());
    }
    Ok(())
}

#[tauri::command]
pub fn speech_capabilities(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SpeechState>,
) -> Result<SpeechCapabilities, String> {
    main_only(&window)?;
    Ok(state.capabilities())
}

#[tauri::command(rename_all = "camelCase")]
pub fn speech_start(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SpeechState>,
    session_id: String,
    language: String,
    mode: String,
    on_event: Channel<SpeechEvent>,
) -> Result<(), String> {
    main_only(&window)?;
    if mode != "local" {
        return Err("speech_local_mode_only".into());
    }
    if !window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(true)
        || !window.is_focused().unwrap_or(false)
    {
        return Err("speech_not_foreground".into());
    }
    #[cfg(speech_native)]
    return state.start_with(
        session_id,
        native::normalize_language(&language)?,
        on_event,
        Arc::new(native::NativeBackend),
    );
    #[cfg(not(speech_native))]
    {
        let _ = (state, session_id, language, on_event);
        Err("speech_unsupported_platform".into())
    }
}

#[tauri::command]
pub fn speech_finish(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SpeechState>,
    session_id: String,
) -> Result<(), String> {
    main_only(&window)?;
    state.finish(&session_id)
}

#[tauri::command]
pub fn speech_cancel(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SpeechState>,
    session_id: String,
) -> Result<(), String> {
    main_only(&window)?;
    state.cancel(&session_id)
}

#[tauri::command]
pub async fn speech_download_model(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SpeechState>,
) -> Result<(), String> {
    main_only(&window)?;
    #[cfg(speech_native)]
    return state.download_model().await;
    #[cfg(not(speech_native))]
    {
        let _ = state;
        Err("speech_unsupported_platform".into())
    }
}

#[tauri::command]
pub fn speech_remove_model(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SpeechState>,
) -> Result<(), String> {
    main_only(&window)?;
    #[cfg(speech_native)]
    return state.remove_model();
    #[cfg(not(speech_native))]
    {
        let _ = state;
        Err("speech_unsupported_platform".into())
    }
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let state = SpeechState::new(
        app.path()
            .app_local_data_dir()?
            .join("speech")
            .join(MODEL_NAME),
    );
    app.manage(state.clone());
    #[cfg(speech_native)]
    state.verify_cached_model();
    let handle = app.clone();
    std::thread::Builder::new()
        .name("jupiter-speech-lifecycle".into())
        .spawn(move || {
            #[cfg(target_os = "macos")]
            let mut lock_notice = native::LockNotice::new();
            while !state.0.shutdown.load(Ordering::SeqCst) {
                let foreground = handle.get_webview_window("main").is_some_and(|window| {
                    window.is_visible().unwrap_or(false)
                        && !window.is_minimized().unwrap_or(true)
                        && window.is_focused().unwrap_or(false)
                });
                state.set_foreground(foreground);
                #[cfg(target_os = "macos")]
                if lock_notice.locked() {
                    state.cancel_current();
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        })?;
    Ok(())
}
