//! Conformance against the **real** corpus.
//!
//! `pump_pty_output` appends every raw PTY byte to `<app_data>/logs/<id>.log`,
//! so a corpus of genuine claude / codex / gemini byte streams already exists
//! on any machine phasr has run on — no capture work, no synthetic fixtures,
//! and no guessing about what agents actually emit. That is what decides the
//! engine here, rather than a preference.
//!
//! Every test below is a **no-op on a machine with no corpus** (a fresh
//! checkout, CI) and real evidence everywhere else. Run with
//! `--features vt-alacritty -- --nocapture` to see the report.

use std::path::Path;

use super::alacritty::AlacrittyEngine;
use super::replay::{corpus, local_corpus_dir, replay_log_capped, ReplayReport};

/// Same grid the agent's terminal actually had: 24×80 is what a PTY is
/// spawned at before the first fit, and most of these logs start there.
fn engine() -> AlacrittyEngine {
    AlacrittyEngine::new(24, 80, 10_000)
}

fn logs() -> Vec<std::path::PathBuf> {
    local_corpus_dir()
        .and_then(|dir| corpus(&dir).ok())
        .unwrap_or_default()
}

fn replay(path: &Path, chunk: usize, cap: usize) -> ReplayReport {
    let mut e = engine();
    replay_log_capped(path, &mut e, chunk, cap).expect("replay failed")
}

fn name(path: &Path) -> String {
    path.file_name().unwrap().to_string_lossy().to_string()
}

/// **The conformance property.** A PTY hands out whatever `read()` returned,
/// so the same stream arrives at different boundaries on every run, and Phase
/// 3's coalescer moves those boundaries again. An engine whose grid depends on
/// where the chunks fell renders differently on a slow disk.
///
/// A PTY read in phasr is 4096 bytes and the coalescer only makes chunks
/// BIGGER (32 KiB / 8 ms), so 512 B – 64 KiB is the whole range that can
/// actually occur. That range is asserted.
const REALISTIC_CHUNKS: [usize; 6] = [512, 1024, 4096, 8192, 16384, 65536];

/// Deliberately pathological — not reachable from a PTY read, but they are
/// where a boundary bug shows itself. Reported rather than asserted: see
/// `pathological_chunk_sizes_are_reported_not_gated`.
const PATHOLOGICAL_CHUNKS: [usize; 6] = [1, 2, 3, 7, 17, 63];

/// 1 MiB is enough to cross hundreds of frames while keeping a 1-byte-chunk
/// pass to seconds in a debug build.
const CAP: usize = 1 << 20;

#[test]
fn grid_is_independent_of_realistic_chunk_boundaries() {
    let logs = logs();
    if logs.is_empty() {
        eprintln!("no corpus on this machine — conformance skipped");
        return;
    }

    for path in logs.iter().take(12) {
        let baseline = replay(path, 4096, CAP);
        if baseline.bytes_fed == 0 {
            continue;
        }
        for chunk in REALISTIC_CHUNKS {
            let other = replay(path, chunk, CAP);
            assert_eq!(
                other.bytes_fed, baseline.bytes_fed,
                "{}: fed a different number of bytes at chunk={chunk}",
                name(path)
            );
            if let Some(diff) = baseline.grid_diff(&other) {
                panic!(
                    "{}: grid depends on chunk size (4096 vs {chunk})\n{diff}",
                    name(path)
                );
            }
            assert_eq!(
                other.final_modes, baseline.final_modes,
                "{}: modes depend on chunk size (4096 vs {chunk})",
                name(path)
            );
        }
    }
}

/// What the corpus replay actually found, kept as a standing measurement.
///
/// `alacritty_terminal` 0.26 is **not** perfectly boundary-invariant at
/// pathological chunk sizes. On real Claude Code traffic a boundary that
/// splits a multi-byte UTF-8 grapheme (`·` = C2 B7, `↓` = E2 86 93) at one
/// specific offset shifts a spinner status line by one column — one row of
/// 24, deterministic, and only at chunk sizes a PTY never produces (the
/// first divergence found was chunk = 3 on `a19a1920…log`, at byte 16104,
/// mid-`↓`).
///
/// It is reported and bounded rather than gated because:
///
/// - it is unreachable from phasr's read path (4096 B, coalesced upward);
/// - `modes` — the only thing B1 consumes for readiness — is identical in
///   every case, which IS asserted here;
/// - echo verification asks "does the bottom row *contain* the needle", so a
///   one-column shift inside a status line cannot flip it.
///
/// If this ever grows past a couple of rows, or starts touching modes, the
/// engine choice needs revisiting — which is exactly what the assertion
/// below is for.
#[test]
fn pathological_chunk_sizes_are_reported_not_gated() {
    let logs = logs();
    if logs.is_empty() {
        eprintln!("no corpus on this machine — conformance skipped");
        return;
    }
    let mut worst = 0usize;

    for path in logs.iter().take(12) {
        let baseline = replay(path, 4096, CAP);
        if baseline.bytes_fed == 0 {
            continue;
        }
        for chunk in PATHOLOGICAL_CHUNKS {
            let other = replay(path, chunk, CAP);
            // Modes are the load-bearing output. No tolerance here.
            assert_eq!(
                other.final_modes, baseline.final_modes,
                "{}: MODES depend on chunk size (4096 vs {chunk}) — this one \
                 is not tolerable, readiness detection reads exactly this",
                name(path)
            );
            let rows: usize = baseline
                .grid
                .iter()
                .zip(other.grid.iter())
                .filter(|(a, b)| a != b)
                .count();
            if rows > 0 {
                worst = worst.max(rows);
                eprintln!(
                    "BOUNDARY {:<40} chunk={chunk:<6} rows-differing={rows}/{}",
                    name(path),
                    baseline.grid.len()
                );
            }
        }
    }
    eprintln!("BOUNDARY SUMMARY: worst case {worst} row(s) differ at a pathological chunk size");
    assert!(
        worst <= 2,
        "{worst} rows now differ at a pathological chunk size (was 1) — the \
         engine's boundary handling has regressed materially"
    );
}

