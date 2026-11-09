//! Path confinement for everything the Files tab reads or writes.
//!
//! The editor addresses files by a worktree-relative path that came over
//! IPC, so the path is untrusted: a crafted `../../.ssh/config`, an absolute
//! path, a write into `.git/hooks/` (code execution on the next commit), or
//! a symlink the agent planted pointing outside the worktree must all be
//! refused here, before any byte is read or written.
//!
//! Pure filesystem logic (no git process), but it lives with the other
//! worktree operations because every caller already holds a worktree root.

use std::path::{Component, Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum FsGuardError {
    #[error("path is empty")]
    Empty,
    #[error("path must be relative to the worktree")]
    Absolute,
    #[error("path may not contain `..`")]
    ParentTraversal,
    #[error("files inside `.git` can't be opened here")]
    GitDir,
    #[error("path resolves outside the worktree")]
    Escapes,
    #[error("worktree is not available on this machine")]
    RootMissing,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for FsGuardError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// The real on-disk location of `rel` inside `root`, or an error if it would
/// leave the worktree.
///
/// Lexical rules first (cheap, and they hold even for paths that don't
/// exist yet): no absolute path, no `..`, no `.git` component anywhere —
/// a submodule's `.git` file or a nested repo's hooks are as dangerous as
/// the top-level one.
///
/// Then symlinks: an existing path is canonicalised (every link resolved)
/// and must still be under the canonical root and outside its `.git`. A
/// path that doesn't exist yet (a new file) has its nearest existing
/// ancestor canonicalised instead, so `newdir/new.txt` under a symlinked
/// `newdir` → `/etc` is caught too. The returned path is canonical, so a
/// write through an in-tree symlink lands on (and keeps) the link's target
/// rather than replacing the link with a regular file.
///
/// Canonicalising the root also absorbs macOS's `/var` → `/private/var`
/// alias, which would otherwise make every `starts_with` check fail for
/// temp-dir worktrees.
pub fn resolve_in_worktree(root: &Path, rel: &str) -> Result<PathBuf, FsGuardError> {
    let normalized = lexically_safe(rel)?;
    let root = std::fs::canonicalize(root).map_err(|_| FsGuardError::RootMissing)?;
    let candidate = root.join(&normalized);

    if std::fs::symlink_metadata(&candidate).is_ok() {
        // Exists (possibly as a dangling link — canonicalize then fails,
        // which is the right answer: we can't vouch for where it points).
        let real = std::fs::canonicalize(&candidate).map_err(|_| FsGuardError::Escapes)?;
        ensure_inside(&root, &real)?;
        return Ok(real);
    }

    // New file: walk up to the nearest ancestor that exists and judge that.
    let mut existing = candidate.as_path();
    let mut missing: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        if std::fs::symlink_metadata(existing).is_ok() {
            break;
        }
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                missing.push(name);
                existing = parent;
            }
            _ => return Err(FsGuardError::Escapes),
        }
    }
    let mut real = std::fs::canonicalize(existing).map_err(|_| FsGuardError::Escapes)?;
    ensure_inside(&root, &real)?;
    for name in missing.into_iter().rev() {
        real.push(name);
    }
    Ok(real)
}

/// `true` when `path` (absolute) is inside one of `roots` after resolving
/// symlinks on both sides. A path that doesn't exist is judged by its
/// nearest existing ancestor; a root that doesn't exist matches nothing.
/// Used to confine the older absolute-path commands (`read_text_file`,
/// `list_repo_files`) to registered repositories and worktrees.
pub fn is_within_roots(path: &Path, roots: &[PathBuf]) -> bool {
    if !path.is_absolute() || path.components().any(|c| c == Component::ParentDir) {
        return false;
    }
    let Some(real) = canonical_or_ancestor(path) else {
        return false;
    };
    roots
        .iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .any(|root| real.starts_with(&root))
}

fn canonical_or_ancestor(path: &Path) -> Option<PathBuf> {
    let mut current = path;
    let mut missing = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(current) {
            let mut real = real;
            for name in missing.into_iter().rev() {
                real.push(name);
            }
            return Some(real);
        }
        // Exists but won't canonicalise = a dangling symlink: reading
        // through it could go anywhere once its target appears.
        if std::fs::symlink_metadata(current).is_ok() {
            return None;
        }
        missing.push(current.file_name()?.to_os_string());
        current = current.parent()?;
    }
}

/// The relative path with `.` components dropped, after the lexical rules.
fn lexically_safe(rel: &str) -> Result<PathBuf, FsGuardError> {
    let trimmed = rel.trim();
    if trimmed.is_empty() {
        return Err(FsGuardError::Empty);
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err(FsGuardError::Absolute);
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => {
                // Case-insensitive: APFS is, so `.GIT/config` is `.git/config`.
                if name.to_string_lossy().eq_ignore_ascii_case(".git") {
                    return Err(FsGuardError::GitDir);
                }
                out.push(name);
            }
            Component::CurDir => {}
            Component::ParentDir => return Err(FsGuardError::ParentTraversal),
            Component::RootDir | Component::Prefix(_) => return Err(FsGuardError::Absolute),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(FsGuardError::Empty);
    }
    Ok(out)
}

