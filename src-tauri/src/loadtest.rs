//! Multi-agent load test: real `claude` processes through phasr's real PTY
//! path, ramped until something actually breaks.
//!
//! Not a gate and never runs in CI: `#[cfg(test)]`, `#[ignore]`d, AND
//! gated on `PHASR_LOAD=1`. It spawns real agent CLIs, which costs the
//! operator's quota and real minutes.
//!
//! ```text
//! PHASR_LOAD=1 cargo test --manifest-path src-tauri/Cargo.toml --lib \
//!     loadtest -- --ignored --nocapture --test-threads=1
//! ```
//!
//! What it measures, per rung of the ramp:
//!   * whether every agent's prompt was actually SUBMITTED (the
//!     TUI-marker + echo-verified-Enter protocol, under concurrency —
//!     single-agent success proves nothing about 16 booting at once)
//!   * time to readiness and time to submit, per agent
//!   * PTY throughput after coalescing, and **unrecovered output**. The
//!     2048-slot broadcast still drops the oldest value for a lagging
//!     receiver — that cannot be prevented, a broadcast send never blocks —
//!     but since Phase 3 every dropped range is refilled from the per-task
//!     log (`pty/backfill.rs`). So lag is *counted*, and what is asserted at
//!     zero is **unrecovered bytes**: the harness reconstructs each
//!     subscriber's stream (live events + backfill) and requires it to be
//!     byte-identical to the log.
//!   * process RSS and thread count for the whole tree.
//!
//! `bulk_flood_never_drops_a_byte` is the flood half of the same claim and
//! needs no agent CLI at all (so it costs no quota): it floods a real PTY
//! unthrottled, deliberately stalls the subscriber past the broadcast ring,
//! and asserts the same byte-identity.
#![cfg(test)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::pty::log::LogIndex;
use crate::pty::PtyEvent;
use crate::pty::TaskRuntime;

/// FNV-1a over a stream, so byte-identity can be asserted over hundreds of
/// megabytes without holding any of it. Two streams with the same length and
/// the same hash are the evidence; a mismatch prints both lengths.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct StreamDigest {
    hash: u64,
    len: u64,
}

impl StreamDigest {
    fn new() -> Self {
        Self { hash: 0xcbf2_9ce4_8422_2325, len: 0 }
    }
    fn feed(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.hash ^= *b as u64;
            self.hash = self.hash.wrapping_mul(0x1000_0000_01b3);
        }
        self.len += bytes.len() as u64;
    }
}

/// The same digest, taken over the log itself — the thing the delivered
/// stream has to match. Read in `read_range`-sized bites so a 90 MiB log
/// never lands in memory at once.
fn digest_log_range(index: &LogIndex, from: u64, to: u64) -> StreamDigest {
    let mut digest = StreamDigest::new();
    let mut cursor = from;
    while cursor < to {
        let bytes = index.read_range(cursor, to);
        if bytes.is_empty() {
            break;
        }
        digest.feed(&bytes);
        cursor += bytes.len() as u64;
    }
    digest
}

const AGENT_CMD: &str = "claude --dangerously-skip-permissions";
/// Small, safe, and real: each is a genuine turn, none of them touch
/// anything outside the agent's own throwaway worktree.
const TASKS: &[&str] = &[
    "reply with exactly the word READY and nothing else",
    "create a file named loadtest.txt containing the single word ok",
    "how many files are in this directory? answer with just the number",
];
const READY_DEADLINE: Duration = Duration::from_secs(120);
const TASK_DEADLINE: Duration = Duration::from_secs(120);

struct AgentResult {
    id: String,
    ready_ms: Option<u128>,
    submitted_ms: Option<u128>,
    tasks_completed: usize,
    bytes: u64,
    events: u64,
    lagged: u64,
    /// Bytes the broadcast dropped that the log could not give back. The
    /// number this whole phase exists to keep at zero.
    unrecovered: u64,
    /// Bytes the broadcast dropped that WERE given back.
    recovered: u64,
    /// Did the reconstructed stream match the log byte for byte?
    identical: bool,
}

/// Per-step totals across every agent: (bytes, events, lagged events,
/// unrecovered bytes, subscribers whose stream did not match the log).
type Counters = (AtomicU64, AtomicU64, AtomicU64, AtomicU64, AtomicU64);

