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
//!   * PTY throughput after coalescing, and **dropped output**:
//!     `RecvError::Lagged` is silently `continue`d by the production
//!     forwarders, so a burst that outruns the 2048-slot broadcast loses
//!     terminal content with no error anywhere. Counted here.
//!   * process RSS and thread count for the whole tree.
#![cfg(test)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::pty::PtyEvent;
use crate::pty::TaskRuntime;

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
}

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
    counters: Arc<(AtomicU64, AtomicU64, AtomicU64)>,
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
            };
        }
    };

    let mut rx = handle.subscribe();
    let mut seen = String::new();
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
            Ok(PtyEvent::Output { chunk, .. }) => {
                events += 1;
                bytes += chunk.len() as u64;
                seen.push_str(&String::from_utf8_lossy(&chunk));
                if seen.len() > 200_000 {
                    seen.drain(..100_000);
                }
            }
            Ok(PtyEvent::Exit { .. }) => break,
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(n)) => {
                lagged += n;
            }
            Err(_) => break,
        }
    }
    let _ = handle.kill();
    counters.0.fetch_add(bytes, Ordering::Relaxed);
    counters.1.fetch_add(events, Ordering::Relaxed);
    counters.2.fetch_add(lagged, Ordering::Relaxed);
    AgentResult { id, ready_ms, submitted_ms, tasks_completed: completed, bytes, events, lagged }
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
    println!("{:>3} {:>7} {:>9} {:>9} {:>8} {:>9} {:>8} {:>7} {:>6} {:>5}",
        "N", "wall_s", "ready_p50", "subm_p50", "tasks", "bytes", "events", "drop", "rssMB", "thr");

    for &n in &steps {
        let dir = tempfile::tempdir().unwrap();
        let log_dir = dir.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        let runtime = TaskRuntime::new(log_dir);
        let counters = Arc::new((AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)));

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
        let dropped = counters.2.load(Ordering::Relaxed);

        println!("{n:>3} {wall:>7.1} {ready:>9} {subm:>9} {:>8} {bytes:>9} {events:>8} {dropped:>7} {rss:>6} {threads:>5}",
            format!("{tasks}/{}", n * TASKS.len()));

        for r in &results {
            if r.submitted_ms.is_none() {
                println!("     ! {} NEVER SUBMITTED (bytes={} events={} lag={})",
                    r.id, r.bytes, r.events, r.lagged);
            }
        }
        if submitted_n < n {
            println!("\nBROKE AT N={n}: {submitted_n}/{n} agents submitted their prompt.");
            println!("load now: {}", load_avg());
            break;
        }
        if dropped > 0 {
            println!("     ! {dropped} PTY events dropped (broadcast lag) at N={n}");
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    println!("\nload at end: {}", load_avg());
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
