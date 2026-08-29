//! Rust↔JS end-to-end IPC bench — Perf Phase 0 criterion 3
//! (`specs/perf-p0-measurement-baseline-spec.md`).
//!
//! The mocked-IPC e2e harness synthesizes base64 on the JS side and can
//! never measure the real hop, so this harness runs **inside the real
//! shell**: launch `PHASR_IPC_BENCH=1 pnpm tauri dev` and the frontend
//! (`src/lib/perf/ipcBench.ts`, dev builds only) detects bench mode via
//! `ipc_bench_config`, drives the matrix through a real `tauri::ipc::Channel`
//! — the exact transport `PtyEvent` ships on — and reports back through
//! `ipc_bench_report`, which prints `IPCBENCH` lines and exits the app.
//!
//! What the matrix separates (verified against tauri 2.11.2
//! `src/ipc/channel.rs`):
//!
//! * **JSON < 8192 B** → delivered by `webview.eval` directly
//!   (`MAX_JSON_DIRECT_EXECUTE_THRESHOLD`). A 4 KiB PTY chunk base64s to
//!   ~5.5 KiB of JSON: the keystroke-echo path.
//! * **JSON ≥ 8192 B** → parked in the global
//!   `ChannelDataIpcQueue(Arc<Mutex<HashMap>>)` shared by every channel in
//!   the app — all PTYs included — then pulled by the webview via
//!   `plugin:__TAURI_CHANNEL__|fetch`. A 32 KiB coalescer chunk (~43.7 KiB
//!   JSON) always takes this path: the flood path.
//! * **Raw bytes** flip eval→fetch at 1024 B
//!   (`MAX_RAW_DIRECT_EXECUTE_THRESHOLD`) and skip base64+JSON entirely —
//!   what Phase 4 proposes.
//!
//! All timing happens on the JS clock (invoke-start → `onmessage`, and
//! first→last arrival for throughput), so no cross-clock arithmetic; the
//! Rust-side send-loop time is returned too, labeled as such.
//!
//! Nothing here is reachable in production: every command errors unless
//! `PHASR_IPC_BENCH` is set in the app's environment, and the frontend
//! runner is `import.meta.env.DEV`-gated on top.

use std::time::Instant;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::AppHandle;

use crate::pty::PtyEvent;

fn enabled() -> bool {
    std::env::var_os("PHASR_IPC_BENCH").is_some()
}

