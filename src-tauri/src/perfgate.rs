//! CI perf gate — Tier 2 of the P5 Q4 decision
//! (`specs/perf-p5-polish-parity-spec.md`, criterion 3).
//!
//! The one unavoidable *timing* gate, made runner-independent the only way
//! a shared runner allows: as a RATIO against an in-job calibration
//! workload, with an order-of-magnitude band. Absolute throughput numbers
//! from a GitHub runner mean nothing (the machine is shared and unknown);
//! the ratio of two measurements taken seconds apart on the same machine
//! cancels its speed.
//!
//! * **Calibration**: `cat` of a generated payload through a bare
//!   `portable_pty` read loop — the raw PTY ceiling of this machine, right
//!   now. No phasr code in the path.
//! * **Measurement**: the same payload through the SHIPPING pipeline —
//!   `TaskRuntime` → reader thread → coalescer → broadcast + log — i.e.
//!   what a phasr terminal actually pays per byte.
//!
//! The band: THIS instrument measures the shipping path at **0.17–0.18**
//! of raw on M1P — and debug and release agree to two decimals, because
//! the path is I/O-bound (PTY reads, the log write), not compute-bound.
//! (Do not "reconcile" this with P4's 0.68: that ratio came from
//! `perfbench.rs`, whose raw leg is producer-limited by a node script —
//! different instrument, different denominator.) The gate asserts
//! **≥ 0.02** — one order of magnitude under this instrument's measured
//! value, so a slow runner, a cold cache, or a noisy neighbour pass
//! untouched, while a step-change regression (a copy-per-subscriber
//! returning, the coalescer degrading to per-read events, a sync-flush
//! per chunk) is exactly the order-of-magnitude move that trips it.
//! Profile-insensitive, so CI runs it on the debug test build it already
//! has.
//!
//! Gated on `PHASR_GATE=1` and `#[ignore]`, like the rest of the harness —
//! a plain `cargo test` never pays for it; CI invokes it by name:
//!
//! ```text
//! PHASR_GATE=1 cargo test --manifest-path src-tauri/Cargo.toml --lib \
//!     perfgate -- --ignored --nocapture --test-threads=1
//! ```
#![cfg(test)]

use std::io::Read as _;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::pty::{PtyEvent, TaskRuntime};

/// Enough that throughput dominates spawn/flush edges (raw drains this in
/// well under a second on a laptop, a few seconds on a slow runner), small
/// enough not to tax a shared runner's disk.
const PAYLOAD_BYTES: usize = 32 * 1024 * 1024;

/// The band. Measured by this test on M1P, 2026-08-29: 0.166 (debug) /
/// 0.177 (release) — raw ≈ 233 MB/s, shipping ≈ 40 MB/s. One order of
/// magnitude under the measured value — see the module comment for what a
/// trip means, and for why P4's 0.68 is a different instrument's number.
const MIN_RATIO: f64 = 0.02;

/// 64 printable bytes per line, no `\n`/`\t`, so ONLCR and tab expansion
/// cannot rewrite the stream — the same trick `loadtest.rs` uses.
fn write_payload(dir: &Path) -> PathBuf {
    let path = dir.join("gate-payload.bin");
    let mut file = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
    let line: Vec<u8> = (0..64u8).map(|i| b'!' + (i % 90)).collect();
    for _ in 0..(PAYLOAD_BYTES / line.len()) {
        file.write_all(&line).unwrap();
    }
    file.flush().unwrap();
    path
}

/// Raw ceiling: `cat` straight into a PTY, drained with the same 4096-byte
/// reads the shipping reader uses (`READ_BUF_BYTES`, pty/handle.rs).
/// Clock runs from the first byte to EOF.
fn measure_raw(payload: &Path) -> (u64, Duration) {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    let pty = native_pty_system()
        .openpty(PtySize { rows: 40, cols: 200, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");
    let mut cmd = CommandBuilder::new("cat");
    cmd.arg(payload);
    let mut child = pty.slave.spawn_command(cmd).expect("spawn cat");
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().expect("reader");

    let mut buf = [0u8; 4096];
    let mut bytes = 0u64;
    let mut started: Option<Instant> = None;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                started.get_or_insert_with(Instant::now);
                bytes += n as u64;
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            // macOS reports EIO when the child side closes; either way the
            // stream is over.
            Err(_) => break,
        }
    }
    child.kill().ok();
    let elapsed = started.map(|s| s.elapsed()).unwrap_or_default();
    (bytes, elapsed)
}

