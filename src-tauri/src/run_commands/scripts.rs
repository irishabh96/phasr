//! Suggest run commands from a repository's `package.json` scripts, run
//! with the package manager its lockfile implies.

use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedScript {
    /// The script name (`dev`, `test`, …).
    pub name: String,
    /// The command line to run it (`pnpm run dev`).
    pub command: String,
    /// A run command with exactly this command line already exists.
    pub already_added: bool,
}

/// The package manager a checkout uses, from its lockfile (first match
/// wins, in the order tools themselves prefer), defaulting to npm.
pub fn package_manager(root: &Path) -> &'static str {
    const LOCKFILES: &[(&str, &str)] = &[
        ("pnpm-lock.yaml", "pnpm"),
        ("bun.lockb", "bun"),
        ("bun.lock", "bun"),
        ("yarn.lock", "yarn"),
        ("package-lock.json", "npm"),
    ];
    LOCKFILES
        .iter()
        .find(|(file, _)| root.join(file).exists())
        .map(|(_, pm)| *pm)
        .unwrap_or("npm")
}

/// `package.json` scripts under `root` (empty when there's no readable
/// manifest), marked when `existing` already has the same command line.
pub fn detect(root: &Path, existing: &[String]) -> Vec<DetectedScript> {
    let Ok(raw) = std::fs::read_to_string(root.join("package.json")) else {
        return Vec::new();
    };
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let Some(scripts) = manifest.get("scripts").and_then(|s| s.as_object()) else {
        return Vec::new();
    };
    let pm = package_manager(root);
    let existing: Vec<&str> = existing.iter().map(|c| c.trim()).collect();
    scripts
        .iter()
        .filter(|(_, body)| body.is_string())
        .map(|(name, _)| {
            // `yarn <script>` is the idiom; the rest take `run`.
            let command = if pm == "yarn" {
                format!("yarn {name}")
            } else {
                format!("{pm} run {name}")
            };
            DetectedScript {
                name: name.clone(),
                already_added: existing.contains(&command.as_str()),
                command,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_use_the_lockfile_s_package_manager_and_flag_existing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(detect(dir.path(), &[]).is_empty(), "no package.json");
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"scripts":{"dev":"vite","test":"vitest run","weird":42}}"#,
        )
        .unwrap();
        let npm = detect(dir.path(), &["npm run test ".into()]);
        assert_eq!(
            npm,
            vec![
                DetectedScript { name: "dev".into(), command: "npm run dev".into(), already_added: false },
                DetectedScript { name: "test".into(), command: "npm run test".into(), already_added: true },
            ]
        );
        std::fs::write(dir.path().join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(detect(dir.path(), &[])[0].command, "pnpm run dev");
        std::fs::remove_file(dir.path().join("pnpm-lock.yaml")).unwrap();
        std::fs::write(dir.path().join("yarn.lock"), "").unwrap();
        assert_eq!(detect(dir.path(), &[])[0].command, "yarn dev");
        std::fs::write(dir.path().join("package.json"), "{ not json").unwrap();
        assert!(detect(dir.path(), &[]).is_empty());
    }
}
