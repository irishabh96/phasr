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

/// The user's `terminal_shell` setting as a `SpawnSpec::shell_override`,
/// or `None` (= the account's login shell). The setting syncs, so it can
/// name a shell this machine doesn't have (`/opt/homebrew/bin/fish` on an
/// Intel Mac): anything that isn't an absolute path to an executable file
/// here falls back rather than failing every terminal spawn.
pub fn usable_shell_override(setting: &str) -> Option<String> {
    let trimmed = setting.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(trimmed.to_string())
}

/// Login shells listed in `/etc/shells` that exist on this machine, in the
/// file's order, deduplicated (Settings → Terminal → Shell).
pub fn list_shells() -> Vec<String> {
    parse_etc_shells(&std::fs::read_to_string("/etc/shells").unwrap_or_default())
        .into_iter()
        .filter(|s| usable_shell_override(s).is_some())
        .collect()
}

fn parse_etc_shells(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in raw.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.starts_with('/') && !out.iter().any(|s| s == line) {
            out.push(line.to_string());
        }
    }
    out
}

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

/// Args that make `shell` run `command` and exit with its status, with
/// the same rc environment an interactive login terminal gets (`-l -i`),
/// so tools installed via PATH edits in `.zshrc` resolve exactly as they
/// would when typed.
pub fn exec_args_for_shell(shell: &str, command: &str) -> Vec<String> {
    let mut args = match shell_name(shell).as_deref() {
        Some("zsh" | "bash" | "fish" | "sh" | "ksh") => vec!["-l".into(), "-i".into()],
        _ => Vec::new(),
    };
    args.push("-c".into());
    args.push(command.into());
    args
}

/// Exec-mode twin of `spawn_candidates`: login+interactive first, then a
/// bare `-c` (a broken rc file shouldn't make the command unrunnable),
/// then the system shells.
pub fn exec_candidates(shell: &str, command: &str) -> Vec<ShellLaunch> {
    let mut candidates = vec![
        ShellLaunch::new(shell, exec_args_for_shell(shell, command)),
        ShellLaunch::new(shell, vec!["-c".into(), command.into()]),
    ];
    for fallback in ["/bin/zsh", "/bin/sh"] {
        if fallback != shell {
            candidates.push(ShellLaunch::new(
                fallback,
                vec!["-c".into(), command.into()],
            ));
        }
    }
    dedupe_candidates(candidates)
}

/// How long the login-shell PATH probe may take before we give up on it.
/// A slow rc file (nvm, conda init) is common; one that never returns
/// (waits on a prompt, auto-attaches tmux) must not wedge the caller.
const LOGIN_PATH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Brackets the PATH in the probe's stdout so rc files that print
/// banners/motd to stdout can't corrupt it.
const PATH_MARKER: &str = "__PHASR_LOGIN_PATH__";

/// The user's login-shell PATH, for processes phasr runs OUTSIDE a PTY
/// (`which <agent>`, `<agent> --version`, checks).
///
/// A GUI app launched from Finder/Dock inherits launchd's minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), so a bare `Command::new("claude")`
/// finds nothing a user installed with Homebrew, npm, or a version
/// manager. PTYs don't have this problem — they start a login shell that
/// builds its own PATH — so this exists for everything else.
///
/// Probed once per process and cached. The probe runs the shell exactly
/// like a terminal tab does — login AND interactive (`-l -i -c`) — because
/// version managers (nvm, fnm, asdf…) usually edit PATH in `.zshrc`, which
/// a login-only `-l -c` never reads; that's where npm-installed agent CLIs
/// live. Interactive rc files print banners/prompts freely, which is why
/// the PATH is bracketed by markers. If that probe fails or hangs, a
/// login-only probe is tried, then the process PATH plus the usual
/// Homebrew prefixes (`augment_macos_path`); whatever wins is cached, so a
/// broken rc file costs at most two timeouts per launch.
pub async fn login_path() -> String {
    static LOGIN_PATH: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    LOGIN_PATH
        .get_or_init(|| async {
            let shell = resolve_shell();
            if let Some(path) = probe_login_path(&shell, LOGIN_PATH_TIMEOUT).await {
                return path;
            }
            if let Some(path) =
                probe_path_with(&shell, login_args_for_shell(&shell), LOGIN_PATH_TIMEOUT).await
            {
                return path;
            }
            fallback_path()
        })
        .await
        .clone()
}

