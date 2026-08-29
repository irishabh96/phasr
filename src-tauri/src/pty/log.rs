//! The per-task raw byte log — and, since Phase 3, the recovery source for
//! anything the frontend broadcast drops.
//!
//! Two responsibilities, deliberately in one place:
//!
//! * **Writer** (`TaskLog`) — owned by the coalescer thread. Buffered
//!   (`BufWriter`) and flushed on the coalesce tick, so a flood costs one
//!   write syscall per emitted event instead of one per 4 KiB PTY read.
//! * **Index** (`LogIndex`) — a shared, lock-protected view every subscriber
//!   can read a byte range out of. This is what makes `RecvError::Lagged`
//!   recoverable: the coalescer writes every byte here *before* it frames
//!   anything for the broadcast, so a hole in the broadcast is always a hole
//!   we can refill from disk (see `pty/backfill.rs`).
//!
//! ## Offsets are stream offsets, not file positions
//!
//! The log opens `append(true)`, so a task id reused across app runs appends
//! to an existing file. Offsets are seeded from the file length at open and
//! only ever increase; `Segment::base` maps a stream offset back to a
//! position inside whichever file currently holds it.
//!
//! ## Rotation, and the two constraints it sits between
//!
//! The log used to be unbounded (47 MB observed on the dev machine), so it
//! is capped here. The cap is pulled in two directions:
//!
//! * **Up**, by recovery: a lagging subscriber can miss at most the
//!   broadcast's in-flight window before it notices — 2048 slots ×
//!   (32 KiB coalesce ceiling + one 4 KiB read of overshoot) ≈ **72 MiB**.
//!   A gap older than the oldest retained byte is unrecoverable by
//!   construction, so retained history must exceed that.
//! * **Down**, by privacy: this file is every byte an agent printed,
//!   including anything the user pasted into the terminal. Rotated segments
//!   are **deleted**, never archived elsewhere, and the total is bounded.
//!
//! `LOG_SEGMENT_BYTES` × (`LOG_SEGMENTS_KEPT` sealed) = **96 MiB guaranteed
//! retained** (the floor, reached immediately after a rotation) against the
//! 72 MiB worst case, with a **128 MiB ceiling** on disk per task. Both
//! numbers are strictly smaller than today's "no cap at all" for the same
//! byte stream.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::RwLock;

/// Bytes written to the live segment before it is sealed and a fresh one
/// starts. See the module docs for how this number was chosen.
pub const LOG_SEGMENT_BYTES: u64 = 32 * 1024 * 1024;

/// Sealed segments kept behind the live one. Older ones are `remove_file`d,
/// not moved: the log is raw terminal content and must not become more
/// durable than it was.
pub const LOG_SEGMENTS_KEPT: usize = 3;

/// Largest single read a backfill performs. Bounds the memory a recovery
/// costs: a 90 MiB gap is refilled in 4 MiB bites, not one allocation.
pub const BACKFILL_READ_BYTES: usize = 4 * 1024 * 1024;

/// One log file plus the stream offset its first byte carries.
#[derive(Debug, Clone)]
struct Segment {
    path: PathBuf,
    base: u64,
}

/// The shared, readable half of a task's log. Cheap to clone (`Arc` it).
#[derive(Debug)]
pub struct LogIndex {
    /// Oldest first; the last entry is the live segment.
    segments: RwLock<Vec<Segment>>,
    /// Stream offset through which bytes have left the `BufWriter` and are
    /// readable through the filesystem. Never read past this — the bytes
    /// beyond it exist only in the writer's buffer.
    flushed_through: AtomicU64,
}

impl LogIndex {
    fn new(segments: Vec<Segment>, flushed_through: u64) -> Self {
        Self {
            segments: RwLock::new(segments),
            flushed_through: AtomicU64::new(flushed_through),
        }
    }

    pub fn flushed_through(&self) -> u64 {
        self.flushed_through.load(Ordering::Acquire)
    }

