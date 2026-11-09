//! Hook bridge: how an agent's own hooks reach phasr.
//!
//! phasr installs one tiny POSIX script, `<app_data>/bin/phasr-hook.sh`, and
//! points the agents at it:
//!
//! - **Claude**: spawned with `--settings <app_data>/agent-config/<task>/
//!   claude-settings.json`, whose hooks run the script with the hook JSON on
//!   stdin. `--settings` *adds* to the user's own settings, so their hooks
//!   keep working.
//! - **Codex**: spawned with `-c 'notify=["<script>","codex",…]'`; Codex runs
//!   `notify` with the JSON as the last argv. Codex has ONE notify program,
//!   so the user's own `notify` (if any) is appended and the script chains it.
//!
//! The script finds its task through `PHASR_TASK_ID` / `PHASR_HOOK_DIR`
//! (set on the PTY via `SpawnSpec::extra_env`) and writes each event as its
//! own file — `mktemp` then `mv` to `*.json`, so a reader never sees a
//! half-written event. `drain_task_dir` reads them in mtime order and
//! deletes them.
//!
//! None of these extras are stored in `workspaces.command`: they're added at
//! spawn time only, so the command the user sees (and that syncs) stays clean,
//! and app-data paths never leak to another machine.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::domain::PushPolicy;

use super::signal::{parse_hook_payload, AgentSignal, SessionInfo};

/// Repository rules that phasr enforces through an agent's own permission
/// system (Settings → Branch rules). Only Claude has one phasr can write
/// per task; other agents launch without these (see
/// `RepositoryConfig::policy_enforced_for`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentPolicy {
    /// Worktree-relative globs the agent must ask before editing.
    pub protected_paths: Vec<String>,
    pub agents_may_push: PushPolicy,
}

pub const ENV_TASK_ID: &str = "PHASR_TASK_ID";
pub const ENV_HOOK_DIR: &str = "PHASR_HOOK_DIR";

/// Bump the version line when the script changes; `install` rewrites the
/// file whenever its content differs, so upgrades are automatic.
const HOOK_SCRIPT: &str = r#"#!/bin/sh
# phasr-hook v1 — installed by Phasr, overwritten on every launch.
# Records one agent event per file for Phasr to pick up:
#   claude: hook JSON on stdin                 phasr-hook.sh claude
#   codex:  notify JSON as the last argument   phasr-hook.sh codex [user notify...] JSON
# Always exits 0 and prints nothing: a hook's exit code and output can steer
# the agent, and this one must only observe.
agent="${1:-unknown}"
[ "$#" -gt 0 ] && shift
payload=""
if [ "$agent" = codex ]; then
  for payload in "$@"; do :; done
  if [ "$#" -gt 1 ]; then
    # Chain the user's own notify program: it gets its own args + the JSON.
    ("$@" >/dev/null 2>&1 &)
  fi
