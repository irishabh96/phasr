//! Rust-side performance harness for the terminal path. Findings are
//! written up in `docs/adr/ADR-002-terminal-engine.md`.
//!
//! Everything here measures the parts of the terminal path that are
//! **engine-independent**: the output coalescer and the base64 wire
//! format. Neither involves a terminal emulator, so unlike a browser-side
//! probe these numbers transfer to the shipping WKWebView build
//! unchanged.
//!
//! Nothing here is a gate. Every test is `#[ignore]`d and every test is a
//! no-op on a machine with no PTY log corpus, so a fresh checkout and CI
//! both stay green.
//!
//! ```text
//! PHASR_BENCH=1 cargo test --manifest-path src-tauri/Cargo.toml --lib \
//!     perfbench -- --ignored --nocapture --test-threads=1
//! ```

#![cfg(test)]

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::pty::handle::{PtyEvent, PtyHandle, PtySpawnOptions};

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/// Sentinels the producer brackets its payload with, so a measurement
/// window can start at the first payload byte rather than at spawn — the
/// shell's own prompt and command echo are outside it either way.
const START: &[u8] = b"\x01PHASR_BENCH_START\x01";
const END: &[u8] = b"\x01PHASR_BENCH_END\x01";

/// The real PTY log corpus. Same directory `vt/conformance.rs` replays, and
/// the same 49 MB `tuiFrame()`'s escape density was calibrated against.
fn corpus_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let dir = PathBuf::from(home)
        .join("Library/Application Support/sh.phasr.desktop/logs");
    dir.is_dir().then_some(dir)
}

/// Corpus logs, largest first, excluding anything too small to be a real
/// session.
fn corpus_logs(min_bytes: u64) -> Vec<(PathBuf, u64)> {
    let Some(dir) = corpus_dir() else {
        return Vec::new();
    };
    let mut logs: Vec<(PathBuf, u64)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "log"))
        .filter_map(|e| {
            let len = e.metadata().ok()?.len();
            (len >= min_bytes).then(|| (e.path(), len))
        })
        .collect();
    logs.sort_by(|a, b| b.1.cmp(&a.1));
    logs
}

fn enabled() -> bool {
    std::env::var_os("PHASR_BENCH").is_some()
}

fn median(mut xs: Vec<f64>) -> f64 {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = xs.len();
    if n == 0 {
        return f64::NAN;
    }
    if n % 2 == 1 {
        xs[n / 2]
    } else {
        (xs[n / 2 - 1] + xs[n / 2]) / 2.0
    }
}

fn spread(xs: &[f64]) -> (f64, f64) {
    let lo = xs.iter().copied().fold(f64::INFINITY, f64::min);
    let hi = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    (lo, hi)
}

/// `haystack` ends with a partial `needle`? Returns how many trailing bytes
/// to carry so a sentinel split across two reads is still found.
fn carry_len(needle: &[u8]) -> usize {
    needle.len().saturating_sub(1)
}

// ---------------------------------------------------------------------------
// The producer: a real process writing real corpus bytes at a set rate
// ---------------------------------------------------------------------------