/// `PHASR_IPC_BENCH=hold` keeps the app alive after the report, for
/// poking at the HUD in the same session; anything else exits.
fn exit_when_done() -> bool {
    std::env::var("PHASR_IPC_BENCH").map(|v| v != "hold").unwrap_or(true)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcBenchConfig {
    exit_when_done: bool,
}

/// Escape-dense payload bytes, like agent TUI output (an SGR every 16
/// visible bytes). Content cannot change base64 size, but it keeps any
/// future non-base64 comparison honest.
fn corpus_bytes(n: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(n + 16);
    let mut i = 0usize;
    while out.len() < n {
        if i % 16 == 0 {
            out.extend_from_slice(b"\x1b[38;5;123m");
        }
        out.push(b'a' + (i % 26) as u8);
        i += 1;
    }
    out.truncate(n);
    out
}

/// The bytes the **pre-P4** path put on the wire for one chunk:
/// `PtyEvent::Output` through serde (base64 + JSON envelope).
///
/// Still built here, and only here: it is the BEFORE column. Since P4 the
/// shipping path is `InvokeResponseBody::Raw` of the chunk itself, which is
/// exactly what the `"raw"` format below sends — so one run of this bench
/// prints both sides of the change, on the same machine, through the same
/// real `Channel`.
fn json_body(chunk: &[u8]) -> Result<String, String> {
    serde_json::to_string(&PtyEvent::Output {
        task_id: "bench".into(),
        // Not serialized (backend-internal cursor), so it costs the wire
        // nothing — the envelope this measures is unchanged.
        log_offset: 0,
        chunk: bytes::Bytes::copy_from_slice(chunk),
    })
    .map_err(|e| e.to_string())
}

/// `None` unless the shell was launched in bench mode — the frontend's
/// cheap "should I run at all" probe, and the RTT no-op baseline.
#[tauri::command]
pub fn ipc_bench_config() -> Option<IpcBenchConfig> {
    enabled().then(|| IpcBenchConfig {
        exit_when_done: exit_when_done(),
    })
}

/// Send `count` chunks of `size` raw bytes through the channel in the
/// given wire format. Three of them:
///
/// * `"json"` — the pre-P4 wire: base64 inside a JSON `PtyEvent`.
/// * `"raw"` — bytes with no envelope, which P4 originally proposed for
///   everything.
/// * `"auto"` — **what actually ships**: `pty_stream::output_body`, which
///   keeps a chunk in the JSON envelope while that envelope still fits
///   tauri's `eval` threshold and goes raw above it. Measured through the
///   same function the forwarder calls, so the bench cannot drift from the
///   policy it is reporting on.
///
/// Returns the Rust-side send-loop wall time in ms — serialization plus
/// handing off to the webview transport; delivery is measured on the JS
/// side.
#[tauri::command]
pub fn ipc_bench_send(
    channel: Channel<InvokeResponseBody>,
    size: usize,
    count: usize,
    format: String,
) -> Result<f64, String> {
    if !enabled() {
        return Err("PHASR_IPC_BENCH is not set".into());
    }
    if size > 4 * 1024 * 1024 || count > 10_000 {
        return Err("bench bounds exceeded".into());
    }
    let bytes = corpus_bytes(size);
    let t0 = Instant::now();
    match format.as_str() {
        "json" => {
            for _ in 0..count {
                channel
                    .send(InvokeResponseBody::Json(json_body(&bytes)?))
                    .map_err(|e| e.to_string())?;
            }
        }
        "raw" => {
            for _ in 0..count {
                channel
                    .send(InvokeResponseBody::Raw(bytes.clone()))
                    .map_err(|e| e.to_string())?;
            }
        }
        "auto" => {
            for _ in 0..count {
                channel
                    .send(crate::commands::pty_stream::output_body(
                        "bench",
                        bytes::Bytes::copy_from_slice(&bytes),
                    ))
                    .map_err(|e| e.to_string())?;
            }
        }
        other => return Err(format!("unknown format `{other}`")),
    }
    Ok(t0.elapsed().as_secs_f64() * 1000.0)
}

/// The frontend's results land here so they end up on the terminal that
/// launched the shell (the webview console dies with the window).
#[tauri::command]
pub fn ipc_bench_report(app: AppHandle, lines: Vec<String>) -> Result<(), String> {
    if !enabled() {
        return Err("PHASR_IPC_BENCH is not set".into());
    }
    for line in &lines {
        eprintln!("IPCBENCH {line}");
    }
    eprintln!("IPCBENCH done");
    if exit_when_done() {
        std::thread::spawn(move || {
            // Let the invoke response reach the webview first.
            std::thread::sleep(std::time::Duration::from_millis(300));
            app.exit(0);
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The cargo-test half — what a process-local test can measure honestly
// ---------------------------------------------------------------------------

/// Rust-side component costs of the hop, gated exactly like `perfbench.rs`
/// (`PHASR_BENCH=1 cargo test --lib ipcbench -- --ignored --nocapture`).
/// A cargo test has no webview, so this measures serialization plus the
/// channel machinery up to the runtime boundary — the end-to-end numbers
/// come from the in-app run above. Numbers labeled accordingly in the
/// spec's Baseline table.
#[cfg(test)]
mod tests {
    use super::*;

    const REPS: usize = 200;

    fn median(mut xs: Vec<f64>) -> f64 {
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        if xs.is_empty() {
            return f64::NAN;
        }
        xs[xs.len() / 2]
    }

    #[test]
    #[ignore = "benchmark, not a gate — PHASR_BENCH=1 … -- --ignored --nocapture"]
    fn bench_ipc_rust_side_costs() {
        if std::env::var_os("PHASR_BENCH").is_none() {
            eprintln!("IPCBENCH skipped: set PHASR_BENCH=1");
            return;
        }
        for (label, size) in [("4KiB (eval path)", 4096usize), ("32KiB (fetch path)", 32768)] {
            let bytes = corpus_bytes(size);

            // Serialize-only: the base64+JSON envelope build.
            let mut ser_us = Vec::with_capacity(REPS);
            for _ in 0..REPS {
                let t = Instant::now();
                let body = json_body(&bytes).unwrap();
                ser_us.push(t.elapsed().as_secs_f64() * 1e6);
                std::hint::black_box(body);
            }

            // Serialize + channel send into a no-op sink: adds the channel
            // plumbing (`IpcResponse::body`, the boxed `on_message` call)
            // without a webview behind it.
            let sink: Channel<InvokeResponseBody> =
                Channel::new(|body| {
                    std::hint::black_box(&body);
                    Ok(())
                });
            let mut send_json_us = Vec::with_capacity(REPS);
            for _ in 0..REPS {
                let t = Instant::now();
                sink.send(InvokeResponseBody::Json(json_body(&bytes).unwrap()))
                    .unwrap();
                send_json_us.push(t.elapsed().as_secs_f64() * 1e6);
            }
            let mut send_raw_us = Vec::with_capacity(REPS);
            for _ in 0..REPS {
                let t = Instant::now();
                sink.send(InvokeResponseBody::Raw(bytes.clone())).unwrap();
                send_raw_us.push(t.elapsed().as_secs_f64() * 1e6);
            }

            eprintln!(
                "IPCBENCH rust-side {label}: serialize {:.1}us  send(json) {:.1}us  send(raw) {:.1}us  (median of {REPS}; no webview behind the sink)",
                median(ser_us),
                median(send_json_us),
                median(send_raw_us),
            );
        }
    }
}