fn ensure_inside(root: &Path, real: &Path) -> Result<(), FsGuardError> {
    let Ok(inside) = real.strip_prefix(root) else {
        return Err(FsGuardError::Escapes);
    };
    // A symlink whose target is the worktree's own `.git` (or anything in
    // it) is as bad as naming `.git` directly.
    if inside
        .components()
        .any(|c| matches!(c, Component::Normal(n) if n.to_string_lossy().eq_ignore_ascii_case(".git")))
    {
        return Err(FsGuardError::GitDir);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/config"), "[core]\n").unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/main.rs"), "fn main() {}\n").unwrap();
        dir
    }

    #[test]
    fn plain_relative_paths_resolve_inside_the_root() {
        let dir = root();
        let real = resolve_in_worktree(dir.path(), "src/main.rs").unwrap();
        assert_eq!(real, std::fs::canonicalize(dir.path().join("src/main.rs")).unwrap());
        // `./` prefixes are fine.
        assert_eq!(resolve_in_worktree(dir.path(), "./src/main.rs").unwrap(), real);
        // A new file in a new directory resolves under the canonical root.
        let new = resolve_in_worktree(dir.path(), "src/new/mod.rs").unwrap();
        assert!(new.starts_with(std::fs::canonicalize(dir.path()).unwrap()));
        assert!(new.ends_with("src/new/mod.rs"));
    }

    #[test]
    fn absolute_paths_are_rejected() {
        let dir = root();
        assert!(matches!(resolve_in_worktree(dir.path(), "/etc/passwd"), Err(FsGuardError::Absolute)));
        let inside = dir.path().join("src/main.rs");
        assert!(matches!(
            resolve_in_worktree(dir.path(), &inside.to_string_lossy()),
            Err(FsGuardError::Absolute)
        ));
    }

    #[test]
    fn parent_traversal_is_rejected_even_when_it_would_land_inside() {
        let dir = root();
        assert!(matches!(resolve_in_worktree(dir.path(), "../x"), Err(FsGuardError::ParentTraversal)));
        assert!(matches!(
            resolve_in_worktree(dir.path(), "src/../src/main.rs"),
            Err(FsGuardError::ParentTraversal)
        ));
    }

    #[test]
    fn anything_under_dot_git_is_rejected() {
        let dir = root();
        for rel in [".git/config", ".git", ".GIT/config", "vendor/lib/.git/hooks/pre-commit"] {
            assert!(
                matches!(resolve_in_worktree(dir.path(), rel), Err(FsGuardError::GitDir)),
                "{rel}"
            );
        }
        assert!(matches!(resolve_in_worktree(dir.path(), ""), Err(FsGuardError::Empty)));
        assert!(matches!(resolve_in_worktree(dir.path(), "."), Err(FsGuardError::Empty)));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_that_escape_the_root_are_rejected() {
        let dir = root();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "s").unwrap();
        // A file link out, a directory link out (new file under it too),
        // and a link back into `.git`.
        std::os::unix::fs::symlink(outside.path().join("secret"), dir.path().join("leak")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("outdir")).unwrap();
        std::os::unix::fs::symlink(dir.path().join(".git/config"), dir.path().join("cfg")).unwrap();
        assert!(matches!(resolve_in_worktree(dir.path(), "leak"), Err(FsGuardError::Escapes)));
        assert!(matches!(resolve_in_worktree(dir.path(), "outdir/secret"), Err(FsGuardError::Escapes)));
        assert!(matches!(resolve_in_worktree(dir.path(), "outdir/new.txt"), Err(FsGuardError::Escapes)));
        assert!(matches!(resolve_in_worktree(dir.path(), "cfg"), Err(FsGuardError::GitDir)));
        // A dangling link can't be vouched for.
        std::os::unix::fs::symlink("/no/such/target", dir.path().join("dangling")).unwrap();
        assert!(matches!(resolve_in_worktree(dir.path(), "dangling"), Err(FsGuardError::Escapes)));

        // An in-tree link resolves to its (in-tree) target.
        std::os::unix::fs::symlink(dir.path().join("src/main.rs"), dir.path().join("alias.rs")).unwrap();
        assert_eq!(
            resolve_in_worktree(dir.path(), "alias.rs").unwrap(),
            std::fs::canonicalize(dir.path().join("src/main.rs")).unwrap()
        );
    }

    #[test]
    fn missing_root_is_reported() {
        assert!(matches!(
            resolve_in_worktree(Path::new("/no/such/worktree"), "a.txt"),
            Err(FsGuardError::RootMissing)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn within_roots_resolves_symlinks_and_rejects_strangers() {
        let dir = root();
        let other = tempfile::tempdir().unwrap();
        let roots = vec![dir.path().to_path_buf()];
        assert!(is_within_roots(&dir.path().join("src/main.rs"), &roots));
        assert!(is_within_roots(&dir.path().join("src/not-yet.rs"), &roots));
        assert!(!is_within_roots(&other.path().join("x"), &roots));
        assert!(!is_within_roots(Path::new("relative/path"), &roots));
        assert!(!is_within_roots(&dir.path().join("src/../../x"), &roots));
        std::os::unix::fs::symlink(other.path(), dir.path().join("out")).unwrap();
        assert!(!is_within_roots(&dir.path().join("out/x"), &roots));
        assert!(!is_within_roots(&dir.path().join("src/main.rs"), &[]));
    }
}
