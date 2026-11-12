//! Where downloaded Whisper models live (`<app data>/models/whisper/`) and
//! how one gets there: streamed to `<file>.part`, hashed on the way, and
//! renamed into place only when the size and SHA-256 match the catalog. A
//! cancelled or failed download leaves nothing behind.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bytes::Bytes;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::catalog::ModelSpec;

#[derive(Debug, Clone)]
pub struct ModelStore {
    dir: PathBuf,
}

impl ModelStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn path(&self, spec: &ModelSpec) -> PathBuf {
        self.dir.join(spec.file)
    }

    /// Present and the right size. (The hash was checked when it landed;
    /// re-hashing half a gigabyte on every listing would be slow.)
    pub fn is_installed(&self, spec: &ModelSpec) -> bool {
        std::fs::metadata(self.path(spec)).is_ok_and(|m| m.is_file() && m.len() == spec.size)
    }

    pub fn delete(&self, spec: &ModelSpec) -> std::io::Result<()> {
        for p in [self.path(spec), part_path(&self.path(spec))] {
            match std::fs::remove_file(&p) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    /// Stream `source` into place for `spec`. `on_progress(downloaded)` is
    /// called at most every 100ms (and once at the end); `cancel` is
    /// checked between chunks.
    pub async fn save<S: ChunkSource>(
        &self,
        spec: &ModelSpec,
        mut source: S,
        cancel: &AtomicBool,
        mut on_progress: impl FnMut(u64),
    ) -> Result<PathBuf, DownloadError> {
        tokio::fs::create_dir_all(&self.dir).await.map_err(DownloadError::Io)?;
        let dest = self.path(spec);
        let part = part_path(&dest);
        let result = async {
            let mut file = tokio::fs::File::create(&part).await.map_err(DownloadError::Io)?;
            let mut hasher = Sha256::new();
            let mut downloaded: u64 = 0;
            let mut last = Instant::now();
            while let Some(chunk) = source.next_chunk().await.map_err(DownloadError::Network)? {
                if cancel.load(Ordering::Relaxed) {
                    return Err(DownloadError::Cancelled);
                }
                downloaded += chunk.len() as u64;
                if downloaded > spec.size {
                    return Err(DownloadError::Corrupt);
                }
                hasher.update(&chunk);
                file.write_all(&chunk).await.map_err(DownloadError::Io)?;
                if last.elapsed() >= Duration::from_millis(100) {
                    last = Instant::now();
                    on_progress(downloaded);
                }
            }
            if cancel.load(Ordering::Relaxed) {
                return Err(DownloadError::Cancelled);
            }
            on_progress(downloaded);
            file.flush().await.map_err(DownloadError::Io)?;
            file.sync_all().await.map_err(DownloadError::Io)?;
            drop(file);
            let digest = hasher.finalize();
            if downloaded != spec.size || !hex_eq(&digest, spec.sha256) {
                return Err(DownloadError::Corrupt);
            }
            tokio::fs::rename(&part, &dest).await.map_err(DownloadError::Io)?;
            Ok(dest.clone())
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&part).await;
        }
        result
    }
}

fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

fn hex_eq(digest: &[u8], hex: &str) -> bool {
    let ours: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    ours.eq_ignore_ascii_case(hex)
}

#[derive(Debug)]
pub enum DownloadError {
    Network(String),
    Io(std::io::Error),
    Corrupt,
    Cancelled,
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(e) => write!(f, "download failed: {e}"),
            Self::Io(e) => write!(f, "couldn't save the model: {e}"),
            Self::Corrupt => write!(f, "the downloaded model didn't match its checksum; try again"),
            Self::Cancelled => write!(f, "download cancelled"),
        }
    }
}

/// A body arriving in pieces: the HTTP response, or a list in tests.
#[async_trait]
pub trait ChunkSource: Send {
    async fn next_chunk(&mut self) -> Result<Option<Bytes>, String>;
}

#[async_trait]
impl ChunkSource for reqwest::Response {
    async fn next_chunk(&mut self) -> Result<Option<Bytes>, String> {
        self.chunk().await.map_err(|e| e.to_string())
    }
}

/// GET the model. A non-2xx answer is an error, not a body to hash.
pub async fn fetch(spec: &ModelSpec) -> Result<reqwest::Response, DownloadError> {
    let client = reqwest::Client::builder()
        .user_agent("Phasr")
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| DownloadError::Network(e.to_string()))?;
    let res = client
        .get(spec.url())
        .send()
        .await
        .map_err(|e| DownloadError::Network(e.to_string()))?;
    if !res.status().is_success() {
        return Err(DownloadError::Network(format!("the server answered {}", res.status())));
    }
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::catalog::Languages;

    struct Chunks(std::vec::IntoIter<Result<Bytes, String>>);

    #[async_trait]
    impl ChunkSource for Chunks {
        async fn next_chunk(&mut self) -> Result<Option<Bytes>, String> {
            self.0.next().transpose()
        }
    }

    fn chunks(parts: &[&'static [u8]]) -> Chunks {
        Chunks(parts.iter().map(|p| Ok(Bytes::from_static(p))).collect::<Vec<_>>().into_iter())
    }

    fn spec_for(body: &[u8]) -> ModelSpec {
        let hex: String = Sha256::digest(body).iter().map(|b| format!("{b:02x}")).collect();
        ModelSpec {
            id: "t",
            label: "T",
            detail: "",
            file: "ggml-t.bin",
            size: body.len() as u64,
            sha256: Box::leak(hex.into_boxed_str()),
            languages: Languages::English,
        }
    }

    #[tokio::test]
    async fn a_matching_body_lands_and_counts_as_installed() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(dir.path().join("whisper"));
        let spec = spec_for(b"hello world");
        let mut seen = 0;
        let path = store
            .save(&spec, chunks(&[b"hello ", b"world"]), &AtomicBool::new(false), |n| seen = n)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"hello world");
        assert_eq!(seen, 11);
        assert!(store.is_installed(&spec));
        assert!(!part_path(&path).exists());
        store.delete(&spec).unwrap();
        assert!(!store.is_installed(&spec));
    }

    #[tokio::test]
    async fn a_wrong_hash_or_size_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(dir.path().to_path_buf());
        let spec = spec_for(b"hello world");
        let err = store
            .save(&spec, chunks(&[b"hello there"]), &AtomicBool::new(false), |_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, DownloadError::Corrupt));
        let err = store
            .save(&spec, chunks(&[b"hello world!!"]), &AtomicBool::new(false), |_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, DownloadError::Corrupt));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn cancel_and_network_errors_clean_up() {
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(dir.path().to_path_buf());
        let spec = spec_for(b"hello world");
        let err = store
            .save(&spec, chunks(&[b"hello ", b"world"]), &AtomicBool::new(true), |_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, DownloadError::Cancelled));
        let broken = Chunks(vec![Ok(Bytes::from_static(b"hel")), Err("reset".into())].into_iter());
        let err = store.save(&spec, broken, &AtomicBool::new(false), |_| {}).await.unwrap_err();
        assert!(matches!(err, DownloadError::Network(_)));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
