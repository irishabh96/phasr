use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellLaunch {
    pub shell: String,
    pub args: Vec<String>,
}

impl ShellLaunch {
    fn new(shell: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            shell: shell.into(),
            args,
        }
    }
}

const MACOS_PATHS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
];

const RUNTIME_ENV_KEYS: &[&str] = &[
    "AUTH_TOKEN",
    "CLERK_SECRET_KEY",
    "DATABASE_URL",
    "GITHUB_TOKEN",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "TAURI_PRIVATE_KEY",
    "VITE_CLERK_PUBLISHABLE_KEY",
];

const RUNTIME_ENV_PREFIXES: &[&str] = &[
    "npm_",
    "npm_config_",
    "ELECTRON_",
    "VITE_",
    "TURBO_",
    "TAURI_",
];

pub fn resolve_shell() -> String {
    configured_account_shell()
        .or_else(|| non_empty_env("SHELL"))
        .unwrap_or_else(default_shell)
}

pub fn login_args_for_shell(shell: &str) -> Vec<String> {
    match shell_name(shell).as_deref() {
        Some("zsh" | "bash" | "fish" | "sh" | "ksh") => vec!["-l".into()],
        _ => Vec::new(),
    }
}

pub fn spawn_candidates(shell: &str) -> Vec<ShellLaunch> {
    let mut candidates = Vec::new();
    candidates.push(ShellLaunch::new(shell, login_args_for_shell(shell)));
    candidates.push(ShellLaunch::new(shell, Vec::new()));

    for fallback in ["/bin/zsh", "/bin/sh"] {
        if fallback != shell {
            candidates.push(ShellLaunch::new(fallback, Vec::new()));
        }
    }

    dedupe_candidates(candidates)
}

pub fn terminal_env(shell: &str) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(key, _)| should_pass_env(key))
        .collect();

    set_env(&mut env, "TERM", "xterm-256color");
    set_env(&mut env, "COLORTERM", "truecolor");
    set_env(&mut env, "TERM_PROGRAM", "kitty");
    set_env(&mut env, "SHELL", shell);

    if get_env(&env, "LANG").is_none() {
        set_env(&mut env, "LANG", "en_US.UTF-8");
    }

    #[cfg(target_os = "macos")]
    augment_macos_path(&mut env);

    env
}

#[cfg(unix)]
fn configured_account_shell() -> Option<String> {
    unsafe {
        let passwd = libc::getpwuid(libc::geteuid());
        if passwd.is_null() {
            return None;
        }
        let shell = (*passwd).pw_shell;
        if shell.is_null() {
            return None;
        }
        let value = std::ffi::CStr::from_ptr(shell).to_string_lossy();
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }
}

#[cfg(not(unix))]
fn configured_account_shell() -> Option<String> {
    None
}

fn default_shell() -> String {
    #[cfg(target_os = "macos")]
    {
        "/bin/zsh".into()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "/bin/sh".into()
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn shell_name(shell: &str) -> Option<String> {
    Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.trim_start_matches('-').to_string())
}

fn dedupe_candidates(candidates: Vec<ShellLaunch>) -> Vec<ShellLaunch> {
    let mut result = Vec::new();
    for candidate in candidates {
        if result.iter().any(|existing: &ShellLaunch| {
            existing.shell == candidate.shell && existing.args == candidate.args
        }) {
            continue;
        }
        result.push(candidate);
    }
    result
}

fn should_pass_env(key: &OsString) -> bool {
    let Some(key) = key.to_str() else {
        return true;
    };

    if RUNTIME_ENV_KEYS.contains(&key) {
        return false;
    }
    !RUNTIME_ENV_PREFIXES
        .iter()
        .any(|prefix| key.starts_with(prefix))
}

fn set_env(env: &mut Vec<(OsString, OsString)>, key: &str, value: impl Into<OsString>) {
    let key_os = OsString::from(key);
    env.retain(|(existing, _)| existing != &key_os);
    env.push((key_os, value.into()));
}

fn get_env<'a>(env: &'a [(OsString, OsString)], key: &str) -> Option<&'a OsString> {
    let key_os = OsString::from(key);
    env.iter()
        .find(|(existing, _)| existing == &key_os)
        .map(|(_, value)| value)
}

#[cfg(target_os = "macos")]
fn augment_macos_path(env: &mut Vec<(OsString, OsString)>) {
    let current = get_env(env, "PATH")
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let mut entries: Vec<String> = current
        .split(':')
        .filter(|entry| !entry.is_empty())
        .map(ToOwned::to_owned)
        .collect();

    for path in MACOS_PATHS.iter().rev() {
        if !entries.iter().any(|entry| entry == path) && PathBuf::from(path).exists() {
            entries.insert(0, (*path).to_string());
        }
    }

    set_env(env, "PATH", entries.join(":"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_shells_launch_as_login_shells() {
        assert_eq!(login_args_for_shell("/bin/zsh"), vec!["-l"]);
        assert_eq!(login_args_for_shell("/opt/homebrew/bin/fish"), vec!["-l"]);
        assert_eq!(login_args_for_shell("/bin/bash"), vec!["-l"]);
        assert_eq!(login_args_for_shell("/bin/sh"), vec!["-l"]);
        assert_eq!(login_args_for_shell("/usr/bin/ksh"), vec!["-l"]);
    }

    #[test]
    fn unknown_shell_launches_without_args() {
        assert!(login_args_for_shell("/usr/local/bin/pwsh").is_empty());
    }

    #[test]
    fn spawn_candidates_try_login_then_plain_then_fallbacks() {
        let candidates = spawn_candidates("/bin/zsh");
        assert_eq!(
            candidates[0],
            ShellLaunch::new("/bin/zsh", vec!["-l".into()])
        );
        assert_eq!(candidates[1], ShellLaunch::new("/bin/zsh", Vec::new()));
        assert!(candidates.contains(&ShellLaunch::new("/bin/sh", Vec::new())));
    }

    #[test]
    fn terminal_env_overrides_terminal_keys_and_strips_runtime_keys() {
        let env = vec![
            (OsString::from("TERM"), OsString::from("dumb")),
            (OsString::from("AUTH_TOKEN"), OsString::from("secret")),
            (OsString::from("PATH"), OsString::from("/usr/bin")),
        ];
        let mut shaped: Vec<(OsString, OsString)> = env
            .into_iter()
            .filter(|(key, _)| should_pass_env(key))
            .collect();
        set_env(&mut shaped, "TERM", "xterm-256color");
        set_env(&mut shaped, "SHELL", "/bin/zsh");

        assert_eq!(
            get_env(&shaped, "TERM"),
            Some(&OsString::from("xterm-256color"))
        );
        assert_eq!(get_env(&shaped, "SHELL"), Some(&OsString::from("/bin/zsh")));
        assert!(get_env(&shaped, "AUTH_TOKEN").is_none());
    }
}
