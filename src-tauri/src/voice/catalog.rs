//! The Whisper models Phasr offers (Settings → Voice). Each is a ggml file
//! from whisper.cpp's model repository, downloaded on request and checked
//! against the SHA-256 Hugging Face publishes for it (the LFS object id).

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Languages {
    /// `.en` models: English only, and better at it than a multilingual
    /// model of the same size.
    English,
    /// Detects the spoken language (or takes one) — 99 of them.
    Multilingual,
}

#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub detail: &'static str,
    pub file: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    pub languages: Languages,
}

impl ModelSpec {
    pub fn url(&self) -> String {
        format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}", self.file)
    }
}

/// In the order Settings lists them. The first is the one the composer
/// offers when nothing is installed yet.
pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "base-en",
        label: "Fast",
        detail: "Whisper base · English",
        file: "ggml-base.en.bin",
        size: 147_964_211,
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
        languages: Languages::English,
    },
    ModelSpec {
        id: "small-en",
        label: "Accurate",
        detail: "Whisper small · English",
        file: "ggml-small.en-q5_1.bin",
        size: 190_098_681,
        sha256: "bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30",
        languages: Languages::English,
    },
    ModelSpec {
        id: "large-v3-turbo",
        label: "Multilingual",
        detail: "Whisper large-v3 turbo · 99 languages",
        file: "ggml-large-v3-turbo-q5_0.bin",
        size: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        languages: Languages::Multilingual,
    },
];

pub fn find(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_files_are_unique_and_hashes_well_formed() {
        for (i, a) in MODELS.iter().enumerate() {
            assert_eq!(a.sha256.len(), 64, "{}", a.id);
            assert!(a.sha256.chars().all(|c| c.is_ascii_hexdigit()), "{}", a.id);
            assert!(a.file.starts_with("ggml-") && a.file.ends_with(".bin"));
            for b in &MODELS[i + 1..] {
                assert_ne!(a.id, b.id);
                assert_ne!(a.file, b.file);
            }
        }
        assert_eq!(find("base-en").unwrap().file, "ggml-base.en.bin");
        assert!(find("nope").is_none());
    }
}
