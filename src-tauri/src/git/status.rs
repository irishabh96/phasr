use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use super::error::{run_git, GitError};

/// Combined index + working-tree status for one file. Mirrors what
/// `git status --porcelain=v1` produces (two letters indicating
/// staged/unstaged state).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// Optional rename source (only for `Renamed`).
    pub old_path: Option<String>,
    pub staged: FileStatus,
    pub unstaged: FileStatus,
    /// Lines added for this path, summed across the working-tree diff and
    /// the index diff. `None` for binary files (numstat prints `-`) and
    /// untracked files (no numstat entry). Lets a collapsed diff card draw
    /// its +N/-N badge WITHOUT the frontend fetching and parsing each
    /// file's full diff (A2).
    pub adds: Option<u32>,
    /// Lines removed for this path (see `adds`).
    pub removes: Option<u32>,
}

/// Lists the working-tree changes in `cwd` (which should be either a
/// worktree directory or a regular repo path).
pub fn status(cwd: &Path) -> Result<Vec<FileChange>, GitError> {
    // `-z` produces NUL-delimited records, with paths NUL-terminated,
    // and (for renames) old\0new pairs. We parse defensively.
    // `--untracked-files=all` lists each file inside an untracked folder
    // individually — the default (`-unormal`) collapses it into a single
    // `newfolder/` entry that can't be diffed (it's a directory).
    let stdout = run_git(
        cwd,
        &["status", "--porcelain=v1", "--untracked-files=all", "-z"],
    )?;
    let mut changes = parse_porcelain(&stdout);

    // Two whole-worktree numstat calls (working tree + index) give every
    // collapsed card its +N/-N badge, replacing the frontend's ~2N per-file
    // `git_diff` fetches (A1/A2). Merged by path; a file staged AND modified
    // sums both sides.
    let counts = collect_line_counts(cwd)?;
    for change in &mut changes {
        if let Some(&(adds, removes)) = counts.get(&change.path) {
            change.adds = adds;
            change.removes = removes;
        }
    }
    Ok(changes)
}

/// Added/removed line counts per path, summed across `git diff --numstat`
/// (working tree vs index) and `git diff --cached --numstat` (index vs
/// HEAD). A `(None, None)` entry marks a binary file. Untracked files have
/// no entry (they don't appear in either diff).
fn collect_line_counts(
    cwd: &Path,
) -> Result<HashMap<String, (Option<u32>, Option<u32>)>, GitError> {
    let mut counts: HashMap<String, (Option<u32>, Option<u32>)> = HashMap::new();
    for args in [
        ["diff", "--numstat"].as_slice(),
        ["diff", "--cached", "--numstat"].as_slice(),
    ] {
        merge_numstat(&run_git(cwd, args)?, &mut counts);
    }
    Ok(counts)
}

/// Parse `git ... --numstat` output (`<adds>\t<removes>\t<path>` per line)
/// and fold it into `into`, summing text counts. Binary rows (`-`) collapse
/// the merged count to `None`. Renames (`old => new`) are skipped — they're
/// rare and the badge is best-effort.
fn merge_numstat(numstat: &str, into: &mut HashMap<String, (Option<u32>, Option<u32>)>) {
    for line in numstat.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(adds), Some(removes), Some(path)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if path.contains(" => ") {
            continue;
        }
        let adds = if adds == "-" { None } else { adds.parse::<u32>().ok() };
        let removes = if removes == "-" {
            None
        } else {
            removes.parse::<u32>().ok()
        };
        let entry = into.entry(path.to_string()).or_insert((Some(0), Some(0)));
        // Sum text counts; a binary side on either diff makes the merged
        // count binary (None).
        entry.0 = match (entry.0, adds) {
            (Some(a), Some(b)) => Some(a + b),
            _ => None,
        };
        entry.1 = match (entry.1, removes) {
            (Some(a), Some(b)) => Some(a + b),
            _ => None,
        };
    }
}

fn parse_porcelain(input: &str) -> Vec<FileChange> {
    let mut out = Vec::new();
    let mut iter = input.split('\0').peekable();
    while let Some(entry) = iter.next() {
        if entry.is_empty() {
            continue;
        }
        if entry.len() < 3 {
            continue;
        }
        let bytes = entry.as_bytes();
        let staged_code = bytes[0] as char;
        let unstaged_code = bytes[1] as char;
        let path = &entry[3..];

        // Renames pair the entry with its source path in the next slot.
        let old_path = if staged_code == 'R' || unstaged_code == 'R' {
            iter.next().map(|s| s.to_string())
        } else {
            None
        };

        out.push(FileChange {
            path: path.to_string(),
            old_path,
            staged: status_from_code(staged_code, false),
            unstaged: status_from_code(unstaged_code, true),
            // Filled in by `status()` from numstat; the porcelain parse
            // alone doesn't carry line counts.
            adds: None,
            removes: None,
        });
    }
    out
}