/// RSS (MB) and thread count for this process tree, via ps.
fn proc_stats() -> (u64, u64) {
    let out = std::process::Command::new("sh")
        .arg("-c")
        .arg("ps -Ao rss,comm | grep -E 'claude|node' | awk '{s+=$1} END {print s+0}'; \
              ps -M -p $(pgrep -d, -f 'claude' 2>/dev/null || echo $$) 2>/dev/null | wc -l")
        .output();
    match out {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout);
            let mut it = s.lines();
            let rss_kb: u64 = it.next().unwrap_or("0").trim().parse().unwrap_or(0);
            let threads: u64 = it.next().unwrap_or("0").trim().parse().unwrap_or(0);
            (rss_kb / 1024, threads)
        }
        Err(_) => (0, 0),
    }
}

fn load_avg() -> String {
    std::process::Command::new("sh")
        .arg("-c")
        .arg("uptime | sed 's/.*load averages*: //'")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// One agent: boot, wait for submit, then drive the remaining tasks.
fn drive_agent(
    runtime: &TaskRuntime,
    idx: usize,
    dir: std::path::PathBuf,
    counters: Arc<Counters>,
) -> AgentResult {
    let id = format!("load-{idx}");
    let started = Instant::now();
    let handle = match runtime.spawn(
        id.clone(),
        Some(AGENT_CMD.into()),
        Some(TASKS[0].into()),
        dir,
        40,
        120,
    ) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("  [{id}] SPAWN FAILED: {e}");
            return AgentResult {
                id,
                ready_ms: None,
                submitted_ms: None,
                tasks_completed: 0,
                bytes: 0,
                events: 0,
                lagged: 0,
                unrecovered: 0,
                recovered: 0,
                identical: true,
            };
        }
    };

    // Attach with replay so the stream starts at the first byte the PTY
    // produced, and with a recovery cursor so anything the broadcast drops
    // is refilled from the log before this subscriber ever sees a hole —
    // exactly what the three production forwarders do.
    let (replay, mut rx) = handle.subscribe_with_replay();
    let mut recovery = handle.recovery();
    let log_index = handle.log_index();
    let mut delivered = StreamDigest::new();
    let mut first_offset: Option<u64> = None;
    let mut seen = String::new();

    let absorb = |event: &PtyEvent, digest: &mut StreamDigest, first: &mut Option<u64>| {
        if let PtyEvent::Output { chunk, log_offset, .. } = event {
            first.get_or_insert(*log_offset);
            digest.feed(chunk);
        }
    };
    for event in replay {
        recovery.recover_before(&event, |missed| {
            absorb(&missed, &mut delivered, &mut first_offset);
            if let PtyEvent::Output { chunk, .. } = &missed {
                seen.push_str(&String::from_utf8_lossy(chunk));
            }
        });
        absorb(&event, &mut delivered, &mut first_offset);
        if let PtyEvent::Output { chunk, .. } = &event {
            seen.push_str(&String::from_utf8_lossy(chunk));
        }
    }
    let mut ready_ms = None;
    let mut submitted_ms = None;
    let mut trust_done = false;
    let (mut bytes, mut events, mut lagged) = (0u64, 0u64, 0u64);
    let mut task_idx = 0usize;
    let mut completed = 0usize;
    let mut deadline = Instant::now() + READY_DEADLINE;

    loop {
        if ready_ms.is_none() && (seen.contains('\u{1b}') && seen.len() > 200) {
            ready_ms = Some(started.elapsed().as_millis());
        }
        if submitted_ms.is_none() && seen.contains("esc to interrupt") {
            submitted_ms = Some(started.elapsed().as_millis());
            completed = 1;
            task_idx = 1;
            seen.clear();
            deadline = Instant::now() + TASK_DEADLINE;
        } else if submitted_ms.is_some() && task_idx < TASKS.len() {
            // A turn is done when the processing indicator goes away and
            // the composer is idle again.
            if !seen.contains("esc to interrupt") && seen.len() > 400 {
                let _ = handle.write(TASKS[task_idx].as_bytes());
                std::thread::sleep(Duration::from_millis(400));
                let _ = handle.write(b"\r");
                task_idx += 1;
                completed += 1;
                seen.clear();
                deadline = Instant::now() + TASK_DEADLINE;
            }
        }
        if !trust_done && seen.contains("safety") {
            trust_done = true;
            let _ = handle.write(b"\r");
        }
        if task_idx >= TASKS.len() && submitted_ms.is_some() {
            break;
        }
        if Instant::now() > deadline {
            break;
        }
        match rx.try_recv() {
            Ok(event) => {
                // Refill first, in order, so `seen` and the digest carry the
                // same bytes the terminal would have painted.
                recovery.recover_before(&event, |missed| {
                    absorb(&missed, &mut delivered, &mut first_offset);
                    if let PtyEvent::Output { chunk, .. } = &missed {
                        events += 1;
                        bytes += chunk.len() as u64;
                        seen.push_str(&String::from_utf8_lossy(chunk));
                    }
                });
                absorb(&event, &mut delivered, &mut first_offset);
                match event {
                    PtyEvent::Output { chunk, .. } => {
                        events += 1;
                        bytes += chunk.len() as u64;
                        seen.push_str(&String::from_utf8_lossy(&chunk));
                        if seen.len() > 200_000 {
                            seen.drain(..100_000);
                        }
                    }
                    PtyEvent::Desync { missed_bytes, .. } => {
                        eprintln!("  [{id}] DESYNC: {missed_bytes} bytes unrecoverable");
                    }
                    PtyEvent::Exit { .. } => break,
                }
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(n)) => {
                lagged += n;
                recovery.note_lag(n);
            }
            Err(_) => break,
        }
    }
    // Whatever the log holds past the last event this subscriber saw. The
    // exit watcher and the output pipeline are separate threads, so the
    // final bytes routinely arrive after the loop has already stopped.
    recovery.recover_tail(|missed| {
        absorb(&missed, &mut delivered, &mut first_offset);
        if let PtyEvent::Output { chunk, .. } = &missed {
            events += 1;
            bytes += chunk.len() as u64;
        }
    });
    let _ = handle.kill();

    // The claim: what a subscriber reconstructed is the log, byte for byte.
    let stats = recovery.stats();
    let from = first_offset.unwrap_or(0);
    let to = recovery.delivered_through().unwrap_or(from);
    let on_disk = digest_log_range(&log_index, from, to);
    let identical = on_disk == delivered;
    if !identical {
        eprintln!(
            "  [{id}] STREAM MISMATCH: delivered {} B (hash {:x}) vs log[{from}..{to}] {} B (hash {:x})",
            delivered.len, delivered.hash, on_disk.len, on_disk.hash
        );
    }

    counters.0.fetch_add(bytes, Ordering::Relaxed);
    counters.1.fetch_add(events, Ordering::Relaxed);
    counters.2.fetch_add(lagged, Ordering::Relaxed);
    counters.3.fetch_add(stats.unrecovered_bytes, Ordering::Relaxed);
    counters.4.fetch_add(u64::from(!identical), Ordering::Relaxed);
    AgentResult {
        id,
        ready_ms,
        submitted_ms,
        tasks_completed: completed,
        bytes,
        events,
        lagged,
        unrecovered: stats.unrecovered_bytes,
        recovered: stats.recovered_bytes,
        identical,
    }
}