fi
dir="${PHASR_HOOK_DIR:-}"
task="${PHASR_TASK_ID:-}"
case "$task" in ''|*/*|.*) dir="" ;; esac
if [ -z "$dir" ]; then
  [ "$agent" = codex ] || cat >/dev/null 2>&1
  exit 0
fi
target="$dir/$task"
mkdir -p "$target" 2>/dev/null
tmp=$(mktemp "$target/tmp.XXXXXXXX" 2>/dev/null) || {
  [ "$agent" = codex ] || cat >/dev/null 2>&1
  exit 0
}
if [ "$agent" = codex ]; then
  printf '%s' "$payload" > "$tmp" 2>/dev/null
else
  cat > "$tmp" 2>/dev/null
fi
mv -f "$tmp" "$tmp.$agent.json" 2>/dev/null || rm -f "$tmp"
exit 0
"#;

/// Claude hook events phasr subscribes to. `PermissionRequest` and
/// `PermissionDenied` go beyond the M6 plan's list: the first is the only
/// immediate "a dialog is up" signal (the `permission_prompt` Notification
/// is delayed 6s by Claude), the second resolves a dialog the user denied.
pub const CLAUDE_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PermissionDenied",
    "Notification",
    "Stop",
    "SessionEnd",
];

/// Events whose `matcher` is a tool-name pattern.
fn is_tool_event(event: &str) -> bool {
    matches!(
        event,
        "PreToolUse" | "PostToolUse" | "PermissionRequest" | "PermissionDenied"
    )
}

#[derive(Debug, Clone)]
pub struct HookBridge {
    script_path: PathBuf,
    hook_dir: PathBuf,
    config_dir: PathBuf,
    /// False if the script couldn't be installed; launches then add no
    /// extras and heuristics are the only signal.
    available: bool,
}

impl HookBridge {
    /// Install (or refresh) the script under `app_data_dir`. Never fails:
    /// a read-only app-data dir degrades to heuristics, not a broken launch.
    pub fn install(app_data_dir: &Path) -> Self {
        let script_path = app_data_dir.join("bin").join("phasr-hook.sh");
        let hook_dir = app_data_dir.join("hooks");
        let config_dir = app_data_dir.join("agent-config");
        let available = match install_script(&script_path).and_then(|_| {
            std::fs::create_dir_all(&hook_dir)?;
            std::fs::create_dir_all(&config_dir)
        }) {
            Ok(()) => true,
            Err(err) => {
                eprintln!("agent hook bridge unavailable ({}): {err}", script_path.display());
                false
            }
        };
        Self {
            script_path,
            hook_dir,
            config_dir,
            available,
        }
    }

    pub fn hook_dir(&self) -> &Path {
        &self.hook_dir
    }

    /// Env the agent's PTY needs for the script to find its task.
    pub fn task_env(&self, task_id: &str) -> Vec<(String, String)> {
        if !self.available {
            return Vec::new();
        }
        vec![
            (ENV_TASK_ID.into(), task_id.into()),
            (ENV_HOOK_DIR.into(), self.hook_dir.to_string_lossy().into_owned()),
        ]
    }

    /// Write the per-task Claude settings file and return the CLI args that
    /// load it (`--settings '<path>'`, shell-quoted: app data lives under
    /// "Application Support").
    pub fn claude_args(&self, task_id: &str, policy: &AgentPolicy) -> Option<String> {
        if !self.available {
            return None;
        }
        let dir = self.config_dir.join(task_id);
        let path = dir.join("claude-settings.json");
        let mut settings = claude_settings(&self.script_path);
        if let Some(permissions) = claude_permission_rules(policy) {
            settings["permissions"] = permissions;
        }
        let body = serde_json::to_vec_pretty(&settings).ok()?;
        if let Err(err) = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&path, body)) {
            eprintln!("failed to write Claude hook settings for {task_id}: {err}");
            return None;
        }
        Some(format!("--settings {}", shell_quote(&path.to_string_lossy())))
    }

    /// `-c 'notify=[…]'` for Codex, chaining the user's own `notify` command
    /// (from their config.toml) after ours.
    pub fn codex_args(&self, user_notify: &[String]) -> Option<String> {
        if !self.available {
            return None;
        }
        let script = self.script_path.to_string_lossy().into_owned();
        let mut argv = vec![script.clone(), "codex".to_string()];
        // Never chain ourselves (e.g. a user who copied our override).
        if user_notify.first().is_some_and(|p| *p != script) {
            argv.extend(user_notify.iter().cloned());
        }
        let items: Vec<String> = argv.iter().map(|s| toml_basic_string(s)).collect();
        Some(format!("-c {}", shell_quote(&format!("notify=[{}]", items.join(",")))))
    }

    /// Remove a task's pending events and its settings file. Called when the
    /// task is archived or deleted; the next launch recreates both.
    pub fn clean_task(&self, task_id: &str) {
        if !is_safe_task_id(task_id) {
            return;
        }
        let _ = std::fs::remove_dir_all(self.hook_dir.join(task_id));
        let _ = std::fs::remove_dir_all(self.config_dir.join(task_id));
    }

    /// Task ids that currently have a hook directory.
    pub fn task_dirs(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.hook_dir) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .filter(|id| is_safe_task_id(id))
            .collect()
    }

    /// Read, parse and delete every complete event file for `task_id`, oldest
    /// first. Unparseable files are deleted too (they'd never become valid).
    pub fn drain_task_dir(&self, task_id: &str) -> Vec<(AgentSignal, SessionInfo)> {
        drain_dir(&self.hook_dir.join(task_id))
    }
}

pub fn drain_dir(dir: &Path) -> Vec<(AgentSignal, SessionInfo)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        // `tmp.XXXX` (still being written) never ends in `.json`.
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .filter_map(|p| {
            let mtime = std::fs::metadata(&p).and_then(|m| m.modified()).ok()?;
            Some((mtime, p))
        })
        .collect();
    // mtime (ns on APFS/ext4) orders events; the name breaks exact ties.
    files.sort();
    let mut out = Vec::with_capacity(files.len());
    for (_, path) in files {
        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        let _ = std::fs::remove_file(&path);
        let agent = path
            .file_stem()
            .and_then(|s| Path::new(s).extension())
            .and_then(|e| e.to_str())
            .unwrap_or("");
        if let Some(parsed) = parse_hook_payload(agent, &raw) {
            out.push(parsed);
        }
    }
    out
}

fn install_script(path: &Path) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::read_to_string(path).ok().as_deref() != Some(HOOK_SCRIPT) {
        // Write-then-rename so an agent mid-hook never execs a torn script.
        let tmp = path.with_extension("sh.tmp");
        std::fs::write(&tmp, HOOK_SCRIPT)?;
        std::fs::rename(&tmp, path)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

/// The settings object passed via `--settings`. Command hooks only, 10s
/// timeout, synchronous: Claude awaits each hook before moving on, which is
/// what keeps PreToolUse → PermissionRequest → PostToolUse files in order
/// (async hooks would race). The script returns in milliseconds and always
/// exits 0 with no output, so it never blocks or alters a decision.
pub fn claude_settings(script: &Path) -> Value {
    let command = format!("{} claude", shell_quote(&script.to_string_lossy()));
    let mut hooks = serde_json::Map::new();
    for event in CLAUDE_HOOK_EVENTS {
        let mut entry = json!({
            "hooks": [{ "type": "command", "command": command, "timeout": 10 }]
        });
        if is_tool_event(event) {
            entry["matcher"] = json!("*");
        }
        hooks.insert((*event).to_string(), json!([entry]));
    }
    json!({ "hooks": hooks })
}

/// `permissions` for the per-task Claude settings file, or `None` when the
/// policy adds nothing.
///
/// - Protected paths → `ask` rules for `Edit(glob)` and `Write(glob)`.
///   Claude matches a bare pattern relative to its cwd (the worktree), with
///   gitignore semantics, so `migrations/**` means the worktree's
///   migrations folder. `--settings` merges with the user's own settings:
///   their rules still apply, and Claude evaluates `deny` before `ask`
///   before `allow`, so a user `allow` can't silently lift these.
/// - Pushes → `Bash(git push:*)` in `ask` or `deny`; `allow` adds nothing
///   (the task's permission mode decides).
pub fn claude_permission_rules(policy: &AgentPolicy) -> Option<Value> {
    let mut ask: Vec<String> = Vec::new();
    let mut deny: Vec<String> = Vec::new();
    for glob in &policy.protected_paths {
        let glob = glob.trim();
        if glob.is_empty() {
            continue;
        }
        ask.push(format!("Edit({glob})"));
        ask.push(format!("Write({glob})"));
    }
    const PUSH: &str = "Bash(git push:*)";
    match policy.agents_may_push {
        PushPolicy::Ask => ask.push(PUSH.into()),
        PushPolicy::Deny => deny.push(PUSH.into()),
        PushPolicy::Allow => {}
    }
    if ask.is_empty() && deny.is_empty() {
        return None;
    }
    let mut permissions = serde_json::Map::new();
    if !ask.is_empty() {
        permissions.insert("ask".into(), json!(ask));
    }
    if !deny.is_empty() {
        permissions.insert("deny".into(), json!(deny));
    }
    Some(Value::Object(permissions))
}

/// The user's own Codex `notify` (top-level array in `config.toml`), so ours
/// can chain it. Missing/unparseable config → nothing to chain.
pub fn read_codex_user_notify(config_path: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(config_path) else {
        return Vec::new();
    };
    let Ok(table) = raw.parse::<toml::Table>() else {
        return Vec::new();
    };
    table
        .get("notify")
        .and_then(toml::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(toml::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Task ids become path components: only accept what phasr itself mints
/// (UUIDs), so a crafted id can never escape the hook dir.
pub fn is_safe_task_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// POSIX single-quote unless the string is plainly safe.
pub fn shell_quote(s: &str) -> String {
    let safe = !s.is_empty()
        && s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_./=:,@+-%".contains(c));
    if safe {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

fn toml_basic_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn bridge() -> (HookBridge, tempfile::TempDir) {
        // A space in the path, like the real "Application Support".
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("App Support");
        (HookBridge::install(&app_data), dir)
    }

    fn run_script(bridge: &HookBridge, task: &str, args: &[&str], stdin: &str) {
        let mut child = Command::new(&bridge.script_path)
            .args(args)
            .env(ENV_TASK_ID, task)
            .env(ENV_HOOK_DIR, &bridge.hook_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        assert!(out.stdout.is_empty(), "a hook must print nothing");
    }

    #[test]
    fn script_is_installed_executable_and_refreshed() {
        let (bridge, _dir) = bridge();
        assert!(bridge.available);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&bridge.script_path).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111);
        }
        std::fs::write(&bridge.script_path, "#!/bin/sh\necho stale\n").unwrap();
        let again = HookBridge::install(bridge.script_path.parent().unwrap().parent().unwrap());
        assert_eq!(std::fs::read_to_string(&again.script_path).unwrap(), HOOK_SCRIPT);
    }

    #[test]
    fn claude_events_round_trip_through_the_script_in_order() {
        let (bridge, _dir) = bridge();
        let task = "11111111-2222-3333-4444-555555555555";
        run_script(
            &bridge,
            task,
            &["claude"],
            r#"{"hook_event_name":"PreToolUse","session_id":"s1","tool_name":"Bash","tool_input":{"command":"ls"}}"#,
        );
        std::thread::sleep(std::time::Duration::from_millis(15));
        run_script(
            &bridge,
            task,
            &["claude"],
            r#"{"hook_event_name":"Notification","notification_type":"permission_prompt","message":"m"}"#,
        );
        let drained = bridge.drain_task_dir(task);
        assert_eq!(drained.len(), 2);
        assert!(matches!(drained[0].0, AgentSignal::PreToolUse { .. }));
        assert!(matches!(drained[1].0, AgentSignal::Notification { .. }));
        assert_eq!(drained[0].1.session_id.as_deref(), Some("s1"));
        // Drained files are gone.
        assert!(bridge.drain_task_dir(task).is_empty());
    }

    #[test]
    fn codex_notify_reads_the_last_argument_and_chains_the_user_notify() {
        let (bridge, dir) = bridge();
        let task = "aaaaaaaa-0000-0000-0000-000000000001";
        let marker = dir.path().join("chained.txt");
        // A stand-in "user notify" program that records its last argument.
        let user_prog = dir.path().join("user-notify.sh");
        std::fs::write(
            &user_prog,
            format!(
                "#!/bin/sh\nfor a in \"$@\"; do last=\"$a\"; done\nprintf '%s|%s' \"$1\" \"$last\" > '{}'\n",
                marker.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&user_prog, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let payload = r#"{"type":"agent-turn-complete","last-assistant-message":"done"}"#;
        let user = user_prog.to_string_lossy().into_owned();
        run_script(&bridge, task, &["codex", &user, "turn-ended", payload], "");

        let drained = bridge.drain_task_dir(task);
        assert_eq!(
            drained[0].0,
            AgentSignal::CodexTurnComplete {
                last_assistant_message: Some("done".into())
            }
        );
        // The chained program runs in the background.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !marker.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap(),
            format!("turn-ended|{payload}")
        );
    }

    #[test]
    fn script_without_task_env_is_a_silent_no_op() {
        let (bridge, _dir) = bridge();
        let out = Command::new(&bridge.script_path)
            .arg("claude")
            .env_remove(ENV_TASK_ID)
            .env_remove(ENV_HOOK_DIR)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(bridge.task_dirs().is_empty());
        // A path-traversal task id is refused by the script too.
        run_script(&bridge, "../escape", &["claude"], r#"{"hook_event_name":"Stop"}"#);
        assert!(!bridge.hook_dir.parent().unwrap().join("escape").exists());
    }

    #[test]
    fn claude_settings_subscribe_every_event_with_quoted_command() {
        let settings = claude_settings(Path::new("/App Support/bin/phasr-hook.sh"));
        for event in CLAUDE_HOOK_EVENTS {
            let entry = &settings["hooks"][event][0];
            let hook = &entry["hooks"][0];
            assert_eq!(hook["type"], "command");
            assert_eq!(hook["timeout"], 10);
            assert_eq!(hook["command"], "'/App Support/bin/phasr-hook.sh' claude");
            assert_eq!(entry.get("matcher").is_some(), is_tool_event(event), "{event}");
        }
    }

    #[test]
    fn claude_args_write_the_settings_file() {
        let (bridge, _dir) = bridge();
        let args = bridge.claude_args("t-1", &AgentPolicy::default()).unwrap();
        assert!(args.starts_with("--settings '"), "{args}");
        let path = bridge.config_dir.join("t-1").join("claude-settings.json");
        let written: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(written["hooks"]["Stop"].is_array());
        // The default policy (push = ask) writes its rule next to the hooks.
        assert_eq!(written["permissions"]["ask"], json!(["Bash(git push:*)"]));

        let policy = AgentPolicy {
            protected_paths: vec!["migrations/**".into()],
            agents_may_push: PushPolicy::Deny,
        };
        bridge.claude_args("t-1", &policy).unwrap();
        let written: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["permissions"]["ask"], json!(["Edit(migrations/**)", "Write(migrations/**)"]));
        assert_eq!(written["permissions"]["deny"], json!(["Bash(git push:*)"]));
        assert!(written["hooks"]["PreToolUse"].is_array(), "hooks kept alongside");
        bridge.clean_task("t-1");
        assert!(!path.exists());
    }

    #[test]
    fn protected_paths_and_push_policy_become_claude_permission_rules() {
        let rules = |paths: &[&str], push| {
            claude_permission_rules(&AgentPolicy {
                protected_paths: paths.iter().map(|p| p.to_string()).collect(),
                agents_may_push: push,
            })
        };
        assert_eq!(
            rules(&[".env*", "infra/**", "  "], PushPolicy::Ask).unwrap(),
            json!({ "ask": [
                "Edit(.env*)", "Write(.env*)",
                "Edit(infra/**)", "Write(infra/**)",
                "Bash(git push:*)"
            ]})
        );
        assert_eq!(
            rules(&[], PushPolicy::Deny).unwrap(),
            json!({ "deny": ["Bash(git push:*)"] })
        );
        assert_eq!(
            rules(&["db/*.sql"], PushPolicy::Allow).unwrap(),
            json!({ "ask": ["Edit(db/*.sql)", "Write(db/*.sql)"] })
        );
        assert_eq!(rules(&[], PushPolicy::Allow), None, "nothing to add → no permissions key");
    }

    #[test]
    fn codex_args_are_valid_toml_and_skip_self_chaining() {
        let bridge = HookBridge {
            script_path: PathBuf::from("/A B/phasr-hook.sh"),
            hook_dir: PathBuf::new(),
            config_dir: PathBuf::new(),
            available: true,
        };
        let args = bridge.codex_args(&["/bin/notify".into(), "x\"y".into()]).unwrap();
        assert_eq!(
            args,
            r#"-c 'notify=["/A B/phasr-hook.sh","codex","/bin/notify","x\"y"]'"#
        );
        let toml_part = args.trim_start_matches("-c '").trim_end_matches('\'');
        let parsed: toml::Table = toml_part.parse().unwrap();
        assert_eq!(parsed["notify"].as_array().unwrap().len(), 4);

        let own = bridge.codex_args(&["/A B/phasr-hook.sh".into(), "codex".into()]).unwrap();
        assert_eq!(own, r#"-c 'notify=["/A B/phasr-hook.sh","codex"]'"#);
    }

    #[test]
    fn reads_the_user_codex_notify() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.toml");
        std::fs::write(
            &config,
            "model = \"gpt-5\"\nnotify = [\"/Apps/My Notifier\", \"turn-ended\"]\n[tui]\nx = 1\n",
        )
        .unwrap();
        assert_eq!(
            read_codex_user_notify(&config),
            vec!["/Apps/My Notifier".to_string(), "turn-ended".to_string()]
        );
        assert!(read_codex_user_notify(&dir.path().join("missing.toml")).is_empty());
    }

    #[test]
    fn shell_quote_handles_spaces_and_quotes() {
        assert_eq!(shell_quote("plain/path-1.json"), "plain/path-1.json");
        assert_eq!(shell_quote("/a b"), "'/a b'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert!(!is_safe_task_id("../x"));
        assert!(is_safe_task_id("0b6c3c1e-9d1a-4c2e-8d0e-1f2a3b4c5d6e"));
    }
}