/// `$SHELL -l -i -c` PATH probe (see `login_path`).
async fn probe_login_path(shell: &str, timeout: std::time::Duration) -> Option<String> {
    // Same flags `exec_args_for_shell` gives a terminal command: `-l -i`
    // for shells known to take them, nothing for ones that might not.
    let mut args = login_args_for_shell(shell);
    if !args.is_empty() {
        args.push("-i".into());
    }
    probe_path_with(shell, args, timeout).await
}

async fn probe_path_with(
    shell: &str,
    mut args: Vec<String>,
    timeout: std::time::Duration,
) -> Option<String> {
    let script = format!("printf '%s%s%s' '{PATH_MARKER}' \"$PATH\" '{PATH_MARKER}'");
    args.push("-c".into());
    args.push(script);
    let output = crate::util::proc::run_with_timeout(shell, &args, None, &[], timeout)
        .await
        .ok()?;
    // The exit status is NOT checked: an interactive shell can exit
    // non-zero over an unrelated rc-file error after our printf ran. The
    // markers are only ever printed by that printf, so finding them is the
    // proof that the PATH is the shell's real one.
    parse_probed_path(&String::from_utf8_lossy(&output.stdout))
}

/// Pull the PATH out from between the markers; reject anything that
/// doesn't look like a PATH.
fn parse_probed_path(stdout: &str) -> Option<String> {
    let start = stdout.find(PATH_MARKER)? + PATH_MARKER.len();
    let rest = &stdout[start..];
    let end = rest.find(PATH_MARKER)?;
    let path = rest[..end].trim();
    if path.is_empty() || !path.contains('/') {
        return None;
    }
    Some(path.to_string())
}

