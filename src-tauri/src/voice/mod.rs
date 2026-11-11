//! Voice input: dictate into the composer or the New task prompt, and
//! Whisper turns it into text on this Mac. Nothing is uploaded; the model is
//! downloaded once on request (never bundled) into
//! `<app data>/models/whisper/`.
//!
//! One dictation at a time: `start` opens the microphone (asking for
//! permission the first time) and meters it; `stop` closes it and returns
//! the text; `cancel` closes it and throws the audio away. Tauri-agnostic —
//! levels and download progress go out on a broadcast that
//! `commands::events` bridges.

// Off macOS only the model downloads work; capture and Whisper don't build.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

pub mod audio;
pub mod catalog;
#[cfg(target_os = "macos")]
mod mac;
pub mod models;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::broadcast;

use catalog::{Languages, ModelSpec, MODELS};
use models::{DownloadError, ModelStore};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModel {
    pub id: &'static str,
    pub label: &'static str,
    pub detail: &'static str,
    pub size_bytes: u64,
    pub languages: Languages,
    pub installed: bool,
    /// Bytes so far while a download is running.
    pub downloading: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DownloadPhase {
    Downloading,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProgress {
    pub model_id: &'static str,
    pub phase: DownloadPhase,
    pub downloaded: u64,
    pub total: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub enum VoiceEvent {
    /// The microphone's level, 0–1, every 50ms while dictating.
    Level(f32),
    Model(ModelProgress),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MicAccess {
    Authorized,
    NotDetermined,
    Denied,
    Restricted,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unsupported,
}

#[derive(Debug)]
pub enum VoiceError {
    UnknownModel(String),
    NotInstalled,
    MicDenied,
    NotDictating,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unsupported,
    Failed(String),
}

impl std::fmt::Display for VoiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownModel(id) => write!(f, "unknown voice model: {id}"),
            Self::NotInstalled => write!(f, "voice model not downloaded"),
            Self::MicDenied => write!(f, "microphone access denied"),
            Self::NotDictating => write!(f, "not dictating"),
            Self::Unsupported => write!(f, "voice input needs macOS"),
            Self::Failed(e) => write!(f, "{e}"),
        }
    }
}

struct Download {
    cancel: AtomicBool,
    downloaded: AtomicU64,
}

#[cfg(target_os = "macos")]
struct Dictation {
    recorder: mac::Recorder,
    model: &'static ModelSpec,
    meter: tokio::task::JoinHandle<()>,
}

pub struct VoiceService {
    store: ModelStore,
    events: broadcast::Sender<VoiceEvent>,
    downloads: Mutex<HashMap<&'static str, Arc<Download>>>,
    #[cfg(target_os = "macos")]
    dictation: tokio::sync::Mutex<Option<Dictation>>,
    #[cfg(target_os = "macos")]
    engine: Arc<mac::Engine>,
}

impl VoiceService {
    pub fn new(models_dir: PathBuf) -> Arc<Self> {
        let (events, _) = broadcast::channel(64);
        Arc::new(Self {
            store: ModelStore::new(models_dir),
            events,
            downloads: Mutex::new(HashMap::new()),
            #[cfg(target_os = "macos")]
            dictation: tokio::sync::Mutex::new(None),
            #[cfg(target_os = "macos")]
            engine: Arc::new(mac::Engine::default()),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<VoiceEvent> {
        self.events.subscribe()
    }

    fn spec(id: &str) -> Result<&'static ModelSpec, VoiceError> {
        catalog::find(id).ok_or_else(|| VoiceError::UnknownModel(id.to_string()))
    }

    pub fn list(&self) -> Vec<VoiceModel> {
        let downloads = self.downloads.lock();
        MODELS
            .iter()
            .map(|m| VoiceModel {
                id: m.id,
                label: m.label,
                detail: m.detail,
                size_bytes: m.size,
                languages: m.languages,
                installed: self.store.is_installed(m),
                downloading: downloads.get(m.id).map(|d| d.downloaded.load(Ordering::Relaxed)),
            })
            .collect()
    }

    /// Start downloading in the background; progress and the outcome
    /// arrive as `VoiceEvent::Model`. A second call while one runs is a
    /// no-op.
    pub fn download(self: &Arc<Self>, id: &str) -> Result<(), VoiceError> {
        let spec = Self::spec(id)?;
        if self.store.is_installed(spec) {
            self.emit_progress(spec, DownloadPhase::Done, spec.size, None);
            return Ok(());
        }
        let dl = {
            let mut downloads = self.downloads.lock();
            if downloads.contains_key(spec.id) {
                return Ok(());
            }
            let dl = Arc::new(Download { cancel: AtomicBool::new(false), downloaded: AtomicU64::new(0) });
            downloads.insert(spec.id, dl.clone());
            dl
        };
        let this = self.clone();
        tokio::spawn(async move {
            this.emit_progress(spec, DownloadPhase::Downloading, 0, None);
            let result = match models::fetch(spec).await {
                Ok(res) => {
                    this.store
                        .save(spec, res, &dl.cancel, |n| {
                            dl.downloaded.store(n, Ordering::Relaxed);
                            this.emit_progress(spec, DownloadPhase::Downloading, n, None);
                        })
                        .await
                }
                Err(e) => Err(e),
            };
            this.downloads.lock().remove(spec.id);
            match result {
                Ok(_) => this.emit_progress(spec, DownloadPhase::Done, spec.size, None),
                Err(DownloadError::Cancelled) => this.emit_progress(spec, DownloadPhase::Cancelled, 0, None),
                Err(e) => {
                    eprintln!("[phasr] voice model {} download failed: {e}", spec.id);
                    this.emit_progress(spec, DownloadPhase::Failed, 0, Some(e.to_string()))
                }
            }
        });
        Ok(())
    }

    pub fn cancel_download(&self, id: &str) -> Result<(), VoiceError> {
        let spec = Self::spec(id)?;
        if let Some(dl) = self.downloads.lock().get(spec.id) {
            dl.cancel.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), VoiceError> {
        let spec = Self::spec(id)?;
        #[cfg(target_os = "macos")]
        self.engine.unload(spec.id);
        self.store.delete(spec).map_err(|e| VoiceError::Failed(format!("couldn't delete the model: {e}")))
    }

    fn emit_progress(&self, spec: &'static ModelSpec, phase: DownloadPhase, downloaded: u64, error: Option<String>) {
        let _ = self.events.send(VoiceEvent::Model(ModelProgress {
            model_id: spec.id,
            phase,
            downloaded,
            total: spec.size,
            error,
        }));
    }

    pub fn mic_access(&self) -> MicAccess {
        #[cfg(target_os = "macos")]
        {
            match mac::mic_access() {
                mac::MicAccess::Authorized => MicAccess::Authorized,
                mac::MicAccess::NotDetermined => MicAccess::NotDetermined,
                mac::MicAccess::Denied => MicAccess::Denied,
                mac::MicAccess::Restricted => MicAccess::Restricted,
            }
        }
        #[cfg(not(target_os = "macos"))]
        MicAccess::Unsupported
    }
}

#[cfg(target_os = "macos")]
impl VoiceService {
    /// Open the microphone for `model_id` (which must be downloaded). Asks
    /// for microphone access the first time. A dictation already running
    /// (say its composer went away mid-sentence) is discarded.
    pub async fn start(self: &Arc<Self>, model_id: &str) -> Result<(), VoiceError> {
        let model = Self::spec(model_id)?;
        if !self.store.is_installed(model) {
            return Err(VoiceError::NotInstalled);
        }
        match mac::mic_access() {
            mac::MicAccess::Authorized => {}
            mac::MicAccess::NotDetermined => {
                if !mac::request_mic_access().await {
                    return Err(VoiceError::MicDenied);
                }
            }
            _ => return Err(VoiceError::MicDenied),
        }
        let mut slot = self.dictation.lock().await;
        if let Some(old) = slot.take() {
            old.meter.abort();
            drop(old.recorder);
        }
        let recorder = tokio::task::spawn_blocking(mac::Recorder::start)
            .await
            .map_err(|e| VoiceError::Failed(e.to_string()))?
            .map_err(VoiceError::Failed)?;

        // The meter: one reading per 50ms of wall time over what arrived.
        let samples = recorder.samples();
        let events = self.events.clone();
        let meter = tokio::spawn(async move {
            let mut seen = 0usize;
            let mut tick = tokio::time::interval(std::time::Duration::from_millis(audio::METER_MS as u64));
            loop {
                tick.tick().await;
                let level = {
                    let s = samples.lock();
                    let from = seen.min(s.len());
                    seen = s.len();
                    audio::meter_level(audio::rms(&s[from..]))
                };
                let _ = events.send(VoiceEvent::Level(level));
            }
        });

        // Load the model while you talk, so stopping goes straight to text.
        let engine = self.engine.clone();
        let path = self.store.path(model);
        tokio::task::spawn_blocking(move || {
            if let Err(e) = engine.load(model.id, &path) {
                eprintln!("[phasr] voice model preload failed: {e}");
            }
        });

        *slot = Some(Dictation { recorder, model, meter });
        Ok(())
    }

    /// Close the microphone and transcribe. `language` (ISO code, or
    /// "auto") applies to multilingual models; English models ignore it.
    /// Empty when nothing was said.
    pub async fn stop(&self, language: Option<String>) -> Result<String, VoiceError> {
        let Dictation { recorder, model, meter } =
            self.dictation.lock().await.take().ok_or(VoiceError::NotDictating)?;
        meter.abort();
        let failed = recorder.device_failed();
        let engine = self.engine.clone();
        let path = self.store.path(model);
        let lang = match model.languages {
            Languages::English => "en".to_string(),
            Languages::Multilingual => language.filter(|l| !l.trim().is_empty()).unwrap_or_else(|| "auto".into()),
        };
        tokio::task::spawn_blocking(move || -> Result<String, String> {
            let rate = recorder.rate();
            let raw = recorder.finish();
            if !audio::has_speech(&raw, rate) {
                return if failed { Err("the microphone stopped working".into()) } else { Ok(String::new()) };
            }
            let samples = audio::pad_to_one_second(audio::to_whisper_rate(&raw, rate));
            engine.transcribe(model.id, &path, &samples, &lang)
        })
        .await
        .map_err(|e| VoiceError::Failed(e.to_string()))?
        .map_err(VoiceError::Failed)
    }

    pub async fn cancel(&self) {
        if let Some(d) = self.dictation.lock().await.take() {
            d.meter.abort();
            drop(d.recorder);
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl VoiceService {
    pub async fn start(self: &Arc<Self>, model_id: &str) -> Result<(), VoiceError> {
        Self::spec(model_id)?;
        Err(VoiceError::Unsupported)
    }

    pub async fn stop(&self, _language: Option<String>) -> Result<String, VoiceError> {
        Err(VoiceError::Unsupported)
    }

    pub async fn cancel(&self) {}
}

/// The real thing, end to end: download base.en through `ModelStore`
/// (checksum and all) and transcribe a 48 kHz stereo WAV through the same
/// resample → pad → Whisper path dictation uses.
///
/// `PHASR_VOICE_E2E=<dir> PHASR_VOICE_WAV=<file.wav> cargo test voice::e2e -- --ignored --nocapture`
#[cfg(all(test, target_os = "macos"))]
mod e2e {
    use super::*;

    fn read_wav(path: &str) -> (Vec<f32>, u32) {
        let b = std::fs::read(path).unwrap();
        assert_eq!(&b[0..4], b"RIFF");
        let (mut i, mut channels, mut rate, mut out) = (12usize, 1usize, 0u32, Vec::new());
        while i + 8 <= b.len() {
            let id = &b[i..i + 4];
            let len = u32::from_le_bytes(b[i + 4..i + 8].try_into().unwrap()) as usize;
            let body = &b[i + 8..(i + 8 + len).min(b.len())];
            if id == b"fmt " {
                assert_eq!(u16::from_le_bytes([body[14], body[15]]), 16, "16-bit PCM only");
                channels = u16::from_le_bytes([body[2], body[3]]) as usize;
                rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            } else if id == b"data" {
                let pcm: Vec<f32> = body.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect();
                audio::downmix(&pcm, channels, &mut out);
            }
            i += 8 + len + (len & 1);
        }
        (out, rate)
    }

    #[tokio::test]
    #[ignore]
    async fn download_and_transcribe() {
        let (Ok(dir), Ok(wav)) = (std::env::var("PHASR_VOICE_E2E"), std::env::var("PHASR_VOICE_WAV")) else {
            return;
        };
        let store = ModelStore::new(dir.into());
        let spec = catalog::find("base-en").unwrap();
        if !store.is_installed(spec) {
            let res = models::fetch(spec).await.unwrap();
            store.save(spec, res, &AtomicBool::new(false), |_| {}).await.unwrap();
        }
        let (raw, rate) = read_wav(&wav);
        assert!(audio::has_speech(&raw, rate));
        let samples = audio::pad_to_one_second(audio::to_whisper_rate(&raw, rate));
        let engine = mac::Engine::default();
        let t = std::time::Instant::now();
        engine.load(spec.id, &store.path(spec)).unwrap();
        eprintln!("LOAD {:?}", t.elapsed());
        let t = std::time::Instant::now();
        engine.transcribe(spec.id, &store.path(spec), &samples, "en").unwrap();
        eprintln!("FIRST {:?}", t.elapsed());
        let t = std::time::Instant::now();
        let text = engine.transcribe(spec.id, &store.path(spec), &samples, "en").unwrap();
        eprintln!("TRANSCRIPT ({:?}, {} Hz): {text}", t.elapsed(), rate);
        assert!(!text.is_empty());
    }
}
