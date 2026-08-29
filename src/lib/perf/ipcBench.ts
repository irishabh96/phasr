/**
 * JS half of the Rust↔JS IPC end-to-end bench — Perf Phase 0 criterion 3
 * (`specs/perf-p0-measurement-baseline-spec.md`; Rust half in
 * `src-tauri/src/ipcbench.rs`).
 *
 * Runs only when the REAL shell was launched in bench mode:
 *
 *   PHASR_IPC_BENCH=1 pnpm tauri dev
 *
 * `main.tsx` dynamically imports this in DEV builds; the first invoke
 * returns `null` in a normal launch (or throws in a plain browser) and
 * nothing else happens. In bench mode it drives the matrix — base64+JSON
 * `PtyEvent` vs raw bytes vs the shipping policy, at eval-path and
 * fetch-path sizes — through a real `Channel`, measuring on the ONE clock
 * that can see both ends of the hop:
 *
 *   - **one-shot**: invoke-start → the channel message's `onmessage`,
 *     minus the measured no-payload invoke RTT = net delivery cost of one
 *     chunk (reported both raw and net);
 *   - **stream**: 200 chunks sent back-to-back from Rust; first→last
 *     arrival span gives per-chunk pipeline cost and MB/s — the number
 *     that bounds flood.
 *
 * Each size is measured three ways: `json` (the pre-P4 wire), `raw` (bytes
 * with no envelope) and `auto` (**what ships** — `pty_stream::output_body`,
 * which picks between them by size). Run it on a RELEASE build: on a debug
 * build serde is roughly 30x slower than it ships, which flatters `raw`
 * enough to invert the conclusion.
 *
 * Results go back through `ipc_bench_report`, which prints `IPCBENCH`
 * lines on the launching terminal and exits the shell (unless
 * PHASR_IPC_BENCH=hold).
 */

import { Channel, invoke } from "@tauri-apps/api/core";

interface BenchCase {
  label: string;
  format: "json" | "raw" | "auto";
  /** Raw chunk bytes. JSON envelope ≈ 40 + ceil(size/3)*4. */
  size: number;
}

/**
 * Grouped by chunk size, so each size has a BEFORE (json), the pure-raw
 * alternative, and what ships — the comparison phase 4's criterion 2 asks
 * for, and the one an average would hide.
 *
 * Thresholds verified in tauri 2.11.2 `src/ipc/channel.rs`: JSON flips
 * eval→fetch at 8192 B of serialized JSON, raw at 1024 B of payload.
 *
 * The 4 KiB pair is the awkward one and is here on purpose: base64+JSON of
 * 4 KiB is ~5.5 KB and still takes `eval`, while 4 KiB of raw bytes is over
 * the 1024 B raw threshold and takes `fetch`. That is the only cell where
 * the raw move *changes transport path*, so it is the only cell where it
 * could plausibly lose.
 *
 * 512 B matters more since the leading-edge flush: a keystroke echo is now
 * its own small chunk rather than something coalesced into the next repaint.
 */
const CASES: BenchCase[] = [
  { label: "json   512B chunk (~723B JSON → eval)", format: "json", size: 512 },
  { label: "raw    512B chunk (raw → eval)", format: "raw", size: 512 },
  { label: "auto   512B chunk (SHIPPING)", format: "auto", size: 512 },
  { label: "json  4KiB chunk (~5.5KB JSON → eval)", format: "json", size: 4096 },
  { label: "raw   4KiB chunk (raw → fetch)", format: "raw", size: 4096 },
  { label: "auto  4KiB chunk (SHIPPING)", format: "auto", size: 4096 },
  { label: "json 32KiB chunk (~43.7KB JSON → fetch)", format: "json", size: 32768 },
  { label: "raw  32KiB chunk (raw → fetch)", format: "raw", size: 32768 },
  { label: "auto 32KiB chunk (SHIPPING)", format: "auto", size: 32768 },
];

const ONESHOT_REPS = 30;
const STREAM_COUNT = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function p50(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function oneShot(c: BenchCase): Promise<number> {
  const channel = new Channel<unknown>();
  let arrived: () => void;
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  channel.onmessage = () => arrived();
  const t0 = performance.now();
  await invoke("ipc_bench_send", {
    channel,
    size: c.size,
    count: 1,
    format: c.format,
  });
  await arrival;
  return performance.now() - t0;
}

async function stream(
  c: BenchCase,
): Promise<{ spanMs: number; totalMs: number; rustMs: number }> {
  const channel = new Channel<unknown>();
  let first = 0;
  let seen = 0;
  let done: (spanMs: number) => void;
  const span = new Promise<number>((resolve) => {
    done = resolve;
  });
  channel.onmessage = () => {
    seen += 1;
    if (seen === 1) first = performance.now();
    if (seen === STREAM_COUNT) done(performance.now() - first);
  };
  const t0 = performance.now();
  const rustMs = await invoke<number>("ipc_bench_send", {
    channel,
    size: c.size,
    count: STREAM_COUNT,
    format: c.format,
  });
  const spanMs = await span;
  return { spanMs, totalMs: performance.now() - t0, rustMs };
}

export async function runIpcBenchIfRequested(): Promise<void> {
  let config: unknown;
  try {
    config = await invoke("ipc_bench_config");
  } catch {
    return; // not a Tauri shell (Playwright / plain browser)
  }
  if (!config) return; // real shell, not in bench mode

  // Let boot settle so the numbers are the transport's, not startup's.
  await sleep(2000);
  const lines: string[] = [];
  try {
    // No-payload invoke RTT — the baseline subtracted from one-shots.
    const noop: number[] = [];
    for (let i = 0; i < ONESHOT_REPS; i++) {
      const t0 = performance.now();
      await invoke("ipc_bench_config");
      noop.push(performance.now() - t0);
    }
    const noopP50 = p50(noop);
    lines.push(
      `invoke-noop RTT p50 ${noopP50.toFixed(2)}ms min ${Math.min(...noop).toFixed(2)}ms (n=${ONESHOT_REPS})`,
    );

    for (const c of CASES) {
      const rtts: number[] = [];
      for (let i = 0; i < ONESHOT_REPS; i++) rtts.push(await oneShot(c));
      const oneP50 = p50(rtts);
      const s = await stream(c);
      const perChunk = s.spanMs / (STREAM_COUNT - 1);
      const mbPerSec =
        (c.size * STREAM_COUNT) / 1_048_576 / (s.totalMs / 1000);
      lines.push(
        `${c.label}: one-shot p50 ${oneP50.toFixed(2)}ms (net ~${(oneP50 - noopP50).toFixed(2)}ms) ` +
          `min ${Math.min(...rtts).toFixed(2)}ms | stream x${STREAM_COUNT}: ` +
          `${perChunk.toFixed(3)}ms/chunk, ${mbPerSec.toFixed(1)}MB/s payload ` +
          `(total ${s.totalMs.toFixed(0)}ms, rust send-loop ${s.rustMs.toFixed(0)}ms)`,
      );
    }
  } catch (err) {
    lines.push(`FAILED: ${String(err)}`);
  }
  await invoke("ipc_bench_report", { lines });
}