fn fallback_path() -> String {
    let mut env: Vec<(OsString, OsString)> = std::env::var_os("PATH")
        .map(|p| vec![(OsString::from("PATH"), p)])
        .unwrap_or_default();
    #[cfg(target_os = "macos")]
    augment_macos_path(&mut env);
    get_env(&env, "PATH")
        .and_then(|value| value.to_str())
        .unwrap_or("/usr/bin:/bin:/usr/sbin:/sbin")
        .to_string()
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
    fn etc_shells_parsing_skips_comments_and_duplicates() {
        let raw = "# List of acceptable shells\n/bin/bash\n/bin/zsh # default\n\n/bin/zsh\nnot-a-path\n";
        assert_eq!(parse_etc_shells(raw), vec!["/bin/bash".to_string(), "/bin/zsh".to_string()]);
    }

    #[test]
    fn shell_override_requires_an_existing_absolute_executable() {
        assert_eq!(usable_shell_override(""), None);
        assert_eq!(usable_shell_override("  "), None);
        assert_eq!(usable_shell_override("zsh"), None, "relative");
        assert_eq!(usable_shell_override("/no/such/shell"), None);
        assert_eq!(usable_shell_override("/bin/sh").as_deref(), Some("/bin/sh"));
        assert_eq!(usable_shell_override(" /bin/sh ").as_deref(), Some("/bin/sh"));
        let dir = tempfile::tempdir().unwrap();
        let not_exec = dir.path().join("sh");
        std::fs::write(&not_exec, "").unwrap();
        assert_eq!(usable_shell_override(&not_exec.to_string_lossy()), None);
        assert_eq!(usable_shell_override(&dir.path().to_string_lossy()), None, "a directory");
    }

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
    fn exec_args_run_the_command_in_a_login_interactive_shell() {
        assert_eq!(
            exec_args_for_shell("/bin/zsh", "exit 3"),
            vec!["-l", "-i", "-c", "exit 3"]
        );
        // Unknown shells get no login/interactive flags they may not
        // understand — just `-c`.
        assert_eq!(
            exec_args_for_shell("/usr/local/bin/pwsh", "exit 3"),
            vec!["-c", "exit 3"]
        );
    }

    #[test]
    fn exec_candidates_fall_back_without_rc_files_then_system_shells() {
        let candidates = exec_candidates("/bin/zsh", "true");
        assert_eq!(
            candidates[0],
            ShellLaunch::new(
                "/bin/zsh",
                vec!["-l".into(), "-i".into(), "-c".into(), "true".into()]
            )
        );
        assert_eq!(
            candidates[1],
            ShellLaunch::new("/bin/zsh", vec!["-c".into(), "true".into()])
        );
        assert!(candidates.contains(&ShellLaunch::new(
            "/bin/sh",
            vec!["-c".into(), "true".into()]
        )));
        // Every candidate still runs the command — none degrade to a bare
        // interactive shell.
        assert!(candidates
            .iter()
            .all(|c| c.args.last().map(String::as_str) == Some("true")));
    }

    #[test]
    fn probed_path_is_taken_from_between_the_markers_only() {
        let noisy = format!(
            "Welcome to your shell!\n{PATH_MARKER}/opt/homebrew/bin:/usr/bin{PATH_MARKER}trailing"
        );
        assert_eq!(
            parse_probed_path(&noisy).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        assert_eq!(parse_probed_path("no markers at all"), None);
        assert_eq!(
            parse_probed_path(&format!("{PATH_MARKER}{PATH_MARKER}")),
            None
        );
    }

    #[tokio::test]
    async fn probe_reads_a_real_login_shell_path() {
        let path = probe_login_path("/bin/sh", LOGIN_PATH_TIMEOUT)
            .await
            .expect("/bin/sh -l -i must report a PATH");
        assert!(path.contains("/usr/bin"), "unexpected PATH {path:?}");
    }

    /// The reason for `-i`: PATH edits that only an interactive rc file
    /// makes (nvm in `.zshrc`) must be visible, and rc-file chatter on
    /// stdout must not leak into the result. `ENV` is the rc file a POSIX
    /// `sh -i` reads, standing in for `.zshrc`.
    #[cfg(unix)]
    #[tokio::test]
    async fn probe_sees_interactive_rc_path_edits_through_rc_noise() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let rc = dir.path().join("rc.sh");
        std::fs::write(&rc, "echo 'welcome banner'\nexport PATH=\"/phasr/nvm/bin:$PATH\"\n")
            .unwrap();
        // A wrapper shell so ENV is set only for the probe, not this process.
        let shell = dir.path().join("rc-shell");
        std::fs::write(
            &shell,
            format!("#!/bin/sh\nENV='{}' exec /bin/sh \"$@\"\n", rc.display()),
        )
        .unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        // `rc-shell` isn't a known shell name, so ask for `-i` explicitly the
        // way `probe_login_path` does for zsh/bash.
        let path = probe_path_with(
            shell.to_str().unwrap(),
            vec!["-i".into()],
            LOGIN_PATH_TIMEOUT,
        )
        .await
        .expect("interactive probe must report a PATH");
        assert!(path.starts_with("/phasr/nvm/bin:"), "unexpected PATH {path:?}");
        assert!(!path.contains("welcome"), "rc noise leaked: {path:?}");
    }

    /// An rc file that never returns must cost the timeout, not the app.
    #[cfg(unix)]
    #[tokio::test]
    async fn probe_gives_up_on_a_hung_shell() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake_shell = dir.path().join("hung-shell");
        std::fs::write(&fake_shell, "#!/bin/sh\nsleep 10\n").unwrap();
        std::fs::set_permissions(&fake_shell, std::fs::Permissions::from_mode(0o755)).unwrap();

        let started = std::time::Instant::now();
        let probed = probe_login_path(
            fake_shell.to_str().unwrap(),
            std::time::Duration::from_millis(200),
        )
        .await;
        assert_eq!(probed, None);
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
    }

    #[test]
    fn fallback_path_is_never_empty() {
        assert!(fallback_path().contains('/'));
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