/// Writes `burst` bytes of corpus every `period_ms`, for `duration_ms`,
/// bracketed by the sentinels. `period_ms == 0` means "as fast as the PTY
/// will take it".
///
/// A separate process on the other side of a real PTY, deliberately: the
/// thing under measurement is how the kernel's PTY buffer, phasr's 4096-byte
/// reads and the coalescer's 32 KiB / 8 ms rule interact, and none of that
/// is reproducible by feeding a `Vec<u8>` to a function.
fn write_producer_script(dir: &Path) -> PathBuf {
    let path = dir.join("phasr_bench_producer.mjs");
    std::fs::write(
        &path,
        r#"
import { readFileSync } from "node:fs";

const [corpus, burstS, periodS, durationS] = process.argv.slice(2);
const burst = Number(burstS);
const period = Number(periodS);
const duration = Number(durationS);

// Real agent bytes, not synthetic ones: escape density is the whole point.
const source = readFileSync(corpus);
let off = 0;
function next(n) {
  const out = Buffer.alloc(n);
  let w = 0;
  while (w < n) {
    const take = Math.min(n - w, source.length - off);
    source.copy(out, w, off, off + take);
    w += take;
    off = (off + take) % source.length;
  }
  return out;
}

const write = (b) => new Promise((r) => (process.stdout.write(b) ? r() : process.stdout.once("drain", r)));

await write(Buffer.from("\x01PHASR_BENCH_START\x01", "binary"));
const t0 = Date.now();
if (period === 0) {
  while (Date.now() - t0 < duration) await write(next(burst));
} else {
  let tick = 0;
  while (Date.now() - t0 < duration) {
    await write(next(burst));
    tick += 1;
    const due = t0 + tick * period;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}
await write(Buffer.from("\x01PHASR_BENCH_END\x01", "binary"));
// Give the reader a moment before the PTY tears down.
await new Promise((r) => setTimeout(r, 300));
"#,
    )
    .expect("write producer script");
    path
}

#[derive(Debug, Clone, Copy)]
struct Rate {
    label: &'static str,
    burst: usize,
    period_ms: u64,
}

/// The rate ladder. Chosen to bracket what phasr actually receives rather
/// than to flatter either framing:
///
/// * `spinner`  — a status line repainting at 10 Hz. The low end.
/// * `tui-10hz` — a ~32 KiB full-screen agent repaint at 10 Hz. This is the
///   dominant phasr workload and exactly what `tuiFrame()` models.
/// * `tui-40hz` — the same frame at 40 Hz; an agent streaming hard.
/// * `bulk`     — unthrottled. A test log or a big file being catted.
const RATES: &[Rate] = &[
    Rate { label: "spinner  40 KB/s", burst: 4096, period_ms: 100 },
    Rate { label: "tui-10hz 320 KB/s", burst: 32768, period_ms: 100 },
    Rate { label: "tui-40hz 1.3 MB/s", burst: 32768, period_ms: 25 },
    Rate { label: "bulk     unthrottled", burst: 65536, period_ms: 0 },
];

const WINDOW_MS: u64 = 6000;
const REPS: usize = 5;

struct Framing {
    events: usize,
    bytes: usize,
    elapsed: Duration,
}

impl Framing {
    fn events_per_sec(&self) -> f64 {
        self.events as f64 / self.elapsed.as_secs_f64()
    }
    fn bytes_per_event(&self) -> f64 {
        self.bytes as f64 / self.events.max(1) as f64
    }
    fn mb_per_sec(&self) -> f64 {
        self.bytes as f64 / 1_048_576.0 / self.elapsed.as_secs_f64()
    }
}

/// AFTER — the shipping path. `PtyHandle::spawn` builds the real reader
/// thread, the real coalescer and the real broadcast; this counts what a
/// frontend subscriber would receive.
fn measure_shipping(corpus: &Path, script: &Path, rate: Rate) -> Framing {
    let tmp = tempfile::tempdir().expect("tempdir");
    let cmd = format!(
        "exec node {} {} {} {} {}",
        script.display(),
        corpus.display(),
        rate.burst,
        rate.period_ms,
        WINDOW_MS
    );
    let handle = PtyHandle::spawn(PtySpawnOptions {
        task_id: "bench".into(),
        initial_command: Some(cmd),
        initial_prompt: None,
        cwd: tmp.path().to_path_buf(),
        log_path: tmp.path().join("bench.log"),
        rows: 40,
        cols: 200,
    })
    .expect("spawn");

    let mut rx = handle.subscribe();
    let mut events = 0usize;
    let mut bytes = 0usize;
    let mut started: Option<Instant> = None;
    let mut finished: Option<Instant> = None;
    let mut carry: Vec<u8> = Vec::new();
    let mut lagged = 0usize;

    let deadline = Instant::now() + Duration::from_millis(WINDOW_MS + 20_000);
    while Instant::now() < deadline {
        match rx.blocking_recv() {
            Ok(PtyEvent::Output { chunk, .. }) => {
                let mut hay = std::mem::take(&mut carry);
                hay.extend_from_slice(&chunk);
                if started.is_none() {
                    if let Some(i) = find(&hay, START) {
                        started = Some(Instant::now());
                        // Payload that shared this chunk with the sentinel.
                        let tail = hay.len() - (i + START.len());
                        if tail > 0 {
                            events += 1;
                            bytes += tail;
                        }
                    }
                } else if let Some(i) = find(&hay, END) {
                    finished = Some(Instant::now());
                    bytes += i.saturating_sub(carry_len(END).min(i));
                    events += 1;
                    break;
                } else {
                    events += 1;
                    bytes += chunk.len();
                }
                let keep = carry_len(START.max(END)).min(hay.len());
                carry = hay[hay.len() - keep..].to_vec();
            }
            Ok(PtyEvent::Exit { .. }) => break,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                lagged += n as usize;
            }
            Err(_) => break,
        }
    }
    handle.kill().ok();
    assert_eq!(lagged, 0, "broadcast lagged — the measurement undercounts");

    Framing {
        events,
        bytes,
        elapsed: finished
            .zip(started)
            .map(|(f, s)| f - s)
            .unwrap_or(Duration::from_millis(WINDOW_MS)),
    }
}

