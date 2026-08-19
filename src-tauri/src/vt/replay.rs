//! Conformance by replay.
//!
//! `pump_pty_output` appends every raw PTY byte to `<app_data>/logs/<id>.log`,
//! so a corpus of real claude/codex/gemini byte streams already exists on
//! every developer's disk — no capture work, no synthetic fixtures, and no
//! guessing about what agents actually emit. Feeding those logs through a
//! candidate engine and looking at the resulting state is unusually cheap
//! evidence, and it is what should decide the engine rather than a preference.
//!
//! Nothing here runs in the app. It is a harness for `cargo test` and for a
//! throwaway comparison between two engines.

use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use super::engine::{VtEngine, VtModes};

/// What a replay says about an engine's behaviour on one log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayReport {
    pub source: PathBuf,
    pub bytes_fed: usize,
    /// Total bytes the engine wanted to write BACK to the PTY (DA, DSR,
    /// XTVERSION). Zero here is a red flag, not a clean bill of health: a
    /// real agent stream contains device queries, and an engine that answers
    /// none of them will hang a TUI that waits for one.
    pub reply_bytes: usize,
    pub final_modes: VtModes,
    pub rows: u16,
    pub cols: u16,
    /// Bottom rows at end of stream — the "what is this agent showing me
    /// right now" view that agent-liveness detection is built on.
    pub tail: Vec<String>,
    /// EVERY visible row at end of stream, top to bottom.
    ///
    /// This is the artefact that lets one engine be compared to another, or
    /// one chunking to another, as a real diff rather than as a summary:
    /// two runs that agree on modes and on the last eight lines can still
    /// disagree about row 3. `grid_diff` renders the difference.
    pub grid: Vec<String>,
}

impl ReplayReport {
    /// Human-readable first divergence between two grids, or `None` when
    /// they are identical. Reported rather than asserted so a conformance
    /// run can show *what* moved, not just that something did.
    pub fn grid_diff(&self, other: &ReplayReport) -> Option<String> {
        if self.grid == other.grid {
            return None;
        }
        let rows = self.grid.len().max(other.grid.len());
        for row in 0..rows {
            let a = self.grid.get(row).map(String::as_str).unwrap_or("<missing>");
            let b = other.grid.get(row).map(String::as_str).unwrap_or("<missing>");
            if a != b {
                return Some(format!(
                    "row {row} differs:\n  a: {a:?}\n  b: {b:?}"
                ));
            }
        }
        Some("grids differ in length only".to_string())
    }
}

/// Feed one log through an engine in `chunk`-sized bites.
///
/// `chunk` matters: it deliberately re-creates arbitrary read boundaries, so
/// an engine that mishandles a control sequence split across two `advance`
/// calls is caught here rather than in production. Pass a few different sizes.
pub fn replay_log<E: VtEngine>(
    path: &Path,
    engine: &mut E,
    chunk: usize,
) -> io::Result<ReplayReport> {
    replay_log_capped(path, engine, chunk, usize::MAX)
}

/// As `replay_log`, but stops after `max_bytes`.
///
/// The cap exists for the 1-byte-chunk pass: the real corpus contains 23 MB
/// logs, and 23 million `advance` calls in a debug build is minutes, not
/// seconds. Boundary bugs show up in the first megabyte or not at all.
pub fn replay_log_capped<E: VtEngine>(
    path: &Path,
    engine: &mut E,
    chunk: usize,
    max_bytes: usize,
) -> io::Result<ReplayReport> {
    let mut file = File::open(path)?;
    let mut buf = vec![0u8; chunk.max(1)];
    let mut bytes_fed = 0usize;
    let mut reply_bytes = 0usize;

    while bytes_fed < max_bytes {
        let want = buf.len().min(max_bytes - bytes_fed);
        let n = file.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        engine.advance(&buf[..n]);
        bytes_fed += n;
        reply_bytes += engine.take_replies().len();
    }

    let (rows, cols) = engine.size();
    Ok(ReplayReport {
        source: path.to_path_buf(),
        bytes_fed,
        reply_bytes,
        final_modes: engine.modes(),
        rows,
        cols,
        tail: engine.tail(rows.min(8)),
        grid: (0..rows).filter_map(|r| engine.row_text(r)).collect(),
    })
}

/// Every `.log` in a directory, largest first — biggest streams exercise the
/// most state, so they fail fastest.
pub fn corpus(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files: Vec<(u64, PathBuf)> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "log"))
        .filter_map(|e| e.metadata().ok().map(|m| (m.len(), e.path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(files.into_iter().map(|(_, p)| p).collect())
}

/// The real corpus on this machine, if phasr has ever run here.
///
/// Returns `None` rather than failing so a conformance test is a no-op on a
/// fresh checkout and on CI, and real evidence on a developer's machine.
pub fn local_corpus_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let dir = Path::new(&home)
        .join("Library/Application Support/sh.phasr.desktop/logs");
    dir.is_dir().then_some(dir)
}
