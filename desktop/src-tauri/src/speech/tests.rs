use super::*;
use parking_lot::Condvar;
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::time::{Duration, Instant};

#[path = "../../vendor/cpal/src/host/alsa/capture_gate.rs"]
mod alsa_capture_gate;
#[path = "../../vendor/cpal/src/host/wasapi/start_ack.rs"]
mod wasapi_start_ack;

pub(super) struct Harness {
    pub(super) state: SpeechState,
    pub(super) root: PathBuf,
    events: Arc<Mutex<Vec<SpeechEvent>>>,
}

impl Harness {
    pub(super) fn new(ready: bool) -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "jupiter-speech-test-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let state = SpeechState::new(root.join(MODEL_NAME));
        state.0.inner.lock().model_ready = ready;
        Self {
            state,
            root,
            events,
        }
    }
    fn wait_state(&self, name: &str) {
        wait_until(|| self.events.lock().iter().any(|event| event.state == name));
    }
    fn wait_idle(&self) {
        wait_until(|| self.state.0.inner.lock().session.is_none());
    }
    fn states(&self) -> Vec<String> {
        self.events.lock().iter().map(|e| e.state.clone()).collect()
    }
    fn channel(&self) -> Channel<SpeechEvent> {
        collecting_channel(self.events.clone())
    }
    fn start(&self, id: &str, backend: &Arc<FakeBackend>) -> Result<(), String> {
        self.state
            .start_with(id.into(), "en".into(), self.channel(), backend.clone())
    }
}

fn collecting_channel(events: Arc<Mutex<Vec<SpeechEvent>>>) -> Channel<SpeechEvent> {
    Channel::new(move |body| {
        match body {
            tauri::ipc::InvokeResponseBody::Json(json) => {
                events.lock().push(serde_json::from_str(&json).unwrap());
            }
            _ => panic!("speech channel must serialize JSON"),
        }
        Ok(())
    })
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.state.shutdown();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "speech test timed out (no retries)"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

struct Gate(Mutex<bool>, Condvar);
impl Gate {
    fn new(open: bool) -> Self {
        Self(Mutex::new(open), Condvar::new())
    }
    fn wait(&self) {
        let mut open = self.0.lock();
        while !*open {
            self.1.wait(&mut open);
        }
    }
    fn open(&self) {
        *self.0.lock() = true;
        self.1.notify_all();
    }
}

struct FakeBackend {
    before_permission: Gate,
    permission: Gate,
    setup: Gate,
    inference: Gate,
    permission_requests: AtomicUsize,
    activations: AtomicUsize,
    calls: AtomicUsize,
    capture_error: Option<&'static str>,
}
impl FakeBackend {
    fn new(permission: bool, inference: bool) -> Arc<Self> {
        Arc::new(Self {
            before_permission: Gate::new(true),
            permission: Gate::new(permission),
            setup: Gate::new(true),
            inference: Gate::new(inference),
            permission_requests: AtomicUsize::new(0),
            activations: AtomicUsize::new(0),
            calls: AtomicUsize::new(0),
            capture_error: None,
        })
    }
}
impl Backend for FakeBackend {
    fn capture(
        &self,
        state: &SpeechState,
        session: &Arc<Session>,
        wake: mpsc::Receiver<()>,
    ) -> Result<Vec<f32>, String> {
        self.before_permission.wait();
        state.capture_side_effect(session, || {
            self.permission_requests.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })?;
        self.permission.wait();
        if let Some(error) = self.capture_error {
            return Err(error.into());
        }
        self.setup.wait();
        state.capture_side_effect(session, || {
            self.activations.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })?;
        if !state.transition(session, "recording") {
            return Err("speech_cancelled".into());
        }
        while session.control.load(Ordering::SeqCst) == RUNNING {
            let _ = wake.recv_timeout(Duration::from_millis(10));
        }
        Ok(vec![0.1; 16_000])
    }
    fn transcribe(
        &self,
        _: &std::path::Path,
        _: &str,
        _: Vec<f32>,
        _: Arc<AtomicBool>,
    ) -> Result<String, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inference.wait();
        Ok("fixture transcript".into())
    }
}