/// BEFORE — one `PtyEvent::Output` per PTY read, which is exactly what
/// `pump_pty_output` did before Phase 3 ("every 4096-byte read used to
/// become its own event"). A raw `portable_pty` loop rather than the
/// shipping handle, because the pre-Phase-3 code is gone; the read size and
/// the PTY are identical, and the producer is the same process.
fn measure_per_read(corpus: &Path, script: &Path, rate: Rate) -> Framing {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    let pty = native_pty_system()
        .openpty(PtySize { rows: 40, cols: 200, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");
    let mut cmd = CommandBuilder::new("node");
    cmd.arg(script);
    cmd.arg(corpus);
    cmd.arg(rate.burst.to_string());
    cmd.arg(rate.period_ms.to_string());
    cmd.arg(WINDOW_MS.to_string());
    let mut child = pty.slave.spawn_command(cmd).expect("spawn node");
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().expect("reader");

    // READ_BUF_BYTES in pty/handle.rs. Unchanged by Phase 3.
    let mut buf = [0u8; 4096];
    let mut events = 0usize;
    let mut bytes = 0usize;
    let mut started: Option<Instant> = None;
    let mut finished: Option<Instant> = None;
    let mut carry: Vec<u8> = Vec::new();

    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let chunk = &buf[..n];
                let mut hay = std::mem::take(&mut carry);
                hay.extend_from_slice(chunk);
                if started.is_none() {
                    if let Some(i) = find(&hay, START) {
                        started = Some(Instant::now());
                        let tail = hay.len() - (i + START.len());
                        if tail > 0 {
                            events += 1;
                            bytes += tail;
                        }
                    }
                } else if let Some(i) = find(&hay, END) {
                    finished = Some(Instant::now());
                    bytes += i.saturating_sub(carry_len(END).min(i));
                    events += 1;
                    break;
                } else {
                    events += 1;
                    bytes += n;
                }
                let keep = carry_len(START.max(END)).min(hay.len());
                carry = hay[hay.len() - keep..].to_vec();
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    child.kill().ok();

    Framing {
        events,
        bytes,
        elapsed: finished
            .zip(started)
            .map(|(f, s)| f - s)
            .unwrap_or(Duration::from_millis(WINDOW_MS)),
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

#[test]
#[ignore = "benchmark, not a gate — PHASR_BENCH=1 … -- --ignored --nocapture"]
fn bench_phase3_coalescing() {
    if !enabled() {
        eprintln!("PERFBENCH skipped: set PHASR_BENCH=1");
        return;
    }
    let Some((corpus, size)) = corpus_logs(1_000_000).into_iter().next() else {
        eprintln!("PERFBENCH skipped: no PTY log corpus on this machine");
        return;
    };
    let tmp = tempfile::tempdir().expect("tempdir");
    let script = write_producer_script(tmp.path());
    eprintln!(
        "PERFBENCH corpus: {} ({:.1} MiB)",
        corpus.file_name().unwrap().to_string_lossy(),
        size as f64 / 1_048_576.0
    );
    eprintln!("PERFBENCH window={WINDOW_MS}ms reps={REPS}");

    for rate in RATES {
        let mut before_eps = Vec::new();
        let mut before_bpe = Vec::new();
        let mut after_eps = Vec::new();
        let mut after_bpe = Vec::new();
        let mut after_mbs = Vec::new();
        let mut before_mbs = Vec::new();
        for _ in 0..REPS {
            let b = measure_per_read(&corpus, &script, *rate);
            before_eps.push(b.events_per_sec());
            before_bpe.push(b.bytes_per_event());
            before_mbs.push(b.mb_per_sec());
            let a = measure_shipping(&corpus, &script, *rate);
            after_eps.push(a.events_per_sec());
            after_bpe.push(a.bytes_per_event());
            after_mbs.push(a.mb_per_sec());
        }
        let (blo, bhi) = spread(&before_eps);
        let (alo, ahi) = spread(&after_eps);
        eprintln!(
            "COALESCE {:<22} BEFORE ev/s {:>8.1} [{:.1}-{:.1}]  B/ev {:>8.0}  {:.2} MB/s   \
             AFTER ev/s {:>8.1} [{:.1}-{:.1}]  B/ev {:>8.0}  {:.2} MB/s   \
             reduction {:.1}x",
            rate.label,
            median(before_eps.clone()),
            blo,
            bhi,
            median(before_bpe.clone()),
            median(before_mbs.clone()),
            median(after_eps.clone()),
            alo,
            ahi,
            median(after_bpe.clone()),
            median(after_mbs.clone()),
            median(before_eps) / median(after_eps).max(0.001),
        );
    }
}

// ---------------------------------------------------------------------------
// Phase 4 — base64 vs the lossy String it replaced
// ---------------------------------------------------------------------------

/// The wire format Phase 4 removed: `String::from_utf8_lossy`, which
/// `serde_json` then has to escape. Reproduced here (rather than measured
/// from git history) so both encoders run in one process on one corpus.
#[derive(serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum LegacyPtyEvent {
    Output { task_id: String, chunk: String },
}

/// Post-coalescer chunk size — the size the serializer actually sees on the
/// shipping path, not the 4096-byte read size.
const WIRE_CHUNK: usize = 32 * 1024;

#[test]
#[ignore = "benchmark, not a gate — PHASR_BENCH=1 … -- --ignored --nocapture"]
fn bench_phase4_base64_wire_format() {
    if !enabled() {
        eprintln!("PERFBENCH skipped: set PHASR_BENCH=1");
        return;
    }
    let logs = corpus_logs(100_000);
    if logs.is_empty() {
        eprintln!("PERFBENCH skipped: no PTY log corpus on this machine");
        return;
    }

    let mut total_raw = 0usize;
    let mut total_b64 = 0usize;
    let mut total_legacy = 0usize;

    for (path, _) in &logs {
        let Ok(bytes) = std::fs::read(path) else { continue };
        let mut raw = 0usize;
        let mut b64 = 0usize;
        let mut legacy = 0usize;
        for chunk in bytes.chunks(WIRE_CHUNK) {
            raw += chunk.len();
            b64 += serde_json::to_string(&PtyEvent::Output {
                task_id: "t".into(),
                chunk: chunk.to_vec(),
            })
            .unwrap()
            .len();
            legacy += serde_json::to_string(&LegacyPtyEvent::Output {
                task_id: "t".into(),
                chunk: String::from_utf8_lossy(chunk).into_owned(),
            })
            .unwrap()
            .len();
        }
        total_raw += raw;
        total_b64 += b64;
        total_legacy += legacy;
        eprintln!(
            "WIRE {:<48} raw {:>9} B  base64-json {:.4}x  lossy-json {:.4}x  \
             base64 vs lossy {:+.2}%",
            path.file_name().unwrap().to_string_lossy(),
            raw,
            b64 as f64 / raw as f64,
            legacy as f64 / raw as f64,
            (b64 as f64 / legacy as f64 - 1.0) * 100.0,
        );
    }
    eprintln!(
        "WIRE TOTAL raw {:.2} MiB  base64-json {:.4}x  lossy-json {:.4}x  base64 vs lossy {:+.2}%",
        total_raw as f64 / 1_048_576.0,
        total_b64 as f64 / total_raw as f64,
        total_legacy as f64 / total_raw as f64,
        (total_b64 as f64 / total_legacy as f64 - 1.0) * 100.0,
    );

    // Encode COST, separately from payload size. Both encoders over the same
    // bytes, N reps, alternating so a thermal drift hits both equally.
    let (path, _) = &logs[0];
    let bytes = std::fs::read(path).expect("read corpus");
    let mb = bytes.len() as f64 / 1_048_576.0;
    let mut b64_ms = Vec::new();
    let mut legacy_ms = Vec::new();
    for _ in 0..REPS {
        let t = Instant::now();
        let mut sink = 0usize;
        for chunk in bytes.chunks(WIRE_CHUNK) {
            sink += serde_json::to_string(&PtyEvent::Output {
                task_id: "t".into(),
                chunk: chunk.to_vec(),
            })
            .unwrap()
            .len();
        }
        b64_ms.push(t.elapsed().as_secs_f64() * 1000.0 / mb);
        std::hint::black_box(sink);

        let t = Instant::now();
        let mut sink = 0usize;
        for chunk in bytes.chunks(WIRE_CHUNK) {
            sink += serde_json::to_string(&LegacyPtyEvent::Output {
                task_id: "t".into(),
                chunk: String::from_utf8_lossy(chunk).into_owned(),
            })
            .unwrap()
            .len();
        }
        legacy_ms.push(t.elapsed().as_secs_f64() * 1000.0 / mb);
        std::hint::black_box(sink);
    }
    let (blo, bhi) = spread(&b64_ms);
    let (llo, lhi) = spread(&legacy_ms);
    eprintln!(
        "WIRE ENCODE over {:.1} MiB: base64+json {:.2} ms/MiB [{:.2}-{:.2}]   \
         lossy+json {:.2} ms/MiB [{:.2}-{:.2}]",
        mb,
        median(b64_ms),
        blo,
        bhi,
        median(legacy_ms),
        llo,
        lhi,
    );
}

// ---------------------------------------------------------------------------
// Corpus shape — the input every other number is a function of
// ---------------------------------------------------------------------------

#[test]
#[ignore = "benchmark, not a gate — PHASR_BENCH=1 … -- --ignored --nocapture"]
fn bench_corpus_escape_density() {
    if !enabled() {
        eprintln!("PERFBENCH skipped: set PHASR_BENCH=1");
        return;
    }
    let logs = corpus_logs(1);
    if logs.is_empty() {
        eprintln!("PERFBENCH skipped: no PTY log corpus on this machine");
        return;
    }
    let mut grand_bytes = 0usize;
    let mut grand_esc = 0usize;
    for (path, _) in &logs {
        let Ok(bytes) = std::fs::read(path) else { continue };
        if bytes.is_empty() {
            continue;
        }
        let esc = bytes.iter().filter(|b| **b == 0x1b).count();
        let nonascii = bytes.iter().filter(|b| **b >= 0x80).count();
        grand_bytes += bytes.len();
        grand_esc += esc;
        eprintln!(
            "DENSITY {:<48} {:>9} B  ESC/KiB {:>7.1}  ESC {:.2}%  non-ascii {:.2}%",
            path.file_name().unwrap().to_string_lossy(),
            bytes.len(),
            esc as f64 * 1024.0 / bytes.len() as f64,
            esc as f64 * 100.0 / bytes.len() as f64,
            nonascii as f64 * 100.0 / bytes.len() as f64,
        );
    }
    eprintln!(
        "DENSITY TOTAL {:.2} MiB across {} logs, ESC/KiB {:.1}",
        grand_bytes as f64 / 1_048_576.0,
        logs.len(),
        grand_esc as f64 * 1024.0 / grand_bytes.max(1) as f64,
    );
}
