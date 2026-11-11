use super::{model, Backend, Session, SpeechState, CANCEL, FINISH, RUNNING};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use parking_lot::Mutex;
use rubato::Resampler;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Once};
use std::time::{Duration, Instant};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const SAMPLE_RATE: usize = 16_000;
const MAX_SECONDS: usize = 60;
const POLL: Duration = Duration::from_millis(20);
pub(super) struct NativeBackend;

pub(super) fn normalize_language(language: &str) -> Result<String, String> {
    if language.len() > 32 || language.is_empty() {
        return Err("speech_unsupported_language".into());
    }
    let language = language.to_ascii_lowercase();
    if language == "auto" {
        return Ok(language);
    }
    // Do not silently describe Mandarin decoding as Cantonese support.
    if language == "zh-hk" || language == "yue" || language.starts_with("yue-") {
        return Err("speech_unsupported_language".into());
    }
    if !language
        .bytes()
        .all(|b| b.is_ascii_alphabetic() || b == b'-')
    {
        return Err("speech_unsupported_language".into());
    }
    let primary = language.split('-').next().unwrap_or("");
    if whisper_rs::get_lang_id(primary).is_none() {
        return Err("speech_unsupported_language".into());
    }
    Ok(primary.to_owned())
}

struct CaptureBuffer {
    samples: Vec<f32>,
    limit: usize,
    error: bool,
    limit_sent: bool,
}

impl CaptureBuffer {
    fn append<T: Sample>(&mut self, data: &[T], channels: usize)
    where
        f32: FromSample<T>,
    {
        let remaining = self.limit.saturating_sub(self.samples.len());
        self.samples
            .extend(data.chunks_exact(channels).take(remaining).map(|frame| {
                frame
                    .iter()
                    .map(|sample| {
                        let sample: f32 = sample.to_sample();
                        if sample.is_finite() {
                            sample.clamp(-1.0, 1.0)
                        } else {
                            0.0
                        }
                    })
                    .sum::<f32>()
                    / channels as f32
            }));
    }
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    buffer: Arc<Mutex<CaptureBuffer>>,
    session: Arc<Session>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let error_buffer = buffer.clone();
    let error_session = session.clone();
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                if session.control.load(Ordering::SeqCst) != RUNNING {
                    return;
                }
                let mut buffer = buffer.lock();
                buffer.append(data, channels);
                if buffer.samples.len() == buffer.limit && !buffer.limit_sent {
                    buffer.limit_sent = true;
                    let _ = session.control.compare_exchange(
                        RUNNING,
                        FINISH,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    );
                    let _ = session.wake.try_send(());
                }
            },
            move |_| {
                let mut buffer = error_buffer.lock();
                if !buffer.error {
                    buffer.error = true;
                    let _ = error_session.wake.try_send(());
                }
            },
            Some(Duration::from_secs(2)),
        )
        .map_err(|_| "speech_microphone_open_failed_check_permission_and_device".into())
}