#[test]
fn finish_returns_promptly_and_delivers_only_one_final_event() {
    let h = Harness::new(true);
    let backend = FakeBackend::new(true, false);
    h.start("request-1", &backend).unwrap();
    h.wait_state("recording");
    h.state.finish("request-1").unwrap();
    h.wait_state("transcribing");
    h.state.finish("request-1").unwrap();
    backend.inference.open();
    h.wait_idle();
    assert_eq!(
        h.states(),
        ["preparing", "recording", "transcribing", "result"]
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        h.events.lock().last().unwrap().text.as_deref(),
        Some("fixture transcript")
    );
}

#[test]
fn cancel_before_permission_returns_never_starts_recording() {
    let h = Harness::new(true);
    let backend = FakeBackend::new(false, true);
    h.start("permission", &backend).unwrap();
    wait_until(|| backend.permission_requests.load(Ordering::SeqCst) == 1);
    h.state.cancel("permission").unwrap();
    assert_eq!(h.states(), ["preparing", "cancelled"]);
    assert!(h.start("next", &backend).is_err());
    backend.permission.open();
    h.wait_idle();
    assert_eq!(h.states(), ["preparing", "cancelled"]);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn cancellation_during_inference_retains_lease_and_rejects_new_work() {
    let h = Harness::new(true);
    let backend = FakeBackend::new(true, false);
    h.start("first", &backend).unwrap();
    h.wait_state("recording");
    h.state.finish("first").unwrap();
    wait_until(|| backend.calls.load(Ordering::SeqCst) == 1);
    h.state.cancel("first").unwrap();
    h.state.cancel("first").unwrap();
    assert!(h.start("second", &backend).is_err());
    #[cfg(speech_native)]
    assert!(h.state.remove_model().is_err());
    backend.inference.open();
    h.wait_idle();
    assert_eq!(
        h.states(),
        ["preparing", "recording", "transcribing", "cancelled"]
    );
}

#[test]
fn stale_command_and_stale_cleanup_cannot_touch_new_session() {
    let h = Harness::new(true);
    let backend = FakeBackend::new(true, true);
    h.start("old", &backend).unwrap();
    let old = h.state.0.inner.lock().session.clone().unwrap();
    h.state.cancel("old").unwrap();
    h.wait_idle();
    h.start("new", &backend).unwrap();
    assert!(h.state.cancel("old").is_err());
    assert!(h.state.finish("old").is_err());
    drop(WorkerLease(h.state.clone(), old.clone()));
    h.state.complete(&old, Ok("late result".into()));
    assert_eq!(h.state.0.inner.lock().session.as_ref().unwrap().id, "new");
    h.state.cancel("new").unwrap();
    h.wait_idle();
    assert!(!h.events.lock().iter().any(|event| event.text.is_some()));
}

#[test]
fn hide_focus_loss_and_shutdown_cancel_without_automatic_resume() {
    let h = Harness::new(true);
    let backend = FakeBackend::new(true, true);
    h.start("hidden", &backend).unwrap();
    h.wait_state("recording");
    h.state.set_foreground(false);
    h.wait_idle();
    assert!(h.start("background", &backend).is_err());
    h.state.set_foreground(true);
    assert_eq!(h.states(), ["preparing", "recording", "cancelled"]);
    h.start("exit", &backend).unwrap();
    h.state.shutdown();
    h.wait_idle();
    assert!(h.start("after-exit", &backend).is_err());
}

#[test]
fn denied_permission_or_disconnected_device_produces_one_error_not_inference() {
    for error in [
        "speech_microphone_permission_denied",
        "speech_no_input_device",
        "speech_microphone_disconnected",
    ] {
        let h = Harness::new(true);
        let mut backend = FakeBackend::new(true, true);
        Arc::get_mut(&mut backend).unwrap().capture_error = Some(error);
        h.start("failure", &backend).unwrap();
        h.wait_idle();
        assert_eq!(h.states(), ["preparing", "error"]);
        assert_eq!(
            h.events.lock().last().unwrap().error.as_deref(),
            Some(error)
        );
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn repeated_cancel_retry_cannot_reuse_session_ids() {
    let h = Harness::new(true);
    let backend = FakeBackend::new(true, true);
    for index in 0..20 {
        let id = format!("session-{index}");
        h.start(&id, &backend).unwrap();
        h.state.cancel(&id).unwrap();
        h.wait_idle();
        assert!(h.start(&id, &backend).is_err());
    }
    assert_eq!(
        h.events
            .lock()
            .iter()
            .filter(|e| e.state == "cancelled")
            .count(),
        20
    );
}

#[test]
fn invalid_ids_and_missing_models_do_not_start_capture() {
    let h = Harness::new(false);
    let backend = FakeBackend::new(false, false);
    for id in ["", "../file", "space id", "a.b", "\n"] {
        assert!(h.start(id, &backend).is_err());
    }
    assert!(h.start(&"x".repeat(129), &backend).is_err());
    assert!(h.start("valid-id", &backend).is_err());
    assert!(h.states().is_empty());
}

#[test]
fn cancel_before_permission_request_prevents_authorization_side_effect() {
    let h = Harness::new(true);
    let backend = FakeBackend::new(true, true);
    *backend.before_permission.0.lock() = false;
    h.start("before-permission", &backend).unwrap();
    h.state.cancel("before-permission").unwrap();
    backend.before_permission.open();
    h.wait_idle();
    assert_eq!(backend.permission_requests.load(Ordering::SeqCst), 0);
    assert_eq!(backend.activations.load(Ordering::SeqCst), 0);
    assert_eq!(h.states(), ["preparing", "cancelled"]);
}

#[test]
fn cancel_during_paused_construction_prevents_late_activation() {
    let h = Harness::new(true);
    let backend = FakeBackend::new(true, true);
    *backend.setup.0.lock() = false;
    h.start("during-setup", &backend).unwrap();
    wait_until(|| backend.permission_requests.load(Ordering::SeqCst) == 1);
    h.state.cancel("during-setup").unwrap();
    assert_eq!(backend.activations.load(Ordering::SeqCst), 0);
    backend.setup.open();
    h.wait_idle();
    assert_eq!(backend.activations.load(Ordering::SeqCst), 0);
    assert_eq!(h.states(), ["preparing", "cancelled"]);
}

#[test]
fn activation_and_cancel_have_a_single_side_effect_order() {
    let h = Harness::new(true);
    let backend = FakeBackend::new(false, true);
    h.start("activation-order", &backend).unwrap();
    wait_until(|| backend.permission_requests.load(Ordering::SeqCst) == 1);
    let session = h.state.0.inner.lock().session.clone().unwrap();
    let effects = Arc::new(Mutex::new(Vec::new()));
    let entered = Arc::new(Gate::new(false));
    let release = Arc::new(Gate::new(false));
    let (state, current, trace, started, barrier) = (
        h.state.clone(),
        session.clone(),
        effects.clone(),
        entered.clone(),
        release.clone(),
    );
    let activate = std::thread::spawn(move || {
        state.capture_side_effect(&current, || {
            started.open();
            barrier.wait();
            trace.lock().push("activate");
            Ok(())
        })
    });
    entered.wait();
    let (state, trace) = (h.state.clone(), effects.clone());
    let cancel = std::thread::spawn(move || {
        state.cancel("activation-order").unwrap();
        trace.lock().push("cancel");
    });
    release.open();
    activate.join().unwrap().unwrap();
    cancel.join().unwrap();
    assert_eq!(*effects.lock(), ["activate", "cancel"]);
    assert!(h
        .state
        .capture_side_effect(&session, || {
            effects.lock().push("late-activate");
            Ok(())
        })
        .is_err());
    backend.permission.open();
    h.wait_idle();
    assert_eq!(*effects.lock(), ["activate", "cancel"]);
}

#[test]
fn main_navigation_cancels_even_without_focus_change_and_never_resumes() {
    let h = Harness::new(true);
    let backend = FakeBackend::new(true, true);
    h.start("reload", &backend).unwrap();
    h.wait_state("recording");
    h.state.page_load("pet-overlay", true);
    assert!(!h
        .state
        .0
        .inner
        .lock()
        .session
        .as_ref()
        .unwrap()
        .cancelled
        .load(Ordering::SeqCst));
    h.state.page_load("main", true);
    h.wait_idle();
    assert!(h.state.0.foreground.load(Ordering::SeqCst));
    assert!(h.start("while-navigating", &backend).is_err());
    h.state.page_load("main", false);
    assert_eq!(h.states(), ["preparing", "recording", "cancelled"]);
    h.start("after-reload", &backend).unwrap();
    h.state.cancel("after-reload").unwrap();
    h.wait_idle();
}

#[test]
fn transcripts_only_reach_the_current_sessions_owned_channel() {
    let h = Harness::new(true);
    let backend = FakeBackend::new(true, true);
    let first = Arc::new(Mutex::new(Vec::new()));
    let second = Arc::new(Mutex::new(Vec::new()));
    let spectator = Arc::new(Mutex::new(Vec::new()));
    let _spectator_channel = collecting_channel(spectator.clone());
    h.state
        .start_with(
            "owner-a".into(),
            "en".into(),
            collecting_channel(first.clone()),
            backend.clone(),
        )
        .unwrap();
    let old = h.state.0.inner.lock().session.clone().unwrap();
    h.state.cancel("owner-a").unwrap();
    h.wait_idle();
    h.state
        .start_with(
            "owner-b".into(),
            "en".into(),
            collecting_channel(second.clone()),
            backend.clone(),
        )
        .unwrap();
    wait_until(|| second.lock().iter().any(|event| event.state == "recording"));
    h.state.complete(&old, Ok("stale-secret".into()));
    h.state.finish("owner-b").unwrap();
    h.wait_idle();
    assert!(first.lock().iter().all(|event| event.text.is_none()));
    assert_eq!(
        second
            .lock()
            .iter()
            .filter(|event| event.text.is_some())
            .count(),
        1
    );
    assert!(second
        .lock()
        .iter()
        .all(|event| event.session_id == "owner-b"));
    assert!(spectator.lock().is_empty());
}

#[test]
fn pinned_coreaudio_input_constructor_does_not_start_capture() {
    let source = include_str!("../../vendor/cpal/src/host/coreaudio/macos/mod.rs");
    let (_, implementation) = source.rsplit_once("fn build_input_stream_raw").unwrap();
    let (constructor, _) = implementation
        .split_once("fn build_output_stream_raw")
        .unwrap();
    assert!(constructor.contains("playing: false"));
    assert!(!constructor.contains("audio_unit.start()"));
    assert!(source.contains("fn play(&mut self)"));
}

#[test]
fn capabilities_and_events_keep_the_frontend_wire_contract() {
    let h = Harness::new(false);
    let value = serde_json::to_value(h.state.capabilities()).unwrap();
    assert_eq!(value["available"], SUPPORTED);
    assert_eq!(value["backend"], "whisper");
    assert_eq!(value["localAvailable"], SUPPORTED);
    assert_eq!(value["networkAvailable"], false);
    assert_eq!(value["autoLanguage"], true);
    assert_eq!(value["modelReady"], false);
    assert_eq!(value["modelBytes"], MODEL_BYTES);
    assert_eq!(value["modelDownloading"], false);
    let event = SpeechEvent {
        session_id: "s".into(),
        state: "recording".into(),
        text: None,
        error: None,
        part: None,
        last: None,
    };
    assert_eq!(
        serde_json::to_value(event).unwrap(),
        serde_json::json!({"sessionId":"s", "state":"recording"})
    );
}

#[cfg(speech_native)]
#[test]
fn language_mapping_is_transcription_not_ui_translation() {
    for language in ["en", "zh", "ja", "ko", "de", "fr", "es", "ru", "auto"] {
        assert_eq!(native::normalize_language(language).unwrap(), language);
    }
    assert_eq!(native::normalize_language("en-US").unwrap(), "en");
    assert_eq!(native::normalize_language("zh-CN").unwrap(), "zh");
    for invalid in ["unknown", "zh-HK", "yue", "../en", "en\0"] {
        assert!(native::normalize_language(invalid).is_err());
    }
}

fn result_message(id: &str, text: &str) -> SpeechEvent {
    SpeechEvent {
        session_id: id.into(),
        state: "result".into(),
        text: Some(text.into()),
        error: None,
        part: None,
        last: None,
    }
}

#[test]
fn short_result_keeps_original_channel_format_and_threshold_is_strict() {
    let empty = result_message("short", "");
    let overhead = serde_json::to_vec(&empty).unwrap().len();
    let below = result_message(
        "short",
        &"x".repeat(CHANNEL_DIRECT_JSON_LIMIT - overhead - 1),
    );
    assert_eq!(serde_json::to_vec(&below).unwrap().len(), 8191);
    let messages = channel_messages(below.clone()).unwrap();
    assert_eq!(messages, [below]);
    let at_limit = result_message("short", &"x".repeat(CHANNEL_DIRECT_JSON_LIMIT - overhead));
    assert_eq!(serde_json::to_vec(&at_limit).unwrap().len(), 8192);
    let messages = channel_messages(at_limit).unwrap();
    assert!(messages.len() > 1);
    assert_eq!(messages[0].part, Some(0));
    assert_eq!(messages.last().unwrap().last, Some(true));
    let json = serde_json::to_value(channel_messages(empty).unwrap().remove(0)).unwrap();
    assert!(json.get("part").is_none());
    assert!(json.get("last").is_none());
}

#[test]
fn fragments_bound_utf8_and_escaped_json_and_reassemble_exact_text() {
    let texts = [
        "ascii-identifier/path.rs:42 ".repeat(500),
        "\0\u{1}\n\r\t\"\\\u{1f}".repeat(2000),
        "中文日本語한국어Русский😀e\u{301}\u{2028}".repeat(500),
        "\0".repeat(65_536),
    ];
    for text in texts {
        let messages = channel_messages(result_message(&"s".repeat(128), &text)).unwrap();
        assert!(messages.len() > 1);
        let mut restored = String::new();
        for (part, message) in messages.iter().enumerate() {
            assert_eq!(message.state, "result");
            assert_eq!(message.part, Some(part));
            assert_eq!(message.last, Some(part + 1 == messages.len()));
            let chunk = message.text.as_deref().unwrap();
            assert!(!chunk.is_empty());
            assert!(chunk.len() <= RESULT_FRAGMENT_BYTES);
            let serialized = serde_json::to_vec(message).unwrap();
            assert!(serialized.len() < CHANNEL_DIRECT_JSON_LIMIT);
            let decoded: SpeechEvent = serde_json::from_slice(&serialized).unwrap();
            restored.push_str(decoded.text.as_deref().unwrap());
        }
        assert_eq!(restored, text);
        assert_eq!(messages.iter().filter(|m| m.last == Some(true)).count(), 1);
    }
}

#[test]
fn actual_result_channel_only_receives_direct_sized_fragments() {
    let h = Harness::new(true);
    let backend = FakeBackend::new(false, true);
    h.start("fragmented", &backend).unwrap();
    wait_until(|| backend.permission_requests.load(Ordering::SeqCst) == 1);
    let session = h.state.0.inner.lock().session.clone().unwrap();
    let text = "\0\"\\中文😀".repeat(3000);
    h.state.complete(&session, Ok(text.clone()));
    backend.permission.open();
    h.wait_idle();
    let events = h.events.lock();
    assert!(events
        .iter()
        .all(|event| serde_json::to_vec(event).unwrap().len() < 8192));
    let results: Vec<_> = events
        .iter()
        .filter(|event| event.state == "result")
        .collect();
    assert!(results.len() > 1);
    assert_eq!(results[0].part, Some(0));
    assert_eq!(results.last().unwrap().last, Some(true));
    let restored: String = results
        .iter()
        .map(|event| event.text.as_deref().unwrap())
        .collect();
    assert_eq!(restored, text);
}

#[test]
fn oversized_non_result_is_rejected_instead_of_using_shared_queue() {
    let mut event = result_message("error", "");
    event.state = "error".into();
    event.text = None;
    event.error = Some("x".repeat(9000));
    assert!(channel_messages(event).is_err());
}

#[test]
fn vendor_capture_gate_blocks_reads_until_explicit_successful_play() {
    let capture = alsa_capture_gate::CaptureGate::new_paused();
    let effects = AtomicUsize::new(0);
    assert!(capture
        .read_if_playing(|| effects.fetch_add(1, Ordering::SeqCst))
        .is_none());
    assert_eq!(
        capture.activate(|| Err::<(), _>("start failed")),
        Err("start failed")
    );
    assert!(capture
        .read_if_playing(|| effects.fetch_add(1, Ordering::SeqCst))
        .is_none());
    assert_eq!(effects.load(Ordering::SeqCst), 0);
    assert_eq!(capture.activate(|| Ok::<_, ()>(())), Ok(true));
    assert!(capture.wait_for_play());
    assert!(capture
        .read_if_playing(|| effects.fetch_add(1, Ordering::SeqCst))
        .is_some());
    assert_eq!(capture.pause(|| Ok::<_, ()>(())), Ok(true));
    assert!(capture
        .read_if_playing(|| effects.fetch_add(1, Ordering::SeqCst))
        .is_none());
    capture.close(&AtomicBool::new(false), || {});
    assert!(!capture.wait_for_play());
    assert_eq!(
        capture.activate(|| {
            effects.fetch_add(1, Ordering::SeqCst);
            Ok::<_, ()>(())
        }),
        Ok(false)
    );
    assert_eq!(effects.load(Ordering::SeqCst), 1);
}

#[test]
fn vendor_capture_waiting_before_play_exits_on_close_without_reading() {
    let capture = Arc::new(alsa_capture_gate::CaptureGate::new_paused());
    let entered = Arc::new(Gate::new(false));
    let (state, ready) = (capture.clone(), entered.clone());
    let worker = std::thread::spawn(move || {
        ready.open();
        if state.wait_for_play() {
            state.read_if_playing(|| true)
        } else {
            None
        }
    });
    entered.wait();
    capture.close(&AtomicBool::new(false), || {});
    assert_eq!(worker.join().unwrap(), None);
}

#[test]
fn pinned_alsa_construction_and_worker_cannot_implicitly_start_input() {
    let source = include_str!("../../vendor/cpal/src/host/alsa/mod.rs");
    let (_, body) = source.split_once("fn build_stream_inner(").unwrap();
    let (constructor, _) = body.split_once("fn name(").unwrap();
    assert!(!constructor.contains("handle.start()"));
    assert!(constructor.contains("CaptureGate::new_paused()"));
    let (_, worker) = source.split_once("fn input_stream_worker(").unwrap();
    let (worker, _) = worker.split_once("fn output_stream_worker(").unwrap();
    assert!(worker.contains("capture.wait_for_play()"));
    assert!(worker.contains("capture.read_if_playing("));
    assert!(!worker.contains(".start()"));
    assert!(!worker.contains(".prepare()"));
    assert!(source.contains("sw_params.get_boundary()?"));
}

#[test]
fn alsa_capture_drop_does_not_publish_exit_before_its_last_wakeup() {
    let source = include_str!("../../vendor/cpal/src/host/alsa/mod.rs");
    let (_, body) = source.split_once("impl Drop for Stream {").unwrap();
    let (before_capture, _) = body.split_once("if let Some(capture)").unwrap();
    assert!(
        !before_capture.contains("dropping.store("),
        "a queued play wake may let the worker close its pipe before the final wake"
    );
}

#[test]
fn alsa_close_with_an_existing_play_wake_keeps_the_read_end_alive() {
    let capture = Arc::new(alsa_capture_gate::CaptureGate::new_paused());
    capture.activate(|| Ok::<_, ()>(())).unwrap();
    let dropping = Arc::new(AtomicBool::new(false));
    let enter_poll = Arc::new(Gate::new(false));
    let checked = Arc::new(Gate::new(false));
    let (tx, rx) = mpsc::sync_channel(2);
    tx.send(()).unwrap(); // Existing play wake, before the final close wake.
    let (state, exit, enter, observed) = (
        capture.clone(),
        dropping.clone(),
        enter_poll.clone(),
        checked.clone(),
    );
    let worker = std::thread::spawn(move || {
        enter.wait();
        let exit_published = exit.load(Ordering::SeqCst);
        rx.try_recv().unwrap();
        if exit_published {
            drop(rx);
            observed.open();
            return false;
        }
        observed.open();
        assert!(!state.wait_for_play());
        true
    });
    capture.close(&dropping, || {
        enter_poll.open();
        checked.wait();
        tx.send(())
            .expect("close wake must not write to a closed pipe");
    });
    assert!(dropping.load(Ordering::SeqCst));
    assert!(worker.join().unwrap());
}

#[test]
fn wasapi_ack_waits_for_actual_start_before_native_cancel_can_commit() {
    let h = Harness::new(true);
    let backend = FakeBackend::new(false, true);
    h.start("wasapi-ack", &backend).unwrap();
    wait_until(|| backend.permission_requests.load(Ordering::SeqCst) == 1);
    let current = h.state.0.inner.lock().session.clone().unwrap();
    let release = Arc::new(Gate::new(false));
    let entered = Arc::new(Gate::new(false));
    let trace = Arc::new(Mutex::new(Vec::new()));
    let (completion, acknowledgement) = mpsc::sync_channel(1);
    let (barrier, effects) = (release.clone(), trace.clone());
    let consumer = std::thread::spawn(move || {
        barrier.wait();
        effects.lock().push("actual-start");
        completion.send(Ok(())).unwrap();
    });
    let (state, started) = (h.state.clone(), entered.clone());
    let play = std::thread::spawn(move || {
        state.capture_side_effect(&current, || {
            started.open();
            wasapi_start_ack::wait_for_start(acknowledgement, "worker gone".to_string())
        })
    });
    entered.wait();
    let (state, effects) = (h.state.clone(), trace.clone());
    let cancel = std::thread::spawn(move || {
        state.cancel("wasapi-ack").unwrap();
        effects.lock().push("cancel-committed");
    });
    assert!(trace.lock().is_empty());
    release.open();
    consumer.join().unwrap();
    play.join().unwrap().unwrap();
    cancel.join().unwrap();
    backend.permission.open();
    h.wait_idle();
    assert_eq!(*trace.lock(), ["actual-start", "cancel-committed"]);
    let source = include_str!("../../vendor/cpal/src/host/wasapi/stream.rs");
    let (_, commands) = source.split_once("fn process_commands(").unwrap();
    assert!(commands.find(".Start()").unwrap() < commands.find("completion.send(").unwrap());
    assert!(source.contains("start_ack::wait_for_start("));
}

#[test]
fn wasapi_start_failure_or_disconnection_is_not_acknowledged_as_success() {
    let (tx, rx) = mpsc::sync_channel(1);
    tx.send(Err("start failed")).unwrap();
    assert_eq!(
        wasapi_start_ack::wait_for_start(rx, "gone"),
        Err("start failed")
    );
    let (tx, rx) = mpsc::sync_channel::<Result<(), &str>>(1);
    drop(tx);
    assert_eq!(wasapi_start_ack::wait_for_start(rx, "gone"), Err("gone"));
}

#[cfg(speech_native)]
#[test]
fn resampler_is_bounded_and_preserves_duration_at_common_capture_rates() {
    for rate in [8_000, 16_000, 44_100, 48_000, 96_000, 192_000] {
        let input: Vec<f32> = (0..rate)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.2)
            .collect();
        let output = native::resample(input, rate).unwrap();
        assert_eq!(output.len(), 16_000);
        assert!(output.iter().all(|sample| sample.is_finite()));
        let rms = (output[1000..15000].iter().map(|x| x * x).sum::<f32>() / 14_000.0).sqrt();
        assert!((0.13..0.15).contains(&rms), "bad RMS at {rate}: {rms}");
    }
    assert!(native::resample(vec![0.0; 60 * 16_000 + 1], 16_000).is_err());
}

#[cfg(speech_native)]
#[test]
#[ignore = "Explicit offline QA only: set JUPITER_SPEECH_MODEL and JUPITER_SPEECH_WAV; never opens microphone or downloads"]
fn file_inference() {
    let model = PathBuf::from(
        std::env::var_os("JUPITER_SPEECH_MODEL").expect("JUPITER_SPEECH_MODEL required"),
    );
    let wav =
        PathBuf::from(std::env::var_os("JUPITER_SPEECH_WAV").expect("JUPITER_SPEECH_WAV required"));
    let language = native::normalize_language(
        &std::env::var("JUPITER_SPEECH_LANGUAGE").unwrap_or_else(|_| "auto".into()),
    )
    .unwrap();
    let repeats: usize = std::env::var("JUPITER_SPEECH_REPEAT")
        .unwrap_or_else(|_| "1".into())
        .parse()
        .unwrap();
    assert!((1..=10).contains(&repeats));
    let mut reader = hound::WavReader::open(&wav).unwrap();
    let spec = reader.spec();
    assert_eq!(spec.channels, 1, "QA fixture must be mono");
    assert_eq!(spec.bits_per_sample, 16, "QA fixture must be 16-bit PCM");
    assert_eq!(spec.sample_format, hound::SampleFormat::Int);
    assert!((8_000..=192_000).contains(&spec.sample_rate));
    let input: Vec<f32> = reader
        .samples::<i16>()
        .take(spec.sample_rate as usize * 60 + 1)
        .map(|s| s.unwrap() as f32 / 32768.0)
        .collect();
    let audio = native::resample(input, spec.sample_rate as usize).unwrap();
    for index in 0..repeats {
        let start = Instant::now();
        let text = native::NativeBackend
            .transcribe(
                &model,
                &language,
                audio.clone(),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
        println!(
            "{}",
            serde_json::json!({
                "run": index + 1, "wav": wav, "language": language,
                "engine": whisper_rs::get_whisper_version(), "binding": "0.15.1",
                "modelBytes": MODEL_BYTES, "modelSha256": MODEL_SHA256,
                "sampleRate": 16000, "samples": audio.len(),
                "elapsedMs": start.elapsed().as_secs_f64() * 1000.0,
                "procedure": "fresh context per run; OS page cache uncontrolled; CPU max 4 threads",
                "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
                "text": text
            })
        );
        if wav.file_name().is_some_and(|name| name == "silence.wav") {
            assert!(text.is_empty(), "silence must not hallucinate text");
        }
    }
}