#[test]
#[ignore]
fn load_ramp_real_agents() {
    if std::env::var("PHASR_LOAD").ok().as_deref() != Some("1") {
        eprintln!("skipped: set PHASR_LOAD=1 (spawns real agent CLIs; costs quota)");
        return;
    }
    // A nested Claude session changes the CLI's behaviour; production
    // phasr never has these set.
    for (k, _) in std::env::vars() {
        if k.starts_with("CLAUDE") {
            std::env::remove_var(&k);
        }
    }

    let steps: Vec<usize> = std::env::var("PHASR_LOAD_STEPS")
        .unwrap_or_else(|_| "1,2,4,8,16".into())
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();

    println!("\n=== phasr multi-agent load test ===");
    println!("cmd: {AGENT_CMD}");
    println!("tasks/agent: {}", TASKS.len());
    println!("machine load at start: {}", load_avg());
    println!();
    println!("{:>3} {:>7} {:>9} {:>9} {:>8} {:>9} {:>8} {:>7} {:>9} {:>7} {:>6} {:>5}",
        "N", "wall_s", "ready_p50", "subm_p50", "tasks", "bytes", "events", "lagged",
        "refilled", "lostB", "rssMB", "thr");

    for &n in &steps {
        let dir = tempfile::tempdir().unwrap();
        let log_dir = dir.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        let runtime = TaskRuntime::new(log_dir);
        let counters: Arc<Counters> = Arc::new((
            AtomicU64::new(0),
            AtomicU64::new(0),
            AtomicU64::new(0),
            AtomicU64::new(0),
            AtomicU64::new(0),
        ));

        let t0 = Instant::now();
        let mut workdirs = Vec::new();
        for i in 0..n {
            let wd = dir.path().join(format!("agent-{i}"));
            std::fs::create_dir_all(&wd).unwrap();
            workdirs.push(wd);
        }
        let results: Vec<AgentResult> = std::thread::scope(|s| {
            let hs: Vec<_> = workdirs
                .into_iter()
                .enumerate()
                .map(|(i, wd)| {
                    let rt = &runtime;
                    let c = counters.clone();
                    s.spawn(move || drive_agent(rt, i, wd, c))
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let wall = t0.elapsed().as_secs_f64();
        let (rss, threads) = proc_stats();

        let pct = |mut v: Vec<u128>| -> String {
            if v.is_empty() { return "-".into(); }
            v.sort_unstable();
            format!("{}", v[v.len() / 2])
        };
        let ready = pct(results.iter().filter_map(|r| r.ready_ms).collect());
        let subm = pct(results.iter().filter_map(|r| r.submitted_ms).collect());
        let submitted_n = results.iter().filter(|r| r.submitted_ms.is_some()).count();
        let tasks: usize = results.iter().map(|r| r.tasks_completed).sum();
        let bytes = counters.0.load(Ordering::Relaxed);
        let events = counters.1.load(Ordering::Relaxed);
        let lagged = counters.2.load(Ordering::Relaxed);
        let unrecovered = counters.3.load(Ordering::Relaxed);
        let mismatched = counters.4.load(Ordering::Relaxed);
        let recovered: u64 = results.iter().map(|r| r.recovered).sum();

        println!("{n:>3} {wall:>7.1} {ready:>9} {subm:>9} {:>8} {bytes:>9} {events:>8} {lagged:>7} {recovered:>9} {unrecovered:>7} {rss:>6} {threads:>5}",
            format!("{tasks}/{}", n * TASKS.len()));

        for r in &results {
            if r.submitted_ms.is_none() {
                println!("     ! {} NEVER SUBMITTED (bytes={} events={} lag={})",
                    r.id, r.bytes, r.events, r.lagged);
            }
            if r.unrecovered > 0 || !r.identical {
                println!("     ! {} STREAM NOT INTACT (unrecovered={} identical={})",
                    r.id, r.unrecovered, r.identical);
            }
        }
        if lagged > 0 {
            println!("     i {lagged} events lagged at N={n}; {recovered} B refilled from the log");
        }
        // Criterion 3. Lag is allowed — a broadcast send never blocks, so it
        // cannot be prevented — but every lagged byte must come back, and
        // the stream a subscriber reconstructs must BE the log.
        assert_eq!(
            unrecovered, 0,
            "N={n}: {unrecovered} bytes were dropped and could not be recovered"
        );
        assert_eq!(
            mismatched, 0,
            "N={n}: {mismatched} subscriber stream(s) diverged from the on-disk log"
        );
        if submitted_n < n {
            println!("\nBROKE AT N={n}: {submitted_n}/{n} agents submitted their prompt.");
            println!("load now: {}", load_avg());
            break;
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    println!("\nload at end: {}", load_avg());
}

/// The unthrottled `bulk` step: flood a real PTY as fast as the kernel will
/// take it and prove not one byte is lost.
///
/// The agent ramp above measures phasr's normal workload; it does not
/// reliably produce a lagging subscriber, because agents are slow. This does,
/// deterministically, and it is where criterion 3 is actually earned:
///
/// * The broadcast ring holds 2048 events ≈ 64 MiB. The subscriber is held
///   still until the producer is **past** that, so `Lagged` is guaranteed —
///   this is the exact condition that used to silently corrupt a terminal.
/// * The flood is 80 MiB, comfortably inside the log's 96 MiB retained
///   window, so every dropped byte is refillable. It also crosses two
///   32 MiB rotation boundaries, so the segment walk is exercised too.
/// * The payload carries no `\n` or `\t`, so the PTY's output post-processing
///   (ONLCR, tab expansion) cannot rewrite it — the log is what `cat` wrote.
///
/// Needs no agent CLI and costs no quota; gated with the rest of the harness.
#[test]
#[ignore]
fn bulk_flood_never_drops_a_byte() {
    if std::env::var("PHASR_LOAD").ok().as_deref() != Some("1") {
        eprintln!("skipped: set PHASR_LOAD=1");
        return;
    }
    const FLOOD_BYTES: usize = 80 * 1024 * 1024;
    /// Stall until the producer is this far past the broadcast's 64 MiB
    /// ring. Measured, not slept: a fixed sleep is a bet on machine speed.
    const STALL_UNTIL: u64 = 68 * 1024 * 1024;

    let dir = tempfile::tempdir().unwrap();
    let payload_path = dir.path().join("flood.bin");
    {
        use std::io::Write as _;
        let mut file = std::io::BufWriter::new(std::fs::File::create(&payload_path).unwrap());
        // 64 printable bytes, no newline, no tab.
        let line: Vec<u8> = (0..64u8).map(|i| b'!' + (i % 90)).collect();
        for _ in 0..(FLOOD_BYTES / line.len()) {
            file.write_all(&line).unwrap();
        }
        file.flush().unwrap();
    }

    let runtime = TaskRuntime::new(dir.path().join("logs"));
    let handle = runtime
        .spawn(
            "bulk".into(),
            // `exec` so the shell is replaced and the PTY closes at EOF.
            Some(format!("exec cat '{}'", payload_path.display())),
            None,
            dir.path().to_path_buf(),
            40,
            200,
        )
        .unwrap();

    let (replay, mut rx) = handle.subscribe_with_replay();
    let mut recovery = handle.recovery();
    let log_index = handle.log_index();
    let mut delivered = StreamDigest::new();
    let mut first_offset: Option<u64> = None;
    let absorb = |event: &PtyEvent, digest: &mut StreamDigest, first: &mut Option<u64>| {
        if let PtyEvent::Output { chunk, log_offset, .. } = event {
            first.get_or_insert(*log_offset);
            digest.feed(chunk);
        }
    };
    for event in replay {
        absorb(&event, &mut delivered, &mut first_offset);
    }

    // Hold still while the flood runs past the ring. The coalescer keeps
    // draining (a broadcast send never blocks), so the gap this opens is
    // real and is exactly what a wedged webview would produce.
    let t0 = Instant::now();
    let stall_from = log_index.flushed_through();
    while log_index.flushed_through() < stall_from + STALL_UNTIL {
        assert!(
            t0.elapsed() < Duration::from_secs(120),
            "producer never reached {STALL_UNTIL} B; got {}",
            log_index.flushed_through() - stall_from
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let stalled_ms = t0.elapsed().as_millis();

    let mut events = 0u64;
    let mut lagged = 0u64;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if Instant::now() > deadline {
            panic!("flood never finished");
        }
        match rx.try_recv() {
            Ok(event) => {
                recovery.recover_before(&event, |missed| {
                    absorb(&missed, &mut delivered, &mut first_offset);
                });
                absorb(&event, &mut delivered, &mut first_offset);
                match event {
                    PtyEvent::Output { .. } => events += 1,
                    PtyEvent::Desync { missed_bytes, .. } => {
                        panic!("stream desynced: {missed_bytes} bytes unrecoverable")
                    }
                    PtyEvent::Exit { .. } => break,
                }
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(n)) => {
                lagged += n;
                recovery.note_lag(n);
            }
            Err(_) => break,
        }
    }
    recovery.recover_tail(|missed| absorb(&missed, &mut delivered, &mut first_offset));
    let _ = handle.kill();

    let stats = recovery.stats();
    let from = first_offset.unwrap_or(0);
    let to = recovery.delivered_through().unwrap_or(from);
    let on_disk = digest_log_range(&log_index, from, to);
    let wall = t0.elapsed().as_secs_f64();

    println!("\n=== phasr bulk flood (unthrottled) ===");
    println!("flood         {:.1} MiB", FLOOD_BYTES as f64 / 1_048_576.0);
    println!("stalled for   {stalled_ms} ms before draining");
    println!("wall          {wall:.1} s ({:.1} MB/s delivered)",
        delivered.len as f64 / 1_048_576.0 / wall);
    println!("events        {events}");
    println!("lagged        {lagged} events");
    println!("refilled      {} B from the log", stats.recovered_bytes);
    println!("unrecovered   {} B", stats.unrecovered_bytes);
    println!("delivered     {} B (hash {:x})", delivered.len, delivered.hash);
    println!("log[{from}..{to}]  {} B (hash {:x})", on_disk.len, on_disk.hash);

    assert!(
        lagged > 0,
        "the broadcast never lagged — this test proved nothing about recovery"
    );
    assert_eq!(stats.unrecovered_bytes, 0, "bytes were lost for good");
    assert_eq!(stats.desyncs, 0, "the stream desynced");
    assert_eq!(
        delivered, on_disk,
        "the reconstructed stream is not the log, byte for byte"
    );
    assert!(
        delivered.len as usize >= FLOOD_BYTES,
        "only {} of {FLOOD_BYTES} flood bytes were delivered",
        delivered.len
    );
}

/// Does `stop_task` actually stop the agent?
///
/// `PtyHandle::kill()` signals the direct child, which is the login shell
/// (`pty/shell.rs` spawns `shell -l` and the agent command is typed INTO
/// it). The agent is therefore a grandchild, and nothing here kills a
/// process group. This spawns one real agent, kills the handle, and looks
/// for the agent afterwards.
#[test]
#[ignore]
fn kill_reaps_the_agent_not_just_the_shell() {
    if std::env::var("PHASR_LOAD").ok().as_deref() != Some("1") {
        eprintln!("skipped: set PHASR_LOAD=1");
        return;
    }
    for (k, _) in std::env::vars() {
        if k.starts_with("CLAUDE") {
            std::env::remove_var(&k);
        }
    }
    let marker = format!("phasr-reap-{}", std::process::id());
    let dir = tempfile::tempdir().unwrap();
    let wd = dir.path().join(&marker);
    std::fs::create_dir_all(&wd).unwrap();
    let runtime = TaskRuntime::new(dir.path().join("logs"));

    let handle = runtime
        .spawn("reap".into(), Some(AGENT_CMD.into()), Some("say hi".into()),
               wd.clone(), 40, 120)
        .unwrap();

    // Wait until the agent is genuinely up.
    let mut rx = handle.subscribe();
    let mut seen = String::new();
    let deadline = Instant::now() + Duration::from_secs(90);
    while Instant::now() < deadline && !seen.contains("esc to interrupt") {
        match rx.try_recv() {
            Ok(PtyEvent::Output { chunk, .. }) => {
                seen.push_str(&String::from_utf8_lossy(&chunk))
            }
            _ => std::thread::sleep(Duration::from_millis(30)),
        }
    }
    let booted = seen.contains("esc to interrupt");

    let count = || -> usize {
        String::from_utf8_lossy(
            &std::process::Command::new("sh")
                .arg("-c")
                .arg(format!("pgrep -f '{}' | wc -l", marker))
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .parse()
        .unwrap_or(0)
    };
    // pgrep on the cwd marker won't match the agent, so match on the
    // handle's own child tree instead: count claude processes before/after.
    let claude_before = String::from_utf8_lossy(
        &std::process::Command::new("sh").arg("-c")
            .arg("pgrep -fc 'dangerously-skip-permissions'").output().unwrap().stdout,
    ).trim().parse::<usize>().unwrap_or(0);

    let _ = handle.kill();
    std::thread::sleep(Duration::from_secs(4));

    let claude_after = String::from_utf8_lossy(
        &std::process::Command::new("sh").arg("-c")
            .arg("pgrep -fc 'dangerously-skip-permissions'").output().unwrap().stdout,
    ).trim().parse::<usize>().unwrap_or(0);

    println!("REAP booted={booted} claude_before={claude_before} claude_after={claude_after} (marker_procs={})", count());
    println!("REAP verdict: {}", if claude_after < claude_before {
        "kill() DID reap the agent"
    } else {
        "kill() LEFT THE AGENT RUNNING"
    });
}
