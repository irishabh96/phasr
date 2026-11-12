//! macOS side of dictation: microphone permission (AVFoundation), capture
//! (CoreAudio through cpal) and transcription (whisper.cpp with Metal).

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;
use serde::Serialize;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::audio;

/* ---------------------------------------------------------------- */
/* Permission                                                        */
/* ---------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MicAccess {
    Authorized,
    NotDetermined,
    Denied,
    Restricted,
}

pub fn mic_access() -> MicAccess {
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
        return MicAccess::Restricted;
    };
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) };
    match status {
        AVAuthorizationStatus::Authorized => MicAccess::Authorized,
        AVAuthorizationStatus::NotDetermined => MicAccess::NotDetermined,
        AVAuthorizationStatus::Denied => MicAccess::Denied,
        _ => MicAccess::Restricted,
    }
}

/// Show the system prompt (first time only) and wait for the answer.
pub async fn request_mic_access() -> bool {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
        return false;
    };
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    {
        // AVFoundation copies the block; ours is dropped before the await
        // (it isn't `Send`).
        let tx = std::sync::Mutex::new(Some(tx));
        let handler = RcBlock::new(move |granted: Bool| {
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(granted.as_bool());
            }
        });
        unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &handler) };
    }
    rx.await.unwrap_or(false)
}

/* ---------------------------------------------------------------- */
/* Capture                                                           */
/* ---------------------------------------------------------------- */

/// Ten minutes at the device rate, then the rest is dropped (the composer
/// stops you well before this; it only bounds memory).
const MAX_SECONDS: usize = 600;

/// Audio from the default input, downmixed to mono at the device's rate.
/// The cpal stream isn't `Send`, so it lives on its own thread and is
/// dropped there when `stop` signals.
pub struct Recorder {
    samples: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    stop_tx: mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
    failed: Arc<AtomicBool>,
}

impl Recorder {
    pub fn start() -> Result<Self, String> {
        let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
        let failed = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let buf = samples.clone();
        let fail = failed.clone();
        let thread = std::thread::Builder::new()
            .name("phasr-dictation".into())
            .spawn(move || {
                let stream = match open_stream(buf, fail) {
                    Ok((stream, rate)) => {
                        let _ = ready_tx.send(Ok(rate));
                        stream
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                let _ = stop_rx.recv();
                drop(stream);
            })
            .map_err(|e| e.to_string())?;
        let rate = ready_rx
            .recv()
            .map_err(|_| "the microphone thread stopped".to_string())??;
        Ok(Self { samples, rate, stop_tx, thread: Some(thread), failed })
    }

    pub fn rate(&self) -> u32 {
        self.rate
    }

    /// The buffer the stream appends to, for the level meter.
    pub fn samples(&self) -> Arc<Mutex<Vec<f32>>> {
        self.samples.clone()
    }

    pub fn device_failed(&self) -> bool {
        self.failed.load(Ordering::Relaxed)
    }

    /// Close the microphone and hand back what was recorded.
    pub fn finish(mut self) -> Vec<f32> {
        self.close();
        std::mem::take(&mut *self.samples.lock())
    }

    fn close(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        self.close();
    }
}

fn open_stream(buf: Arc<Mutex<Vec<f32>>>, failed: Arc<AtomicBool>) -> Result<(cpal::Stream, u32), String> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or_else(|| "no microphone found".to_string())?;
    let supported = device.default_input_config().map_err(|e| format!("microphone unavailable: {e}"))?;
    let config = supported.config();
    let channels = config.channels as usize;
    let rate = config.sample_rate;
    let cap = rate as usize * MAX_SECONDS;
    let on_error = move |e: cpal::Error| {
        eprintln!("[phasr] dictation input error: {e}");
        failed.store(true, Ordering::Relaxed);
    };
    macro_rules! build {
        ($t:ty) => {{
            let buf = buf.clone();
            let mut scratch: Vec<f32> = Vec::new();
            device.build_input_stream::<$t, _, _>(
                config.clone(),
                move |data: &[$t], _| {
                    scratch.clear();
                    let as_f32: Vec<f32> = data.iter().map(|s| cpal::Sample::to_sample::<f32>(*s)).collect();
                    audio::downmix(&as_f32, channels, &mut scratch);
                    let mut b = buf.lock();
                    let room = cap.saturating_sub(b.len());
                    b.extend_from_slice(&scratch[..scratch.len().min(room)]);
                },
                on_error,
                None,
            )
        }};
    }
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => build!(f32),
        cpal::SampleFormat::I16 => build!(i16),
        cpal::SampleFormat::I32 => build!(i32),
        cpal::SampleFormat::U16 => build!(u16),
        other => return Err(format!("unsupported microphone format {other}")),
    }
    .map_err(|e| format!("couldn't open the microphone: {e}"))?;
    stream.play().map_err(|e| format!("couldn't start the microphone: {e}"))?;
    Ok((stream, rate))
}

/* ---------------------------------------------------------------- */
/* Transcription                                                     */
/* ---------------------------------------------------------------- */

/// The loaded model, kept between dictations (loading base.en takes a
/// few hundred ms; large-v3-turbo a second or two).
pub struct Engine {
    loaded: Mutex<Option<(String, Arc<WhisperContext>)>>,
}

impl Default for Engine {
    fn default() -> Self {
        whisper_rs::install_logging_hooks();
        Self { loaded: Mutex::new(None) }
    }
}

impl Engine {
    /// Load `path` as `model_id` unless it already is. Blocking.
    pub fn load(&self, model_id: &str, path: &Path) -> Result<Arc<WhisperContext>, String> {
        let mut slot = self.loaded.lock();
        if let Some((id, ctx)) = slot.as_ref() {
            if id == model_id {
                return Ok(ctx.clone());
            }
        }
        *slot = None;
        let ctx = WhisperContext::new_with_params(path, WhisperContextParameters::default())
            .map_err(|e| format!("couldn't load the speech model: {e}"))?;
        let ctx = Arc::new(ctx);
        *slot = Some((model_id.to_string(), ctx.clone()));
        Ok(ctx)
    }

    pub fn is_loaded(&self, model_id: &str) -> bool {
        self.loaded.lock().as_ref().is_some_and(|(id, _)| id == model_id)
    }

    pub fn unload(&self, model_id: &str) {
        let mut slot = self.loaded.lock();
        if slot.as_ref().is_some_and(|(id, _)| id == model_id) {
            *slot = None;
        }
    }

    /// 16 kHz mono in, text out. `language` is an ISO code or "auto";
    /// English-only models are always "en". Blocking.
    pub fn transcribe(
        &self,
        model_id: &str,
        path: &Path,
        samples: &[f32],
        language: &str,
    ) -> Result<String, String> {
        let ctx = self.load(model_id, path)?;
        let mut state = ctx.create_state().map_err(|e| format!("couldn't start transcribing: {e}"))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
        params.set_n_threads(threads as i32);
        params.set_language(Some(language));
        params.set_translate(false);
        params.set_no_context(true);
        params.set_no_timestamps(true);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        state.full(params, samples).map_err(|e| format!("transcription failed: {e}"))?;
        let texts: Vec<String> = state
            .as_iter()
            .filter_map(|seg| seg.to_str_lossy().ok().map(|s| s.into_owned()))
            .collect();
        Ok(audio::clean_transcript(texts.iter().map(String::as_str)))
    }
}