impl Backend for NativeBackend {
    fn capture(
        &self,
        state: &SpeechState,
        session: &Arc<Session>,
        wake: mpsc::Receiver<()>,
    ) -> Result<Vec<f32>, String> {
        check_active(state, session)?;
        #[cfg(target_os = "macos")]
        microphone_permission(state, session)?;
        check_active(state, session)?;
        let device = cpal::default_host()
            .default_input_device()
            .ok_or("speech_no_input_device")?;
        let supported = device
            .default_input_config()
            .map_err(|_| "speech_input_device_unavailable")?;
        let config: cpal::StreamConfig = supported.clone().into();
        let rate = config.sample_rate.0 as usize;
        if !(8_000..=192_000).contains(&rate) || config.channels == 0 || config.channels > 32 {
            return Err("speech_input_format_unsupported".into());
        }
        let buffer = Arc::new(Mutex::new(CaptureBuffer {
            samples: Vec::with_capacity(rate * MAX_SECONDS),
            limit: rate * MAX_SECONDS,
            error: false,
            limit_sent: false,
        }));
        macro_rules! input {
            ($ty:ty) => {
                build_stream::<$ty>(&device, &config, buffer.clone(), session.clone())?
            };
        }
        let stream = match supported.sample_format() {
            cpal::SampleFormat::I8 => input!(i8),
            cpal::SampleFormat::I16 => input!(i16),
            cpal::SampleFormat::I24 => input!(cpal::I24),
            cpal::SampleFormat::I32 => input!(i32),
            cpal::SampleFormat::I64 => input!(i64),
            cpal::SampleFormat::U8 => input!(u8),
            cpal::SampleFormat::U16 => input!(u16),
            cpal::SampleFormat::U32 => input!(u32),
            cpal::SampleFormat::U64 => input!(u64),
            cpal::SampleFormat::F32 => input!(f32),
            cpal::SampleFormat::F64 => input!(f64),
            _ => return Err("speech_input_format_unsupported".into()),
        };
        // The pinned CPAL CoreAudio backport constructs input streams paused.
        // Setup can block without retaining the activation gate. If cancellation
        // commits meanwhile, the gated play below must have no side effect.
        check_active(state, session)?;
        if session.control.load(Ordering::SeqCst) != RUNNING {
            return Err("speech_no_audio".into());
        }
        state.capture_side_effect(session, || {
            stream
                .play()
                .map_err(|_| "speech_microphone_start_failed".to_string())
        })?;
        check_active(state, session)?;
        if !state.transition(session, "recording") {
            return Err("speech_cancelled".into());
        }
        let started = Instant::now();
        loop {
            if session.control.load(Ordering::SeqCst) != RUNNING {
                break;
            }
            if buffer.lock().error {
                return Err("speech_microphone_disconnected_or_permission_revoked".into());
            }
            #[cfg(target_os = "macos")]
            if !microphone_authorized() {
                return Err("speech_microphone_permission_revoked".into());
            }
            check_active(state, session)?;
            if started.elapsed() >= Duration::from_secs(MAX_SECONDS as u64) {
                let _ = session.control.compare_exchange(
                    RUNNING,
                    FINISH,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                );
                break;
            }
            if started.elapsed() >= Duration::from_secs(5) && buffer.lock().samples.is_empty() {
                return Err("speech_microphone_no_data".into());
            }
            let _ = wake.recv_timeout(POLL);
        }
        // The stream is owned and destroyed on this thread (CPAL is not Send on
        // every platform). Cancel wakes it immediately; callbacks also gate data.
        drop(stream);
        if session.control.load(Ordering::SeqCst) == CANCEL {
            return Err("speech_cancelled".into());
        }
        let mut buffer = buffer.lock();
        if buffer.error {
            return Err("speech_microphone_disconnected_or_permission_revoked".into());
        }
        if buffer.samples.is_empty() {
            return Err("speech_no_audio".into());
        }
        let samples = std::mem::take(&mut buffer.samples);
        drop(buffer);
        resample(samples, rate)
    }