/// The shipping pipeline: reader thread → coalescer → broadcast + log.
/// Bytes are counted off the LOG's flushed offset (the pipeline's own
/// ground truth, immune to broadcast lag); the clock runs from the first
/// output event to the exit event.
fn measure_shipping(payload: &Path, dir: &Path) -> (u64, Duration) {
    let runtime = TaskRuntime::new(dir.join("gate-logs"));
    let handle = runtime
        .spawn(
            "perfgate".into(),
            // `exec` replaces the shell, so EOF of `cat` closes the PTY.
            Some(format!("exec cat '{}'", payload.display())),
            None,
            dir.to_path_buf(),
            40,
            200,
        )
        .expect("spawn shipping pty");

    let (replay, mut rx) = handle.subscribe_with_replay();
    let log_index = handle.log_index();
    let mut started: Option<(Instant, u64)> = None;
    let note_output = |started: &mut Option<(Instant, u64)>| {
        if started.is_none() {
            *started = Some((Instant::now(), log_index.flushed_through()));
        }
    };
    for event in replay {
        if matches!(event, PtyEvent::Output { .. }) {
            note_output(&mut started);
        }
    }

    let deadline = Instant::now() + Duration::from_secs(300);
    let finished: Instant;
    loop {
        assert!(Instant::now() < deadline, "shipping measurement never finished");
        match rx.try_recv() {
            Ok(PtyEvent::Output { .. }) => note_output(&mut started),
            Ok(PtyEvent::Exit { .. }) => {
                finished = Instant::now();
                break;
            }
            Ok(PtyEvent::Desync { .. }) => {}
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                std::thread::sleep(Duration::from_millis(2));
            }
            // Lag cannot lose the measurement: bytes come off the log.
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
            Err(_) => {
                finished = Instant::now();
                break;
            }
        }
    }
    let _ = handle.kill();

    // The log's flushed offset trails the Exit event by up to a chunk (the
    // writer thread races the exit notification) — poll it to stability so
    // the byte count is the whole stream, not the stream minus its tail.
    let mut through = log_index.flushed_through();
    let settle_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        std::thread::sleep(Duration::from_millis(20));
        let now_through = log_index.flushed_through();
        if now_through == through || Instant::now() > settle_deadline {
            through = now_through;
            break;
        }
        through = now_through;
    }

    let (t0, bytes0) = started.expect("no output ever arrived");
    (through - bytes0, finished - t0)
}

#[test]
#[ignore = "CI gate — PHASR_GATE=1 … -- --ignored --nocapture --test-threads=1"]
fn shipping_throughput_stays_within_an_order_of_magnitude_of_raw() {
    if std::env::var("PHASR_GATE").ok().as_deref() != Some("1") {
        eprintln!("skipped: set PHASR_GATE=1");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let payload = write_payload(dir.path());

    let (raw_bytes, raw_elapsed) = measure_raw(&payload);
    let (ship_bytes, ship_elapsed) = measure_shipping(&payload, dir.path());

    let mbs = |b: u64, d: Duration| (b as f64 / 1_048_576.0) / d.as_secs_f64().max(1e-9);
    let raw = mbs(raw_bytes, raw_elapsed);
    let ship = mbs(ship_bytes, ship_elapsed);
    let ratio = ship / raw;
    println!("\n=== phasr perf gate (tier 2, ratio) ===");
    println!("raw       {raw_bytes} B in {raw_elapsed:?}  = {raw:.1} MB/s (in-job calibration)");
    println!("shipping  {ship_bytes} B in {ship_elapsed:?}  = {ship:.1} MB/s");
    println!("ratio     {ratio:.3}  (this instrument measured 0.17 on M1P; gate ≥ {MIN_RATIO})");

    // Both legs must have actually measured a flood, or the ratio is noise.
    assert!(
        raw_bytes as usize >= PAYLOAD_BYTES,
        "calibration saw {raw_bytes} B of a {PAYLOAD_BYTES} B payload"
    );
    assert!(
        ship_bytes as usize >= PAYLOAD_BYTES,
        "shipping path saw {ship_bytes} B of a {PAYLOAD_BYTES} B payload"
    );
    assert!(
        ratio >= MIN_RATIO,
        "shipping path retains only {ratio:.3} of raw PTY throughput \
         (raw {raw:.1} MB/s, shipping {ship:.1} MB/s) — an order-of-magnitude \
         regression against this instrument's measured 0.17"
    );
    // A ratio far above 1 means the instrument broke (e.g. the calibration
    // leg stopped reading), not that the pipe got free.
    assert!(ratio <= 3.0, "ratio {ratio:.3} is not a measurement");
}
