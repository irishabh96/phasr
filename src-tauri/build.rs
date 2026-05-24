use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine as _,
};

const CLERK_KEY_ENV: &str = "VITE_CLERK_PUBLISHABLE_KEY";
const RUST_ISSUER_ENV: &str = "PHASR_CLERK_ISSUER";

fn main() {
    println!("cargo:rerun-if-env-changed={CLERK_KEY_ENV}");

    for path in env_paths() {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    if let Some(key) = clerk_publishable_key() {
        if let Some(issuer) = issuer_from_publishable_key(&key) {
            println!("cargo:rustc-env={RUST_ISSUER_ENV}={issuer}");
        } else {
            println!("cargo:warning=Could not derive Clerk issuer from {CLERK_KEY_ENV}");
        }
    }

    tauri_build::build()
}

fn clerk_publishable_key() -> Option<String> {
    std::env::var(CLERK_KEY_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            env_paths()
                .into_iter()
                .find_map(|path| read_env_file(&path).get(CLERK_KEY_ENV).cloned())
        })
}

fn env_paths() -> Vec<PathBuf> {
    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    let app_dir = manifest_dir
        .parent()
        .expect("src-tauri has a parent project directory");

    [".env.local", ".env", ".env.production"]
        .into_iter()
        .map(|name| app_dir.join(name))
        .collect()
}

fn read_env_file(path: &Path) -> HashMap<String, String> {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };

    contents
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }

            let (key, value) = line.split_once('=')?;
            let value = value.trim().trim_matches('"').trim_matches('\'');
            Some((key.trim().to_string(), value.to_string()))
        })
        .collect()
}

fn issuer_from_publishable_key(key: &str) -> Option<String> {
    let encoded = key
        .trim()
        .strip_prefix("pk_test_")
        .or_else(|| key.trim().strip_prefix("pk_live_"))?;
    let decoded = decode_publishable_key_payload(encoded)?;
    let frontend_api = String::from_utf8(decoded).ok()?;
    let frontend_api = frontend_api.trim().trim_end_matches('$');
    if frontend_api.is_empty() {
        return None;
    }

    Some(format!("https://{frontend_api}"))
}

fn decode_publishable_key_payload(encoded: &str) -> Option<Vec<u8>> {
    STANDARD
        .decode(encoded)
        .or_else(|_| STANDARD_NO_PAD.decode(encoded))
        .or_else(|_| URL_SAFE.decode(encoded))
        .or_else(|_| URL_SAFE_NO_PAD.decode(encoded))
        .ok()
}
