//! The CPU-activity liveness sensor (Step 0 spec, enabler E-P1-T2).
//!
//! Output-recency alone cannot tell a busy-but-quiet agent (a long
//! `cargo build`, a local model thinking) from a wedged one — both are
//! silent. This sampler answers "is the agent's process subtree actually
//! burning CPU?" so the poller can keep an honestly-Working agent out of
//! the Wedged bucket.
//!
//! macOS-only by design (the product is macOS-only): `proc_pidinfo`-backed
//! task info via the `libproc` crate, summed over the PTY shell's process
//! SUBTREE (the tracked pid is the login shell, which mostly sleeps — the
//! agent and its build children do the work). Any failure anywhere returns
//! `None`, and the caller degrades to the P0 output-recency behavior —
//! the sensor can only ever ADD confidence, never subtract it.

/// Total CPU nanoseconds (user + system) consumed by `pid` AND its
/// descendants, or `None` when sampling fails (process gone, permission,
/// non-macOS build).
#[cfg(target_os = "macos")]
pub fn sample_subtree_cpu_ns(pid: u32) -> Option<u64> {
    use libproc::libproc::proc_pid::pidinfo;
    use libproc::libproc::task_info::TaskInfo;
    use libproc::processes::{pids_by_type, ProcFilter};

    fn task_ns(pid: u32) -> Option<u64> {
        let info = pidinfo::<TaskInfo>(pid as i32, 0).ok()?;
        Some(info.pti_total_user.saturating_add(info.pti_total_system))
    }

    // BFS over the subtree; a bounded frontier defends against a pathological
    // (or racing) parent-chain — 256 processes is far beyond any real agent.
    let mut total = task_ns(pid)?;
    let mut frontier = vec![pid];
    let mut seen = 0usize;
    while let Some(parent) = frontier.pop() {
        seen += 1;
        if seen > 256 {
            break;
        }
        let children =
            pids_by_type(ProcFilter::ByParentProcess { ppid: parent }).unwrap_or_default();
        for child in children {
            // A child that vanished mid-walk just contributes nothing.
            if let Some(ns) = task_ns(child) {
                total = total.saturating_add(ns);
            }
            frontier.push(child);
        }
    }
    Some(total)
}

#[cfg(not(target_os = "macos"))]
pub fn sample_subtree_cpu_ns(_pid: u32) -> Option<u64> {
    None
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::*;

    // The sampler reads a real, live process (our own test runner) and comes
    // back with a monotonically non-decreasing total.
    #[test]
    fn samples_own_process_subtree() {
        let pid = std::process::id();
        let first = sample_subtree_cpu_ns(pid).expect("own process must sample");
        // Burn a little CPU so the second sample can only be >=.
        let mut x = 0u64;
        for i in 0..2_000_000u64 {
            x = x.wrapping_add(i);
        }
        std::hint::black_box(x);
        let second = sample_subtree_cpu_ns(pid).expect("own process must sample");
        assert!(second >= first, "cpu totals never go backwards");
    }

    // A pid that can't exist → None (the degrade contract, never a panic).
    #[test]
    fn missing_process_degrades_to_none() {
        assert_eq!(sample_subtree_cpu_ns(u32::MAX - 7), None);
    }
}