    fn transcribe(
        &self,
        path: &Path,
        language: &str,
        mut audio: Vec<f32>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<String, String> {
        model::verify_file(path, &cancelled)?;
        if audio.is_empty() || audio.len() > SAMPLE_RATE * MAX_SECONDS {
            return Err("speech_invalid_audio_length".into());
        }
        // Silence guard supplements Whisper's segment no-speech probability.
        // It is not a claimed VAD/quality benchmark.
        let rms = (audio
            .iter()
            .map(|sample| (*sample as f64).powi(2))
            .sum::<f64>()
            / audio.len() as f64)
            .sqrt();
        if rms < 0.003 {
            return Ok(String::new());
        }
        audio.resize(audio.len().max(SAMPLE_RATE), 0.0);
        static LOGGING: Once = Once::new();
        LOGGING.call_once(|| {
            // No native decoder logs or transcript fragments in application logs.
            unsafe { whisper_rs::set_log_callback(Some(discard_log), std::ptr::null_mut()) };
        });
        let mut options = WhisperContextParameters::default();
        options.use_gpu(false);
        let path = path.to_str().ok_or("speech_model_path_encoding")?;
        let context = WhisperContext::new_with_params(path, options)
            .map_err(|_| "speech_model_load_failed")?;
        if cancelled.load(Ordering::SeqCst) {
            return Err("speech_cancelled".into());
        }
        let mut decoder = context
            .create_state()
            .map_err(|_| "speech_decoder_unavailable")?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(
            std::thread::available_parallelism().map_or(2, |n| n.get().min(4)) as i32,
        );
        params.set_translate(false);
        params.set_language(if language == "auto" {
            None
        } else {
            Some(language)
        });
        // detect_language=true performs detection ONLY; None above detects and transcribes.
        params.set_detect_language(false);
        params.set_no_context(true);
        params.set_no_timestamps(true);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        // The Arc and its AtomicBool outlive full(). Avoid the binding's boxed
        // callback helper; a scoped raw callback has no allocation/leaked closure.
        unsafe {
            params.set_abort_callback(Some(abort_decode));
            params.set_abort_callback_user_data(Arc::as_ptr(&cancelled) as *mut std::ffi::c_void);
        }
        decoder
            .full(params, &audio)
            .map_err(|_| "speech_transcription_failed")?;
        if cancelled.load(Ordering::SeqCst) {
            return Err("speech_cancelled".into());
        }
        let mut text = String::new();
        for segment in decoder.as_iter() {
            if segment.no_speech_probability() < 0.6 {
                text.push_str(segment.to_str().map_err(|_| "speech_transcript_encoding")?);
            }
            if text.len() > 65_536 {
                return Err("speech_transcript_too_long".into());
            }
        }
        Ok(text.trim().to_owned())
    }
}

fn check_active(state: &SpeechState, session: &Session) -> Result<(), String> {
    if session.cancelled.load(Ordering::SeqCst)
        || !state.0.foreground.load(Ordering::SeqCst)
        || !state.0.page_ready.load(Ordering::SeqCst)
        || state.0.shutdown.load(Ordering::SeqCst)
        || !desktop_unlocked()
    {
        return Err("speech_cancelled".into());
    }
    Ok(())
}

unsafe extern "C" fn abort_decode(data: *mut std::ffi::c_void) -> bool {
    // User data is a live AtomicBool retained by transcribe() for the whole call.
    unsafe { (&*data.cast::<AtomicBool>()).load(Ordering::SeqCst) }
}

unsafe extern "C" fn discard_log(
    _: std::os::raw::c_uint,
    _: *const std::ffi::c_char,
    _: *mut std::ffi::c_void,
) {
}

pub(super) fn resample(input: Vec<f32>, rate: usize) -> Result<Vec<f32>, String> {
    if !(8_000..=192_000).contains(&rate) || input.len() > rate * MAX_SECONDS {
        return Err("speech_invalid_audio_length".into());
    }
    if input.is_empty() || rate == SAMPLE_RATE {
        return Ok(input);
    }
    let length = input.len() * SAMPLE_RATE / rate;
    let mut resampler = rubato::FftFixedInOut::<f32>::new(rate, SAMPLE_RATE, 1024, 1)
        .map_err(|_| "speech_resampler_unavailable")?;
    let delay = resampler.output_delay();
    let mut output = Vec::with_capacity(length + delay + resampler.output_frames_max());
    let mut offset = 0;
    while offset < input.len() {
        let count = resampler.input_frames_next().min(input.len() - offset);
        let block = resampler
            .process_partial(Some(&[&input[offset..offset + count]]), None)
            .map_err(|_| "speech_resampling_failed")?;
        output.extend_from_slice(&block[0]);
        offset += count;
    }
    while output.len() < length + delay {
        let block = resampler
            .process_partial::<&[f32]>(None, None)
            .map_err(|_| "speech_resampling_failed")?;
        output.extend_from_slice(&block[0]);
    }
    Ok(output[delay..delay + length].to_vec())
}

#[cfg(target_os = "macos")]
fn microphone_authorized() -> bool {
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    unsafe {
        AVCaptureDevice::authorizationStatusForMediaType(AVMediaTypeAudio.unwrap())
            == AVAuthorizationStatus::Authorized
    }
}

#[cfg(target_os = "macos")]
fn microphone_permission(state: &SpeechState, session: &Session) -> Result<(), String> {
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    let status =
        unsafe { AVCaptureDevice::authorizationStatusForMediaType(AVMediaTypeAudio.unwrap()) };
    if status == AVAuthorizationStatus::Authorized {
        return Ok(());
    }
    if status != AVAuthorizationStatus::NotDetermined {
        return Err("speech_microphone_permission_denied".into());
    }
    let (tx, rx) = mpsc::sync_channel(1);
    let callback = block2::RcBlock::new(move |granted: objc2::runtime::Bool| {
        let _ = tx.try_send(granted.as_bool());
    });
    state.capture_side_effect(session, || {
        check_active(state, session)?;
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(
                AVMediaTypeAudio.unwrap(),
                &callback,
            )
        };
        Ok(())
    })?;
    let started = Instant::now();
    loop {
        if session.control.load(Ordering::SeqCst) != RUNNING {
            return Err("speech_cancelled".into());
        }
        match rx.recv_timeout(POLL) {
            Ok(true) => return Ok(()),
            Ok(false) => return Err("speech_microphone_permission_denied".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("speech_microphone_permission_failed".into())
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if started.elapsed() > Duration::from_secs(60) {
            return Err("speech_microphone_permission_timeout".into());
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn desktop_unlocked() -> bool {
    true
}

#[cfg(target_os = "windows")]
fn desktop_unlocked() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> *mut std::ffi::c_void;
        fn GetUserObjectInformationW(
            handle: *mut std::ffi::c_void,
            index: i32,
            info: *mut std::ffi::c_void,
            len: u32,
            needed: *mut u32,
        ) -> i32;
        fn CloseDesktop(handle: *mut std::ffi::c_void) -> i32;
    }
    unsafe {
        let desktop = OpenInputDesktop(0, 0, 1);
        if desktop.is_null() {
            return false;
        }
        let mut name = [0u16; 256];
        let mut needed = 0;
        let success = GetUserObjectInformationW(
            desktop,
            2,
            name.as_mut_ptr().cast(),
            std::mem::size_of_val(&name) as u32,
            &mut needed,
        );
        CloseDesktop(desktop);
        success != 0
            && String::from_utf16_lossy(
                &name[..name.iter().position(|c| *c == 0).unwrap_or(name.len())],
            )
            .eq_ignore_ascii_case("default")
    }
}

#[cfg(target_os = "macos")]
pub(super) struct LockNotice(Option<i32>);
#[cfg(target_os = "macos")]
extern "C" {
    fn notify_register_check(name: *const std::ffi::c_char, token: *mut i32) -> u32;
    fn notify_check(token: i32, changed: *mut i32) -> u32;
    fn notify_cancel(token: i32) -> u32;
}
#[cfg(target_os = "macos")]
impl LockNotice {
    pub(super) fn new() -> Self {
        let mut token = 0;
        let valid =
            unsafe { notify_register_check(c"com.apple.screenIsLocked".as_ptr(), &mut token) == 0 };
        let notice = Self(valid.then_some(token));
        if let Some(token) = notice.0 {
            let mut changed = 0;
            unsafe {
                notify_check(token, &mut changed);
            }
        }
        notice
    }
    pub(super) fn locked(&mut self) -> bool {
        self.0.is_some_and(|token| {
            let mut changed = 0;
            unsafe { notify_check(token, &mut changed) == 0 && changed != 0 }
        })
    }
}
#[cfg(target_os = "macos")]
impl Drop for LockNotice {
    fn drop(&mut self) {
        if let Some(token) = self.0 {
            unsafe {
                notify_cancel(token);
            }
        }
    }
}
