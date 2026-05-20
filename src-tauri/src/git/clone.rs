use std::path::Path;

use super::error::{run_git, GitError};

/// `git clone <url> <destination>`. The parent directory of `destination`
/// must exist; `git clone` itself creates the leaf directory.
///
/// Fails fast if the destination already exists and is non-empty, so we
/// never overwrite a user's work.
pub fn clone_repo(url: &str, destination: &Path) -> Result<(), GitError> {
    if destination.exists() {
        let is_empty = std::fs::read_dir(destination)
            .map(|mut it| it.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            return Err(GitError::CommandFailed(format!(
                "destination already exists and is non-empty: {}",
                destination.display()
            )));
        }
    }

    let parent = destination.parent().ok_or(GitError::InvalidPath)?;
    std::fs::create_dir_all(parent)?;

    let dest_str = destination.to_str().ok_or(GitError::InvalidPath)?;
    // `cwd` for run_git is the parent; we hand `git` the destination
    // as a positional arg so it creates it.
    run_git(parent, &["clone", url, dest_str])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_non_empty_destination() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("existing");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("a.txt"), "hi").unwrap();
        let err = clone_repo("https://example.invalid/repo.git", &dest).unwrap_err();
        assert!(matches!(err, GitError::CommandFailed(_)));
    }
}