fn status_from_code(code: char, is_unstaged: bool) -> FileStatus {
    match code {
        ' ' => FileStatus::Other,
        'A' => FileStatus::Added,
        'M' => FileStatus::Modified,
        'D' => FileStatus::Deleted,
        'R' => FileStatus::Renamed,
        '?' if is_unstaged => FileStatus::Untracked,
        'U' => FileStatus::Conflicted,
        _ => FileStatus::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mixed_changes() {
        // Two modified + one untracked + one staged-added.
        let input = " M src/a.rs\0M  src/b.rs\0?? new.txt\0A  added.rs\0";
        let parsed = parse_porcelain(input);
        assert_eq!(parsed.len(), 4);
        assert_eq!(parsed[0].path, "src/a.rs");
        assert_eq!(parsed[0].unstaged, FileStatus::Modified);
        assert_eq!(parsed[1].path, "src/b.rs");
        assert_eq!(parsed[1].staged, FileStatus::Modified);
        assert_eq!(parsed[2].path, "new.txt");
        assert_eq!(parsed[2].unstaged, FileStatus::Untracked);
        assert_eq!(parsed[3].path, "added.rs");
        assert_eq!(parsed[3].staged, FileStatus::Added);
    }

    #[test]
    fn parses_rename_with_old_path() {
        let input = "R  new/path.rs\0old/path.rs\0";
        let parsed = parse_porcelain(input);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].path, "new/path.rs");
        assert_eq!(parsed[0].old_path.as_deref(), Some("old/path.rs"));
        assert_eq!(parsed[0].staged, FileStatus::Renamed);
    }

    #[test]
    fn merge_numstat_sums_text_and_marks_binary() {
        let mut counts = HashMap::new();
        // Working tree: a.rs +3/-1, bin.png binary, b.rs +2/-0.
        merge_numstat("3\t1\ta.rs\n-\t-\tbin.png\n2\t0\tb.rs\n", &mut counts);
        // Index also touched a.rs (+4/-2) — should sum with the above.
        merge_numstat("4\t2\ta.rs\n", &mut counts);

        assert_eq!(counts.get("a.rs"), Some(&(Some(7), Some(3))));
        assert_eq!(counts.get("b.rs"), Some(&(Some(2), Some(0))));
        assert_eq!(counts.get("bin.png"), Some(&(None, None)));
    }

    #[test]
    fn merge_numstat_skips_rename_rows() {
        let mut counts = HashMap::new();
        merge_numstat("1\t0\told.rs => new.rs\n", &mut counts);
        assert!(counts.is_empty());
    }

    #[test]
    fn status_attaches_line_counts_to_tracked_changes() {
        use std::process::Command;
        let repo = tempfile::tempdir().unwrap();
        for args in [
            ["init", "-q", "-b", "main"].as_slice(),
            ["config", "user.email", "t@example.com"].as_slice(),
            ["config", "user.name", "tester"].as_slice(),
        ] {
            Command::new("git")
                .args(args)
                .current_dir(repo.path())
                .status()
                .unwrap();
        }
        std::fs::write(repo.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(repo.path())
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-qm", "init"])
            .current_dir(repo.path())
            .status()
            .unwrap();
        // Append two lines in the working tree.
        std::fs::write(repo.path().join("a.txt"), "one\ntwo\nthree\nfour\nfive\n").unwrap();

        let changes = status(repo.path()).unwrap();
        let a = changes.iter().find(|c| c.path == "a.txt").expect("a.txt changed");
        assert_eq!(a.adds, Some(2));
        assert_eq!(a.removes, Some(0));
    }

    #[test]
    fn untracked_folder_is_listed_per_file_not_collapsed() {
        use std::process::Command;
        let repo = tempfile::tempdir().unwrap();
        Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(repo.path())
            .status()
            .unwrap();
        std::fs::create_dir(repo.path().join("newdir")).unwrap();
        std::fs::write(repo.path().join("newdir/a.txt"), "hi\n").unwrap();
        std::fs::write(repo.path().join("newdir/b.txt"), "yo\n").unwrap();

        let changes = status(repo.path()).unwrap();
        let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
        // `--untracked-files=all` lists each file individually instead of a
        // single collapsed `newdir/` entry (which couldn't be diffed).
        assert!(paths.contains(&"newdir/a.txt"), "got {paths:?}");
        assert!(paths.contains(&"newdir/b.txt"), "got {paths:?}");
        assert!(
            !paths.iter().any(|p| p.ends_with('/')),
            "no collapsed directory entry expected; got {paths:?}"
        );
        assert!(changes.iter().all(|c| c.unstaged == FileStatus::Untracked));
    }
}