    /// Stream offset of the oldest byte still on disk. Anything below this
    /// was rotated away and is unrecoverable. Read by the rotation tests;
    /// `read_range` applies the same bound itself on the live path.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn oldest_offset(&self) -> u64 {
        self.segments
            .read()
            .first()
            .map(|s| s.base)
            .unwrap_or(u64::MAX)
    }

    /// Bytes of `[start, end)` that are actually readable, capped at
    /// `BACKFILL_READ_BYTES`. A **short or empty** return is the normal way
    /// this reports "that range is gone or not flushed yet" — callers treat
    /// it as the desync signal rather than as an error.
    ///
    /// The read lock is held across open+read so a rotation (which renames
    /// the live segment) cannot land between the two.
    pub fn read_range(&self, start: u64, end: u64) -> Vec<u8> {
        let segments = self.segments.read();
        let end = end.min(self.flushed_through());
        if start >= end {
            return Vec::new();
        }
        let Some(first) = segments.first() else {
            return Vec::new();
        };
        if start < first.base {
            // Rotated away. Unrecoverable by construction.
            return Vec::new();
        }
        let want = ((end - start) as usize).min(BACKFILL_READ_BYTES);
        let mut out: Vec<u8> = Vec::with_capacity(want);
        let mut cursor = start;

        for (i, segment) in segments.iter().enumerate() {
            if out.len() >= want {
                break;
            }
            let segment_end = segments.get(i + 1).map(|next| next.base).unwrap_or(end);
            if cursor >= segment_end {
                continue;
            }
            let take = ((segment_end.min(end) - cursor) as usize).min(want - out.len());
            if take == 0 {
                continue;
            }
            let Ok(mut file) = File::open(&segment.path) else {
                break;
            };
            if file.seek(SeekFrom::Start(cursor - segment.base)).is_err() {
                break;
            }
            let mut chunk = vec![0u8; take];
            let mut filled = 0usize;
            while filled < take {
                match file.read(&mut chunk[filled..]) {
                    Ok(0) => break,
                    Ok(n) => filled += n,
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            out.extend_from_slice(&chunk[..filled]);
            cursor += filled as u64;
            if filled < take {
                // Short read: the file is not what the index says it is.
                // Stop and let the caller declare the rest a desync.
                break;
            }
        }
        out
    }
}

/// The writable half. Owned by exactly one thread (the coalescer).
pub struct TaskLog {
    writer: BufWriter<File>,
    index: Arc<LogIndex>,
    /// Stream offset just past the last byte handed to the writer. Ahead of
    /// `flushed_through` by whatever is still sitting in the `BufWriter`.
    written_through: u64,
    /// Bytes in the live segment, for the rotation decision.
    segment_len: u64,
    /// Path of the live segment, and the sequence number the next sealed
    /// one will take.
    live: PathBuf,
    next_seq: u64,
}

impl TaskLog {
    /// Open (creating, appending) the live segment at `path`, adopting
    /// whatever a previous run left behind.
    ///
    /// Appending means a reused task id continues an existing file, so
    /// offsets are seeded from the length of the retained set — every sealed
    /// segment plus the live file — rather than from zero. Seeding at zero
    /// would point every backfill at the wrong bytes, and *not* adopting the
    /// old segments would leak them past the file cap forever, since
    /// rotation only ever prunes what it has indexed.
    pub fn open(path: &Path) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let existing = file.metadata().map(|m| m.len()).unwrap_or(0);

        let sealed = sealed_segments(path);
        let next_seq = sealed.last().map(|(seq, _)| seq + 1).unwrap_or(1);
        let mut segments = Vec::with_capacity(sealed.len() + 1);
        let mut base = 0u64;
        for (_, sealed_path) in &sealed {
            let len = std::fs::metadata(sealed_path).map(|m| m.len()).unwrap_or(0);
            segments.push(Segment {
                path: sealed_path.clone(),
                base,
            });
            base += len;
        }
        segments.push(Segment {
            path: path.to_path_buf(),
            base,
        });
        prune_segments(&mut segments);
        let written_through = base + existing;

        Ok(Self {
            writer: BufWriter::with_capacity(64 * 1024, file),
            index: Arc::new(LogIndex::new(segments, written_through)),
            written_through,
            segment_len: existing,
            live: path.to_path_buf(),
            next_seq,
        })
    }

    pub fn index(&self) -> Arc<LogIndex> {
        self.index.clone()
    }

    /// Stream offset just past the last byte appended.
    pub fn written_through(&self) -> u64 {
        self.written_through
    }

    /// Buffer `bytes`. A write error is swallowed exactly as it was before
    /// Phase 3: a full disk must not take the terminal down with it. The
    /// offset still advances, so a failed write shows up as an unrecoverable
    /// gap (a desync) rather than as silently misaligned offsets.
    pub fn append(&mut self, bytes: &[u8]) {
        let _ = self.writer.write_all(bytes);
        self.written_through += bytes.len() as u64;
        self.segment_len += bytes.len() as u64;
    }

    /// Push the buffer to the filesystem and publish the new readable
    /// horizon. Called on every coalesce flush, *before* the matching event
    /// is broadcast — that ordering is what lets a backfill assume any byte a
    /// subscriber has heard of is already on disk.
    pub fn flush(&mut self) {
        let _ = self.writer.flush();
        self.index
            .flushed_through
            .store(self.written_through, Ordering::Release);
        if self.segment_len >= LOG_SEGMENT_BYTES {
            self.rotate();
        }
    }

    /// Seal the live segment now, whatever its size. Tests only — production
    /// rotation is size-driven and reaching `LOG_SEGMENT_BYTES` in a test
    /// would mean writing 32 MiB per boundary.
    #[cfg(test)]
    pub fn rotate_for_test(&mut self) {
        self.rotate();
    }

    /// Seal the live segment, start a fresh one, and delete whatever fell off
    /// the end. Only ever called from `flush`, so the sealed file is complete
    /// on disk before it is renamed.
    ///
    /// **The whole body runs under the index write lock, including the
    /// rename.** A backfiller holds the read lock across its open+read, so
    /// otherwise it could resolve `<task>.log` to the fresh, empty segment
    /// while still using the old segment's base — and read the wrong bytes at
    /// the right-looking offset, which is worse than the hole this phase
    /// exists to close. The cost is that a rotation waits for an in-flight
    /// 4 MiB backfill read; that is the correct precedence.
    fn rotate(&mut self) {
        let live = self.live.clone();
        let sealed = PathBuf::from(format!("{}.{}", live.display(), self.next_seq));
        let base = self.written_through;
        let mut segments = self.index.segments.write();

        if std::fs::rename(&live, &sealed).is_err() {
            // Keep writing into the current segment rather than losing the
            // stream; the cap is best-effort, the byte stream is not.
            return;
        }
        let fresh = match OpenOptions::new().create(true).append(true).open(&live) {
            Ok(file) => file,
            Err(_) => {
                let _ = std::fs::rename(&sealed, &live);
                return;
            }
        };
        self.next_seq += 1;
        self.writer = BufWriter::with_capacity(64 * 1024, fresh);
        self.segment_len = 0;

        if let Some(last) = segments.last_mut() {
            last.path = sealed;
        }
        segments.push(Segment { path: live, base });
        prune_segments(&mut segments);
    }
}