/// Real agent streams contain device queries, and an engine that answers
/// none of them hangs a TUI on startup with nothing in any log. Zero replies
/// across 47 MB of genuine traffic would be the loudest possible red flag —
/// so the corpus is checked for the queries *and* the engine for the answers.
#[test]
fn device_queries_in_the_corpus_are_answered() {
    let logs = logs();
    if logs.is_empty() {
        eprintln!("no corpus on this machine — conformance skipped");
        return;
    }
    const CAP: usize = 4 << 20;
    let mut total_replies = 0usize;
    let mut logs_with_replies = 0usize;

    for path in logs.iter().take(12) {
        let report = replay(path, 4096, CAP);
        if report.reply_bytes > 0 {
            logs_with_replies += 1;
        }
        total_replies += report.reply_bytes;
        eprintln!(
            "CONFORMANCE {:<40} fed={:>9} replies={:>5} {}x{} alt={} mouse={} focus={} bp={} cursor={}",
            name(path),
            report.bytes_fed,
            report.reply_bytes,
            report.rows,
            report.cols,
            report.final_modes.alt_screen as u8,
            report.final_modes.mouse_any as u8,
            report.final_modes.focus_report as u8,
            report.final_modes.bracketed_paste as u8,
            report.final_modes.cursor_visible as u8,
        );
    }
    eprintln!(
        "CONFORMANCE SUMMARY: {total_replies} reply bytes across {logs_with_replies} of {} logs",
        logs.len().min(12)
    );
    assert!(
        total_replies > 0,
        "no device query was answered across the whole corpus — either the \
         corpus is not real agent traffic or the engine is not servicing \
         CSI c / CSI 6n, which hangs TUIs that wait for a reply"
    );
}

/// What B1 actually buys: readiness as terminal STATE instead of as a
/// substring match. Reported per log so the two answers can be compared on
/// real traffic rather than argued about.
///
/// `pty/handle.rs`'s scanner looks for the byte sequences that *set* these
/// modes, so it cannot see a mode that was set and then cleared, cannot see
/// one whose bytes were dropped by a `Lagged` broadcast, and fires on
/// `\x1b[?25l` from a shell prompt. Real state has none of those failure
/// modes — and where the two agree, that is evidence too.
#[test]
fn readiness_from_state_versus_byte_scanning() {
    let logs = logs();
    if logs.is_empty() {
        eprintln!("no corpus on this machine — conformance skipped");
        return;
    }
    const CAP: usize = 4 << 20;
    let mut agree = 0usize;
    let mut disagree = 0usize;

    for path in logs.iter().take(12) {
        let bytes = std::fs::read(path).unwrap_or_default();
        let head = &bytes[..bytes.len().min(CAP)];
        // What the byte scanner in `pty/handle.rs` looks for today.
        let scanned = [
            &b"\x1b[?1049h"[..],
            b"\x1b[?1000h",
            b"\x1b[?1002h",
            b"\x1b[?1003h",
            b"\x1b[?1004h",
        ]
        .iter()
        .any(|needle| find(head, needle));
        let cursor_hidden = find(head, b"\x1b[?25l");

        let report = replay(path, 4096, CAP);
        let m = report.final_modes;
        let stateful = m.alt_screen || m.mouse_any || m.focus_report;

        if scanned == stateful {
            agree += 1;
        } else {
            disagree += 1;
        }
        eprintln!(
            "READINESS {:<40} bytes-said={} state-says={} (alt={} mouse={} focus={}) cursor-hidden-in-stream={}",
            name(path),
            scanned as u8,
            stateful as u8,
            m.alt_screen as u8,
            m.mouse_any as u8,
            m.focus_report as u8,
            cursor_hidden as u8,
        );
    }
    eprintln!("READINESS SUMMARY: agree={agree} disagree={disagree}");
}

fn find(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}
