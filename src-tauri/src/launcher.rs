//! "Open in <app>" launcher: detects installed editors and terminals,
//! launches them pointed at a worktree path.

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::auth::SessionState;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LauncherKind {
    Editor,
    Terminal,
    FileManager,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launcher {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: LauncherKind,
}

#[derive(Debug, Clone, Copy)]
enum DetectStrategy {
    /// Tool is installed if any of these CLIs is on $PATH.
    Cli(&'static [&'static str]),
    /// Tool is installed if any of these app bundles exists.
    AppBundle(&'static [&'static str]),
    /// Always considered available (e.g. Reveal in Finder uses `open`).
    Always,
}

#[derive(Debug, Clone, Copy)]
enum LaunchAction {
    /// Run a CLI with the path as a positional argument.
    Cli(&'static str),
    /// `open -a <bundle> <path>` style.
    OpenWithBundle(&'static str),
    /// Custom: AppleScript or anything else built by the runner.
    Custom(fn(&Path) -> std::io::Result<()>),
}

struct LauncherDef {
    info: Launcher,
    detect: DetectStrategy,
    action: LaunchAction,
}

const LAUNCHERS: &[LauncherDef] = &[
    // ── Editors ──────────────────────────────────────────────────────
    LauncherDef {
        info: Launcher { id: "vscode", name: "VS Code", kind: LauncherKind::Editor },
        detect: DetectStrategy::Cli(&["code"]),
        action: LaunchAction::Cli("code"),
    },
    LauncherDef {
        info: Launcher { id: "cursor", name: "Cursor", kind: LauncherKind::Editor },
        detect: DetectStrategy::Cli(&["cursor"]),
        action: LaunchAction::Cli("cursor"),
    },
    LauncherDef {
        info: Launcher { id: "zed", name: "Zed", kind: LauncherKind::Editor },
        detect: DetectStrategy::Cli(&["zed"]),
        action: LaunchAction::Cli("zed"),
    },
    LauncherDef {
        info: Launcher { id: "windsurf", name: "Windsurf", kind: LauncherKind::Editor },
        detect: DetectStrategy::Cli(&["windsurf"]),
        action: LaunchAction::Cli("windsurf"),
    },
    LauncherDef {
        info: Launcher { id: "xcode", name: "Xcode", kind: LauncherKind::Editor },
        detect: DetectStrategy::Cli(&["xed"]),
        action: LaunchAction::Cli("xed"),
    },
    LauncherDef {
        info: Launcher { id: "intellij", name: "IntelliJ IDEA", kind: LauncherKind::Editor },
        detect: DetectStrategy::Cli(&["idea"]),
        action: LaunchAction::Cli("idea"),
    },
    LauncherDef {
        info: Launcher { id: "webstorm", name: "WebStorm", kind: LauncherKind::Editor },
        detect: DetectStrategy::Cli(&["webstorm"]),
        action: LaunchAction::Cli("webstorm"),
    },
    LauncherDef {
        info: Launcher { id: "pycharm", name: "PyCharm", kind: LauncherKind::Editor },
        detect: DetectStrategy::Cli(&["pycharm"]),
        action: LaunchAction::Cli("pycharm"),
    },
    LauncherDef {
        info: Launcher { id: "goland", name: "GoLand", kind: LauncherKind::Editor },
        detect: DetectStrategy::Cli(&["goland"]),
        action: LaunchAction::Cli("goland"),
    },
    LauncherDef {
        info: Launcher { id: "rustrover", name: "RustRover", kind: LauncherKind::Editor },
        detect: DetectStrategy::Cli(&["rustrover"]),
        action: LaunchAction::Cli("rustrover"),
    },
    LauncherDef {
        info: Launcher { id: "clion", name: "CLion", kind: LauncherKind::Editor },
        detect: DetectStrategy::Cli(&["clion"]),
        action: LaunchAction::Cli("clion"),
    },
    LauncherDef {
        info: Launcher { id: "phpstorm", name: "PhpStorm", kind: LauncherKind::Editor },
        detect: DetectStrategy::Cli(&["phpstorm"]),
        action: LaunchAction::Cli("phpstorm"),
    },
    LauncherDef {
        info: Launcher { id: "rubymine", name: "RubyMine", kind: LauncherKind::Editor },
        detect: DetectStrategy::Cli(&["rubymine"]),
        action: LaunchAction::Cli("rubymine"),
    },
    // ── Terminals ────────────────────────────────────────────────────
    LauncherDef {
        info: Launcher { id: "iterm", name: "iTerm", kind: LauncherKind::Terminal },
        detect: DetectStrategy::AppBundle(&["/Applications/iTerm.app"]),
        action: LaunchAction::Custom(launch_iterm),
    },
    LauncherDef {
        info: Launcher { id: "warp", name: "Warp", kind: LauncherKind::Terminal },
        detect: DetectStrategy::AppBundle(&["/Applications/Warp.app"]),
        action: LaunchAction::OpenWithBundle("Warp"),
    },
    LauncherDef {
        info: Launcher { id: "terminal", name: "Terminal", kind: LauncherKind::Terminal },
        detect: DetectStrategy::AppBundle(&["/System/Applications/Utilities/Terminal.app"]),
        action: LaunchAction::OpenWithBundle("Terminal"),
    },
    LauncherDef {
        info: Launcher { id: "ghostty", name: "Ghostty", kind: LauncherKind::Terminal },
        detect: DetectStrategy::Cli(&["ghostty"]),
        action: LaunchAction::Custom(launch_ghostty),
    },
    // ── File manager ─────────────────────────────────────────────────
    LauncherDef {
        info: Launcher { id: "finder", name: "Reveal in Finder", kind: LauncherKind::FileManager },
        detect: DetectStrategy::Always,
        action: LaunchAction::Custom(reveal_in_finder),
    },
];

fn is_available(strategy: DetectStrategy) -> bool {
    match strategy {
        DetectStrategy::Always => true,
        DetectStrategy::Cli(names) => names.iter().any(|n| which(n).is_some()),
        DetectStrategy::AppBundle(paths) => paths.iter().any(|p| Path::new(p).exists()),
    }
}

fn which(cmd: &str) -> Option<std::path::PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_env) {
        let candidate = dir.join(cmd);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn find_def(id: &str) -> Option<&'static LauncherDef> {
    LAUNCHERS.iter().find(|d| d.info.id == id)
}

#[tauri::command]
pub fn list_launchers(
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<Launcher>, String> {
    // Auth errors collapse into the existing `String` envelope so the TS
    // signature stays unchanged.
    session.require().map_err(|e| e.to_string())?;
    Ok(LAUNCHERS
        .iter()
        .filter(|d| is_available(d.detect))
        .map(|d| d.info.clone())
        .collect())
}

#[tauri::command]
pub fn launch_app(
    launcher_id: String,
    path: String,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), String> {
    session.require().map_err(|e| e.to_string())?;
    let def = find_def(&launcher_id).ok_or_else(|| format!("unknown launcher `{launcher_id}`"))?;
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("path does not exist: {path}"));
    }
    match def.action {
        LaunchAction::Cli(cmd) => spawn_cli(cmd, target).map_err(|e| e.to_string()),
        LaunchAction::OpenWithBundle(name) => open_with_bundle(name, target).map_err(|e| e.to_string()),
        LaunchAction::Custom(f) => f(target).map_err(|e| e.to_string()),
    }
}