/// Drop the oldest segments past the cap, deleting their files. Shared by
/// rotation and by `open` (which adopts a previous run's segments and must
/// apply the same bound to them).
fn prune_segments(segments: &mut Vec<Segment>) {
    while segments.len() > LOG_SEGMENTS_KEPT + 1 {
        let dropped = segments.remove(0);
        let _ = std::fs::remove_file(&dropped.path);
    }
}

/// `(sequence, path)` for every sealed segment of `live`, oldest first.
fn sealed_segments(live: &Path) -> Vec<(u64, PathBuf)> {
    let Some(dir) = live.parent() else {
        return Vec::new();
    };
    let Some(name) = live.file_name().and_then(|n| n.to_str()) else {
        return Vec::new();
    };
    let prefix = format!("{name}.");
    let mut found: Vec<(u64, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let file_name = path.file_name()?.to_str()?;
            let seq: u64 = file_name.strip_prefix(&prefix)?.parse().ok()?;
            Some((seq, path))
        })
        .collect();
    found.sort_by_key(|(seq, _)| *seq);
    found
}

/// Every retained byte of a task's log, oldest first: sealed segments in
/// sequence order, then the live one.
///
/// `read_task_log` and the B1 replay corpus both read the log as one stream,
/// and rotation must not break either — so the seam is hidden here rather
/// than at every call site.
pub fn read_all_segments(live: &Path) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    for (_, path) in sealed_segments(live) {
        match std::fs::read(&path) {
            Ok(bytes) => out.extend_from_slice(&bytes),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err),
        }
    }
    match std::fs::read(live) {
        Ok(bytes) => out.extend_from_slice(&bytes),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_are_seeded_from_an_existing_file_not_from_zero() {
        // The log opens `append(true)`, so a task id reused across app runs
        // continues an existing file. An offset seeded at 0 would point every
        // backfill at the wrong bytes.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.log");
        std::fs::write(&path, b"from a previous run").unwrap();

        let mut log = TaskLog::open(&path).unwrap();
        assert_eq!(log.written_through(), 19);
        log.append(b"new");
        log.flush();
        assert_eq!(log.written_through(), 22);
        assert_eq!(log.index().read_range(19, 22), b"new".to_vec());
    }

    #[test]
    fn a_range_is_readable_only_once_it_is_flushed() {
        // The BufWriter is the whole point of criterion 4, and it makes
        // recent bytes invisible to a backfiller. `flushed_through` is the
        // contract that keeps a reader from reading a hole.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.log");
        let mut log = TaskLog::open(&path).unwrap();

        log.append(b"buffered");
        assert_eq!(log.index().flushed_through(), 0);
        assert!(log.index().read_range(0, 8).is_empty());

        log.flush();
        assert_eq!(log.index().flushed_through(), 8);
        assert_eq!(log.index().read_range(0, 8), b"buffered".to_vec());
    }

    #[test]
    fn a_range_spanning_a_rotation_boundary_reads_as_one_stream() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.log");
        let mut log = TaskLog::open(&path).unwrap();

        log.append(b"before-the-seam");
        log.flush();
        log.rotate_for_test();
        log.append(b"after-the-seam");
        log.flush();

        let all = log.index().read_range(0, log.written_through());
        assert_eq!(all, b"before-the-seamafter-the-seam".to_vec());
    }

    #[test]
    fn a_gap_older_than_the_oldest_segment_is_reported_as_unreadable() {
        // The honest floor: a hole that starts before the rotation boundary
        // cannot be refilled, and `read_range` says so by returning nothing
        // rather than by returning the wrong bytes.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.log");
        let mut log = TaskLog::open(&path).unwrap();

        for i in 0..(LOG_SEGMENTS_KEPT + 2) {
            log.append(format!("segment-{i};").as_bytes());
            log.flush();
            log.rotate_for_test();
        }
        let oldest = log.index().oldest_offset();
        assert!(oldest > 0, "expected segments to have been dropped");
        assert!(log.index().read_range(0, oldest).is_empty());
        assert_eq!(
            log.index().read_range(oldest, log.written_through()),
            b"segment-2;segment-3;segment-4;".to_vec()
        );
    }

    #[test]
    fn rotation_deletes_rather_than_archives_the_oldest_segment() {
        // #EXPORT_CRITICAL: the log is raw terminal content. Rotated
        // segments are removed, and the file count is bounded.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.log");
        let mut log = TaskLog::open(&path).unwrap();

        for i in 0..10 {
            log.append(format!("{i}").as_bytes());
            log.flush();
            log.rotate_for_test();
        }
        let files = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(
            files,
            LOG_SEGMENTS_KEPT + 1,
            "log must be bounded at {} files",
            LOG_SEGMENTS_KEPT + 1
        );
    }

    #[test]
    fn read_all_segments_survives_a_rotation() {
        // `read_task_log`'s dependency: the user-visible log is the whole
        // retained stream, in order, across the seam.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.log");
        let mut log = TaskLog::open(&path).unwrap();

        log.append(b"one;");
        log.flush();
        log.rotate_for_test();
        log.append(b"two;");
        log.flush();
        log.rotate_for_test();
        log.append(b"three;");
        log.flush();

        assert_eq!(read_all_segments(&path).unwrap(), b"one;two;three;".to_vec());
    }

    #[test]
    fn a_reader_never_sees_the_wrong_bytes_while_the_writer_rotates() {
        // Rotation renames the live segment. If that rename could land
        // between a reader resolving `<task>.log` and reading it, the reader
        // would seek to the OLD segment's base inside the NEW file and
        // return bytes that look plausible and are wrong — strictly worse
        // than the hole this whole phase exists to close.
        //
        // Safety comes from the ORDERING (the rename runs under the index
        // write lock, which `read_range` holds across its open+read), not
        // from this test: the window is microseconds and does not reproduce
        // on demand. What this does buy is a hard stress of 400 rotations
        // against a reader that never stops, with every byte a function of
        // its own absolute stream offset — so a misaligned read cannot pass
        // by luck, and a future refactor that drops the lock has a chance of
        // being caught here rather than by a user.
        let byte_at = |offset: u64| (offset % 251) as u8;
        let dir = tempfile::tempdir().unwrap();
        let mut log = TaskLog::open(&dir.path().join("t.log")).unwrap();
        let index = log.index();
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let reader = {
            let index = index.clone();
            let done = done.clone();
            std::thread::spawn(move || {
                let mut verified = 0u64;
                while !done.load(Ordering::Relaxed) {
                    let from = index.oldest_offset();
                    let to = index.flushed_through();
                    if from == u64::MAX || from >= to {
                        continue;
                    }
                    let bytes = index.read_range(from, to);
                    for (i, byte) in bytes.iter().enumerate() {
                        assert_eq!(
                            *byte,
                            byte_at(from + i as u64),
                            "read the wrong byte at offset {}",
                            from + i as u64
                        );
                    }
                    verified += bytes.len() as u64;
                }
                verified
            })
        };

        for _ in 0..400 {
            let start = log.written_through();
            let chunk: Vec<u8> = (0..777u64).map(|i| byte_at(start + i)).collect();
            log.append(&chunk);
            log.flush();
            log.rotate_for_test();
        }
        done.store(true, Ordering::Relaxed);
        let verified = reader.join().unwrap();
        assert!(
            verified > 0,
            "the reader never landed a read — the race was not exercised"
        );
    }

    #[test]
    fn a_restart_does_not_reuse_a_sealed_segments_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.log");
        {
            let mut log = TaskLog::open(&path).unwrap();
            log.append(b"first-run;");
            log.flush();
            log.rotate_for_test();
            log.append(b"still-first;");
            log.flush();
        }
        let mut log = TaskLog::open(&path).unwrap();
        log.append(b"second-run;");
        log.flush();
        log.rotate_for_test();

        // Nothing was clobbered: both runs' bytes are still readable.
        let all = read_all_segments(&path).unwrap();
        assert_eq!(all, b"first-run;still-first;second-run;".to_vec());
    }
}