fn spawn_cli(cmd: &str, path: &Path) -> std::io::Result<()> {
    std::process::Command::new(cmd).arg(path).spawn()?;
    Ok(())
}

fn open_with_bundle(name: &str, path: &Path) -> std::io::Result<()> {
    std::process::Command::new("open")
        .args(["-a", name])
        .arg(path)
        .spawn()?;
    Ok(())
}

fn reveal_in_finder(path: &Path) -> std::io::Result<()> {
    std::process::Command::new("open").arg("-R").arg(path).spawn()?;
    Ok(())
}

fn launch_iterm(path: &Path) -> std::io::Result<()> {
    // iTerm doesn't accept a path on the CLI; use AppleScript to open
    // a new tab with the desired CWD.
    let script = format!(
        r#"tell application "iTerm"
            activate
            tell current window
                create tab with default profile
                tell current session
                    write text "cd '{path}' && clear"
                end tell
            end tell
        end tell"#,
        path = path.display().to_string().replace('\'', "\\'")
    );
    std::process::Command::new("osascript")
        .args(["-e", &script])
        .spawn()?;
    Ok(())
}

fn launch_ghostty(path: &Path) -> std::io::Result<()> {
    std::process::Command::new("ghostty")
        .arg(format!("--working-directory={}", path.display()))
        .spawn()?;
    Ok(())
}
