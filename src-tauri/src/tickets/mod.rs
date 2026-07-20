//! On-disk "rich ticket" brief file-service (Phase 2, stories T2/T4).
//!
//! Each decomposition subtask owns a folder in the *managed* repo:
//! `<repo.local_path>/.phasr/tickets/<ticketId>/` where `ticketId == subtask
//! workspace id`. This module is the ONLY reader/writer of that layout; the
//! `commands::tickets` handlers are thin wrappers over it and the
//! `commands::board` scaffold hook + the scheduler's brief-pointer both call in
//! here. It owns NO SQL and NO Tauri types — pure-ish fs I/O, so the git/store
//! test style (`tempdir` + real files) exercises it directly.
//!
//! ## Single source of truth (architect #2)
//!
//! In Phase 2 there is exactly ONE physical copy of every ticket file: on the
//! **main checkout** (`repository.local_path`). The subtask worktree never
//! materialises it (the brief is authored/uncommitted on the main checkout, so
//! it is invisible in a fresh worktree — the agent reads it via the absolute
//! main-repo path, A3). So cross-checkout divergence cannot occur here; the only
//! writers are `write_ticket_section` (the human, "you") and an external editor
//! or git. Optimistic concurrency is mtime-primed but **hash-arbitrated**
//! (`TicketWriteRegistry`) so a bumped-but-unchanged file never raises a
//! spurious conflict, and T7's watcher can suppress its own writes by hash.
//!
//! ## Honest authorship (architect #1)
//!
//! The agent is READ-ONLY on the brief in Phase 2 (agent writes are Phase 3, via
//! the `phasr` CLI). So `write_ticket_section` only ever stamps `by:"you"`; an
//! unverifiable external edit is attributed **neutrally** (no `.meta.json`
//! stamp / "changed on disk"). `by:"agent"` is reserved for Phase 3.
//!
//! ## Traversal safety (`#EXPORT_CRITICAL`, A1)
//!
//! Every path resolves under `<repo>/.phasr/tickets/<sanitised id>/…`; a crafted
//! `ticketId` (`..`, absolute, containing a separator) is rejected BEFORE any fs
//! touch. `section` is a typed enum on the wire, so it can never carry traversal.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::{Path, PathBuf};

use chrono::Utc;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use thiserror::Error;

// ── error ────────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum TicketError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    /// A `ticketId` that would escape the ticket dir (`..`, a path separator, or
    /// an absolute path). Rejected before any filesystem access (A1).
    #[error("invalid ticket id `{0}`")]
    InvalidTicketId(String),
    /// The ticket's repository has no local checkout, so there is nowhere to
    /// write the single physical copy (architect #2). Reads degrade to an empty
    /// brief; writes surface this.
    #[error("repository has no local checkout to store the ticket brief")]
    RepositoryHasNoLocalPath,
    #[error("serialization error: {0}")]
    Serde(String),
}

impl serde::Serialize for TicketError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ── wire DTOs (the frozen §C contract; camelCase on the wire) ─────────────────

/// The three editable text sections of a brief. A typed enum on the wire, so a
/// traversal string can never reach the file map (`description → ticket.md`,
/// `prd → prd.md`, `trd → trd.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BriefSection {
    Description,
    Prd,
    Trd,
}

impl BriefSection {
    /// The on-disk file backing this section.
    fn file_name(self) -> &'static str {
        match self {
            BriefSection::Description => "ticket.md",
            BriefSection::Prd => "prd.md",
            BriefSection::Trd => "trd.md",
        }
    }

    /// The `.meta.json` key for this section's authorship entry.
    fn key(self) -> &'static str {
        match self {
            BriefSection::Description => "description",
            BriefSection::Prd => "prd",
            BriefSection::Trd => "trd",
        }
    }
}

/// Who last edited a section / added a link. Phase 2 only ever WRITES `You`
/// (the agent is read-only until Phase 3); `Agent` exists for the read side +
/// the Phase-3 CLI (architect #1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LastEditedBy {
    You,
    Agent,
}

/// One section's content + optimistic-concurrency mtime + local authorship.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefSectionContent {
    /// Raw markdown ("" when the file is missing — a missing file is an empty
    /// section, never an error).
    pub content: String,
    /// On-disk mtime (ms since epoch) for optimistic-concurrency; `None` when the
    /// file does not exist yet.
    pub mtime_ms: Option<i64>,
    /// From `.meta.json`; `None` when unknown/never stamped (honest — an external
    /// edit stays unattributed in Phase 2).
    pub last_edited_by: Option<LastEditedBy>,
    pub last_edited_at_ms: Option<i64>,
}

/// The whole brief for one ticket. `assets`/`figma` are wired to the on-disk
/// listing by Story T5-BE; T4 returns the text sections + a cheap comment count.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketBrief {
    pub ticket_id: String,
    /// H1 of `ticket.md`, falling back to the workspace name (or the id).
    pub title: String,
    pub description: BriefSectionContent,
    pub prd: BriefSectionContent,
    pub trd: BriefSectionContent,
    pub assets: Vec<TicketAsset>,
    pub figma: Vec<FigmaLink>,
    pub comment_count: i64,
}

/// `write_ticket_section`'s result: a clean save, or a stale-base conflict the FE
/// resolves with Reload / Keep-mine. Tagged union — `{ kind: "saved", section }`
/// / `{ kind: "conflict", onDisk }`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WriteSectionResult {
    Saved {
        section: BriefSectionContent,
    },
    Conflict {
        #[serde(rename = "onDisk")]
        on_disk: BriefSectionContent,
    },
}

/// An attached asset. Constructed by Story T5-BE (`add_ticket_asset` /
/// `list_ticket_assets`); defined here because it is a field of `TicketBrief`
/// (the §C shape is frozen).
#[allow(dead_code)] // populated by T5-BE
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketAsset {
    pub id: String,
    pub name: String,
    pub storage: AssetStorage,
    pub path: String,
    pub size_bytes: i64,
    pub kind: AssetKind,
    pub added_at_ms: i64,
}

#[allow(dead_code)] // constructed by T5-BE
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssetStorage {
    InRepo,
    AppData,
}

#[allow(dead_code)] // constructed by T5-BE
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    Image,
    Pdf,
    Binary,
}

/// A linked Figma design. Constructed by Story T5-BE (`add_ticket_figma_link`);
/// defined here because it is a field of `TicketBrief`.
#[allow(dead_code)] // populated by T5-BE
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FigmaLink {
    pub id: String,
    pub url: String,
    pub label: Option<String>,
    pub added_by: LastEditedBy,
    pub added_at_ms: i64,
}

// ── own-write registry (architect #2 hash-assist; exposes what T7 needs) ──────

/// Records the hash of the exact bytes the file-service last wrote to each path.
/// Two consumers:
///   - `write_ticket_section` skips a *spurious* conflict when the mtime bumped
///     but the on-disk bytes are still our own last write.
///   - T7's `watch_ticket` suppresses its own-write change events (`matches`),
///     so a save never round-trips as a phantom external edit.
///
/// Shared app state (managed in `lib.rs`), so both the writer and the watcher
/// see the same instance. In-process only; a stable-across-runs hash is not
/// required (the registry is empty at launch).
#[derive(Default)]
pub struct TicketWriteRegistry {
    hashes: Mutex<HashMap<String, u64>>,
}

impl TicketWriteRegistry {
    /// Remember that `bytes` are what we just wrote to `path`.
    pub fn record(&self, path: &Path, bytes: &[u8]) {
        self.hashes
            .lock()
            .insert(path.to_string_lossy().into_owned(), hash_bytes(bytes));
    }

    /// `true` when `bytes` hash to exactly what we last wrote at `path` — i.e.
    /// the file currently holds our own write, not an external edit. T7 uses this
    /// to drop own-write watcher events.
    pub fn matches(&self, path: &Path, bytes: &[u8]) -> bool {
        self.hashes
            .lock()
            .get(&path.to_string_lossy().into_owned())
            .copied()
            == Some(hash_bytes(bytes))
    }
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

// ── path resolution (traversal-safe) ─────────────────────────────────────────

/// `<repo>/.phasr/tickets`.
fn tickets_root(repo_root: &Path) -> PathBuf {
    repo_root.join(".phasr").join("tickets")
}

/// Resolve `<repo>/.phasr/tickets/<sanitised id>`, rejecting a traversal id
/// BEFORE any fs access (A1 / `#EXPORT_CRITICAL`). Public so the scheduler's
/// brief pointer (T3) names the exact same absolute path.
pub fn ticket_dir(repo_root: &Path, ticket_id: &str) -> Result<PathBuf, TicketError> {
    let id = sanitize_ticket_id(ticket_id)?;
    Ok(tickets_root(repo_root).join(id))
}

/// Reject any `ticketId` that could escape the tickets root. A subtask id is a
/// UUID, so this never fires in practice — it is the belt-and-suspenders guard
/// against a crafted id reaching the fs.
fn sanitize_ticket_id(id: &str) -> Result<&str, TicketError> {
    let trimmed = id.trim();
    let escapes = trimmed.is_empty()
        || trimmed == "."
        || trimmed.contains("..")
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || Path::new(trimmed).is_absolute();
    if escapes {
        return Err(TicketError::InvalidTicketId(id.to_string()));
    }
    Ok(trimmed)
}

// ── T2: scaffold a ticket folder at decomposition ────────────────────────────

const PRD_TEMPLATE: &str =
    "# Product Requirements\n\n_What to build and why. The agent reads this as \
     part of its brief._\n";
const TRD_TEMPLATE: &str =
    "# Technical Requirements\n\n_The technical approach, constraints, and \
     interfaces the agent should honour._\n";

/// Scaffold `<repo>/.phasr/tickets/<ticketId>/` with a seeded `ticket.md`
/// (H1 = title, body = description), empty-template `prd.md`/`trd.md`, an empty
/// `figma.json`/`comments.jsonl`, and the `assets/` dir. Idempotent: an existing
/// file is NEVER clobbered (a re-decompose preserves human edits). Also writes
/// `.phasr/tickets/.gitignore` (`**/.meta.json`) once and soft-warns if the repo
/// already gitignores `.phasr/`.
///
/// Callers treat this as **best-effort** — a scaffold failure must not fail the
/// decomposition (T2 AC).
pub fn scaffold_ticket(
    repo_root: &Path,
    ticket_id: &str,
    title: &str,
    description: &str,
) -> Result<(), TicketError> {
    let dir = ticket_dir(repo_root, ticket_id)?;
    std::fs::create_dir_all(&dir)?;
    std::fs::create_dir_all(dir.join("assets"))?;

    create_if_absent(&dir.join("ticket.md"), &compose_ticket_md(Some(title), description))?;
    create_if_absent(&dir.join("prd.md"), PRD_TEMPLATE)?;
    create_if_absent(&dir.join("trd.md"), TRD_TEMPLATE)?;
    create_if_absent(&dir.join("figma.json"), "[]\n")?;
    create_if_absent(&dir.join("comments.jsonl"), "")?;

    // The brief is versioned, but the local-only authorship sidecar is not: seed
    // `.phasr/tickets/.gitignore` so `.meta.json` never rides into a PR (§B).
    create_if_absent(&tickets_root(repo_root).join(".gitignore"), "**/.meta.json\n")?;

    warn_if_phasr_gitignored(repo_root);
    Ok(())
}

/// Best-effort create the ticket dir (used by the scheduler before it names the
/// brief pointer, T3), so the paths the pointer references exist even for a
/// ticket that was somehow never scaffolded. Returns the dir on success.
pub fn ensure_ticket_dir(repo_root: &Path, ticket_id: &str) -> Result<PathBuf, TicketError> {
    let dir = ticket_dir(repo_root, ticket_id)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn create_if_absent(path: &Path, contents: &str) -> io::Result<()> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_atomic(path, contents.as_bytes())
}

/// Soft-warn (never fail) when the repo gitignores `.phasr/` — the versioned
/// brief would then be invisible to git, quietly breaking the "docs ship with
/// the code" thesis. Purely advisory (architect #5).
fn warn_if_phasr_gitignored(repo_root: &Path) {
    let Ok(contents) = std::fs::read_to_string(repo_root.join(".gitignore")) else {
        return;
    };
    if contents.lines().any(line_ignores_phasr) {
        eprintln!(
            "phasr: repository `{}` gitignores `.phasr/` — ticket briefs won't be \
             versioned with the code (they are meant to ship in the PR). Consider \
             un-ignoring `.phasr/tickets/`.",
            repo_root.display()
        );
    }
}

fn line_ignores_phasr(line: &str) -> bool {
    let l = line.trim();
    if l.is_empty() || l.starts_with('#') {
        return false;
    }
    let l = l.trim_start_matches('/').trim_end_matches('/');
    l == ".phasr" || l.starts_with(".phasr/")
}

// ── T4: read the whole brief ─────────────────────────────────────────────────

/// Read the full brief for `ticket_id`. Missing files → empty sections (never an
/// error); a repo with no local checkout or a not-yet-scaffolded ticket → an
/// empty brief keyed by the id. A traversal id IS an error (rejected before any
/// fs touch). `title_fallback` is the workspace name (§C: H1 falls back to it).
pub fn read_brief(
    repo_local_path: Option<&Path>,
    ticket_id: &str,
    title_fallback: Option<&str>,
) -> Result<TicketBrief, TicketError> {
    let fallback_title = title_fallback
        .map(str::to_string)
        .unwrap_or_else(|| ticket_id.to_string());

    // No checkout → no on-disk ticket. An empty brief renders the graceful
    // empty-with-CTA state, never a hard failure (T4 AC).
    let Some(repo_root) = repo_local_path else {
        return Ok(empty_brief(ticket_id, fallback_title));
    };
    // A traversal id errors here (before any read); a valid-but-missing dir just
    // reads back as empty sections below.
    let dir = ticket_dir(repo_root, ticket_id)?;
    let meta = read_meta(&dir);

    // Read ticket.md once: the H1 is the title, the body is the description.
    let ticket_md = read_file_opt(&dir.join("ticket.md"))?;
    let raw = ticket_md.as_ref().map(|(c, _)| c.as_str()).unwrap_or("");
    let (title, body) = parse_ticket_md(raw);
    let description = BriefSectionContent {
        content: body,
        mtime_ms: ticket_md.as_ref().map(|(_, m)| *m),
        last_edited_by: meta.get(BriefSection::Description.key()).map(|e| e.by),
        last_edited_at_ms: meta.get(BriefSection::Description.key()).map(|e| e.at),
    };

    Ok(TicketBrief {
        ticket_id: ticket_id.to_string(),
        title: title.unwrap_or(fallback_title),
        description,
        prd: read_section(&dir, BriefSection::Prd, &meta)?,
        trd: read_section(&dir, BriefSection::Trd, &meta)?,
        // T5-BE wires the on-disk asset/figma listing (it owns the storage split
        // + the figma.json schema); T4 returns the text brief + a cheap count.
        assets: Vec::new(),
        figma: Vec::new(),
        comment_count: count_comments(&dir),
    })
}

fn empty_brief(ticket_id: &str, title: String) -> TicketBrief {
    let empty = || BriefSectionContent {
        content: String::new(),
        mtime_ms: None,
        last_edited_by: None,
        last_edited_at_ms: None,
    };
    TicketBrief {
        ticket_id: ticket_id.to_string(),
        title,
        description: empty(),
        prd: empty(),
        trd: empty(),
        assets: Vec::new(),
        figma: Vec::new(),
        comment_count: 0,
    }
}

fn read_section(dir: &Path, section: BriefSection, meta: &Meta) -> Result<BriefSectionContent, TicketError> {
    let file = read_file_opt(&dir.join(section.file_name()))?;
    let raw = file.as_ref().map(|(c, _)| c.as_str()).unwrap_or("");
    let mtime = file.as_ref().map(|(_, m)| *m);
    Ok(build_section_content(section, raw, mtime, meta))
}

/// Build a section view from already-read raw bytes (description strips the H1).
fn build_section_content(
    section: BriefSection,
    raw: &str,
    mtime_ms: Option<i64>,
    meta: &Meta,
) -> BriefSectionContent {
    let content = match section {
        BriefSection::Description => parse_ticket_md(raw).1,
        _ => raw.to_string(),
    };
    let entry = meta.get(section.key());
    BriefSectionContent {
        content,
        mtime_ms,
        last_edited_by: entry.map(|e| e.by),
        last_edited_at_ms: entry.map(|e| e.at),
    }
}

/// Count non-empty lines in `comments.jsonl` (format-agnostic; T5-BE owns the
/// per-line schema). 0 when the file is missing.
fn count_comments(dir: &Path) -> i64 {
    std::fs::read_to_string(dir.join("comments.jsonl"))
        .map(|raw| raw.lines().filter(|l| !l.trim().is_empty()).count() as i64)
        .unwrap_or(0)
}

// ── T4: write one section (conflict-aware) ───────────────────────────────────

/// Write one section, mtime-primed + hash-arbitrated (architect #2). Returns
/// `Saved` on a clean write (stamping `.meta.json {by:"you"}`), or `Conflict`
/// when the on-disk bytes genuinely diverged from what the FE loaded (stale
/// `base_mtime_ms` AND a real content change) — in which case the file is NOT
/// overwritten and the on-disk view rides back for Reload / Keep-mine.
pub fn write_section(
    registry: &TicketWriteRegistry,
    repo_root: &Path,
    ticket_id: &str,
    section: BriefSection,
    content: &str,
    base_mtime_ms: Option<i64>,
) -> Result<WriteSectionResult, TicketError> {
    let dir = ticket_dir(repo_root, ticket_id)?;
    std::fs::create_dir_all(&dir)?; // create-on-write for a not-yet-scaffolded ticket
    let path = dir.join(section.file_name());

    let disk = read_file_opt(&path)?;
    let disk_content = disk.as_ref().map(|(c, _)| c.clone()).unwrap_or_default();
    let disk_mtime = disk.as_ref().map(|(_, m)| *m);

    // The exact bytes we would write. For the description we preserve the H1 so
    // the title survives a body-only edit; prd/trd write verbatim.
    let new_bytes = match section {
        BriefSection::Description => {
            let (title, _body) = parse_ticket_md(&disk_content);
            compose_ticket_md(title.as_deref(), content)
        }
        _ => content.to_string(),
    };

    // mtime is the cheap "maybe changed" signal; the hash is the arbiter. A
    // bumped-but-identical file (an identical edit, a `touch`, or our own prior
    // write) is NOT a conflict — only a real content divergence is.
    let stale = matches!((base_mtime_ms, disk_mtime), (Some(base), Some(disk)) if disk > base);
    let content_diverged = new_bytes.as_bytes() != disk_content.as_bytes();
    let is_our_own_write = registry.matches(&path, disk_content.as_bytes());
    if stale && content_diverged && !is_our_own_write {
        let meta = read_meta(&dir);
        return Ok(WriteSectionResult::Conflict {
            on_disk: build_section_content(section, &disk_content, disk_mtime, &meta),
        });
    }

    // Atomic write (tmp-then-rename) so a reader/watcher never sees a partial
    // file, then record the hash so a follow-up save's mtime bump isn't a false
    // conflict and T7 can suppress this own-write event.
    write_atomic(&path, new_bytes.as_bytes())?;
    registry.record(&path, new_bytes.as_bytes());

    // Our writes are always the human ("you"); Phase 2 never stamps "agent".
    stamp_meta(&dir, section, LastEditedBy::You, Utc::now().timestamp_millis())?;

    let meta = read_meta(&dir);
    Ok(WriteSectionResult::Saved {
        section: read_section(&dir, section, &meta)?,
    })
}

// ── ticket.md H1/body split ──────────────────────────────────────────────────

/// Split `ticket.md` into `(title, body)`: the first `# ` line is the title, the
/// rest is the description body. No H1 → `(None, whole-trimmed)` so a headless
/// file falls back to the workspace name on read (§C).
fn parse_ticket_md(raw: &str) -> (Option<String>, String) {
    for (idx, line) in raw.lines().enumerate() {
        if let Some(rest) = line.strip_prefix("# ") {
            let title = rest.trim().to_string();
            let body = raw.lines().skip(idx + 1).collect::<Vec<_>>().join("\n");
            return (Some(title), body.trim().to_string());
        }
    }
    (None, raw.trim().to_string())
}

/// Recompose `ticket.md` from a title + body. A blank/absent title writes just
/// the body (a later read then parses no-H1 → workspace-name fallback), so we
/// never fabricate a title we don't have.
fn compose_ticket_md(title: Option<&str>, body: &str) -> String {
    let body = body.trim_end();
    match title {
        Some(t) if !t.trim().is_empty() => {
            if body.is_empty() {
                format!("# {}\n", t.trim())
            } else {
                format!("# {}\n\n{}\n", t.trim(), body)
            }
        }
        _ => {
            if body.is_empty() {
                String::new()
            } else {
                format!("{body}\n")
            }
        }
    }
}

// ── `.meta.json` authorship sidecar (local-only) ─────────────────────────────

type Meta = BTreeMap<String, SectionMeta>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct SectionMeta {
    by: LastEditedBy,
    at: i64,
}

fn meta_path(dir: &Path) -> PathBuf {
    dir.join(".meta.json")
}

/// Read the authorship sidecar. Tolerant: a missing or malformed file just means
/// "no authorship known" (empty map), never an error.
fn read_meta(dir: &Path) -> Meta {
    std::fs::read_to_string(meta_path(dir))
        .ok()
        .and_then(|raw| serde_json::from_str::<Meta>(&raw).ok())
        .unwrap_or_default()
}

fn stamp_meta(dir: &Path, section: BriefSection, by: LastEditedBy, at: i64) -> Result<(), TicketError> {
    let mut meta = read_meta(dir);
    meta.insert(section.key().to_string(), SectionMeta { by, at });
    let raw = serde_json::to_string_pretty(&meta).map_err(|e| TicketError::Serde(e.to_string()))?;
    write_atomic(&meta_path(dir), raw.as_bytes())?;
    Ok(())
}

// ── low-level fs helpers ─────────────────────────────────────────────────────

/// Read a file as `(content, mtime_ms)`, or `None` when it is missing / not a
/// regular file. Any other io error propagates.
fn read_file_opt(path: &Path) -> io::Result<Option<(String, i64)>> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => {
            let content = std::fs::read_to_string(path)?;
            Ok(Some((content, mtime_ms(&meta).unwrap_or(0))))
        }
        Ok(_) => Ok(None),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

/// Write via a sibling `.tmp` + rename so a concurrent reader/watcher never
/// observes a half-written file (mirrors the contract-file write in
/// `publish_contract`).
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        (dir, root)
    }

    // ── T2: scaffold ─────────────────────────────────────────────────────────

    #[test]
    fn scaffold_creates_the_full_layout() {
        let (_tmp, root) = repo();
        scaffold_ticket(&root, "ticket-1", "Backend", "do the backend").unwrap();

        let dir = root.join(".phasr").join("tickets").join("ticket-1");
        assert!(dir.join("ticket.md").is_file());
        assert!(dir.join("prd.md").is_file());
        assert!(dir.join("trd.md").is_file());
        assert!(dir.join("figma.json").is_file());
        assert!(dir.join("comments.jsonl").is_file());
        assert!(dir.join("assets").is_dir());
        // ticket.md carries the H1 title + the prompt body.
        let ticket = std::fs::read_to_string(dir.join("ticket.md")).unwrap();
        assert!(ticket.starts_with("# Backend"), "H1 title: {ticket:?}");
        assert!(ticket.contains("do the backend"));
        // figma.json is a valid empty array.
        assert_eq!(std::fs::read_to_string(dir.join("figma.json")).unwrap().trim(), "[]");
        // The local-only authorship sidecar is gitignored.
        let gitignore = std::fs::read_to_string(root.join(".phasr").join("tickets").join(".gitignore")).unwrap();
        assert!(gitignore.contains("**/.meta.json"));
    }

    #[test]
    fn scaffold_is_idempotent_and_preserves_edits() {
        let (_tmp, root) = repo();
        scaffold_ticket(&root, "t", "Title", "desc").unwrap();

        // A human edits prd.md between decompositions.
        let prd = root.join(".phasr").join("tickets").join("t").join("prd.md");
        std::fs::write(&prd, "# real requirements\n").unwrap();

        // Re-scaffold (a re-decompose) must NOT clobber the edited file.
        scaffold_ticket(&root, "t", "Title", "desc").unwrap();
        assert_eq!(std::fs::read_to_string(&prd).unwrap(), "# real requirements\n");
    }

    #[test]
    fn traversal_ids_are_rejected_before_any_fs_touch() {
        let (_tmp, root) = repo();
        for bad in ["..", "../evil", "a/b", "/abs", "", "."] {
            assert!(
                matches!(scaffold_ticket(&root, bad, "t", "d"), Err(TicketError::InvalidTicketId(_))),
                "scaffold accepted a traversal id `{bad}`"
            );
            assert!(matches!(
                read_brief(Some(&root), bad, None),
                Err(TicketError::InvalidTicketId(_))
            ));
            let reg = TicketWriteRegistry::default();
            assert!(matches!(
                write_section(&reg, &root, bad, BriefSection::Prd, "x", None),
                Err(TicketError::InvalidTicketId(_))
            ));
        }
        // Nothing was created under the repo for a rejected id.
        assert!(!root.join(".phasr").exists());
    }

    // ── T4: read ─────────────────────────────────────────────────────────────

    #[test]
    fn read_missing_ticket_is_an_empty_brief_not_an_error() {
        let (_tmp, root) = repo();
        // Never scaffolded — a graceful empty brief keyed by the id.
        let brief = read_brief(Some(&root), "never-made", Some("Fallback Name")).unwrap();
        assert_eq!(brief.ticket_id, "never-made");
        assert_eq!(brief.title, "Fallback Name");
        assert_eq!(brief.description.content, "");
        assert_eq!(brief.description.mtime_ms, None);
        assert_eq!(brief.prd.content, "");
        assert_eq!(brief.comment_count, 0);
    }

    #[test]
    fn read_with_no_local_path_is_an_empty_brief() {
        let brief = read_brief(None, "t", None).unwrap();
        assert_eq!(brief.title, "t"); // falls back to the id when no name given
        assert_eq!(brief.prd.content, "");
    }

    #[test]
    fn read_returns_title_body_and_authorship() {
        let (_tmp, root) = repo();
        scaffold_ticket(&root, "t", "My Ticket", "the description body").unwrap();
        let reg = TicketWriteRegistry::default();
        write_section(&reg, &root, "t", BriefSection::Prd, "PRD content", None).unwrap();

        let brief = read_brief(Some(&root), "t", Some("workspace name")).unwrap();
        // Title from the H1, NOT the fallback.
        assert_eq!(brief.title, "My Ticket");
        // Description is the body only (H1 stripped).
        assert_eq!(brief.description.content, "the description body");
        assert_eq!(brief.prd.content, "PRD content");
        // The section we wrote is stamped "you"; one we never touched is neutral.
        assert_eq!(brief.prd.last_edited_by, Some(LastEditedBy::You));
        assert!(brief.prd.last_edited_at_ms.is_some());
        assert_eq!(brief.trd.last_edited_by, None);
    }

    // ── T4: write round-trip + conflict + hash-assist ────────────────────────

    #[test]
    fn write_round_trips_each_section() {
        let (_tmp, root) = repo();
        scaffold_ticket(&root, "t", "Title", "body").unwrap();
        let reg = TicketWriteRegistry::default();

        for (section, value) in [
            (BriefSection::Description, "new description"),
            (BriefSection::Prd, "new prd"),
            (BriefSection::Trd, "new trd"),
        ] {
            let saved = write_section(&reg, &root, "t", section, value, None).unwrap();
            match saved {
                WriteSectionResult::Saved { section: sc } => assert_eq!(sc.content, value),
                other => panic!("expected Saved, got {other:?}"),
            }
        }
        let brief = read_brief(Some(&root), "t", None).unwrap();
        assert_eq!(brief.description.content, "new description");
        assert_eq!(brief.prd.content, "new prd");
        assert_eq!(brief.trd.content, "new trd");
        // The description write preserved the H1 title.
        assert_eq!(brief.title, "Title");
    }

    #[test]
    fn write_is_create_on_write_for_an_unscaffolded_ticket() {
        let (_tmp, root) = repo();
        let reg = TicketWriteRegistry::default();
        // No scaffold — writing a section still creates the file.
        let saved = write_section(&reg, &root, "fresh", BriefSection::Prd, "hi", None).unwrap();
        assert!(matches!(saved, WriteSectionResult::Saved { .. }));
        assert!(root.join(".phasr/tickets/fresh/prd.md").is_file());
    }

    #[test]
    fn stale_base_mtime_with_a_real_change_is_a_conflict_and_does_not_overwrite() {
        let (_tmp, root) = repo();
        scaffold_ticket(&root, "t", "Title", "body").unwrap();
        let reg = TicketWriteRegistry::default();

        // Establish a baseline write, then simulate an EXTERNAL edit on disk.
        write_section(&reg, &root, "t", BriefSection::Prd, "v1", None).unwrap();
        let prd = root.join(".phasr/tickets/t/prd.md");
        std::fs::write(&prd, "external edit").unwrap();

        // Save "mine" against a stale base (epoch+1 is older than any real mtime).
        let result = write_section(&reg, &root, "t", BriefSection::Prd, "mine", Some(1)).unwrap();
        match result {
            WriteSectionResult::Conflict { on_disk } => {
                assert_eq!(on_disk.content, "external edit");
            }
            other => panic!("expected Conflict, got {other:?}"),
        }
        // The external edit was NOT clobbered.
        assert_eq!(std::fs::read_to_string(&prd).unwrap(), "external edit");
    }

    #[test]
    fn hash_assist_identical_content_on_mtime_bump_saves_without_conflict() {
        let (_tmp, root) = repo();
        scaffold_ticket(&root, "t", "Title", "body").unwrap();
        let reg = TicketWriteRegistry::default();

        write_section(&reg, &root, "t", BriefSection::Prd, "same", None).unwrap();
        // Bump the mtime with byte-IDENTICAL content (an editor rewrite / touch).
        let prd = root.join(".phasr/tickets/t/prd.md");
        std::fs::write(&prd, "same").unwrap();

        // Even with a stale base, identical bytes must NOT raise a spurious
        // conflict — the hash arbitrates over the mtime (architect #2).
        let result = write_section(&reg, &root, "t", BriefSection::Prd, "same", Some(1)).unwrap();
        assert!(
            matches!(result, WriteSectionResult::Saved { .. }),
            "identical content on an mtime bump must save, not conflict"
        );
    }

    #[test]
    fn a_non_stale_write_saves() {
        let (_tmp, root) = repo();
        scaffold_ticket(&root, "t", "Title", "body").unwrap();
        let reg = TicketWriteRegistry::default();

        let first = write_section(&reg, &root, "t", BriefSection::Prd, "v1", None).unwrap();
        let mtime = match first {
            WriteSectionResult::Saved { section } => section.mtime_ms,
            other => panic!("expected Saved, got {other:?}"),
        };
        // Save again with the fresh mtime as the base → not stale → saved.
        let second = write_section(&reg, &root, "t", BriefSection::Prd, "v2", mtime).unwrap();
        assert!(matches!(second, WriteSectionResult::Saved { .. }));
        assert_eq!(read_brief(Some(&root), "t", None).unwrap().prd.content, "v2");
    }

    #[test]
    fn registry_matches_our_last_write_for_the_t7_watcher() {
        let (_tmp, root) = repo();
        scaffold_ticket(&root, "t", "Title", "body").unwrap();
        let reg = TicketWriteRegistry::default();
        write_section(&reg, &root, "t", BriefSection::Prd, "payload", None).unwrap();

        let prd = root.join(".phasr/tickets/t/prd.md");
        let on_disk = std::fs::read(&prd).unwrap();
        // T7 uses this to drop its own-write change events.
        assert!(reg.matches(&prd, &on_disk));
        assert!(!reg.matches(&prd, b"something else"));
    }

    // Pins the FROZEN §C wire shape the fe-developer builds `types.ts` to:
    // section enum lowercase, camelCase fields, and the `WriteSectionResult`
    // tagged union (`kind` + `onDisk`). A drift here breaks every Brief caller.
    #[test]
    fn wire_shapes_match_the_frozen_contract() {
        assert_eq!(serde_json::to_string(&BriefSection::Description).unwrap(), "\"description\"");
        assert_eq!(serde_json::to_string(&BriefSection::Prd).unwrap(), "\"prd\"");
        assert_eq!(serde_json::to_string(&BriefSection::Trd).unwrap(), "\"trd\"");
        assert_eq!(serde_json::to_string(&LastEditedBy::You).unwrap(), "\"you\"");
        assert_eq!(serde_json::to_string(&LastEditedBy::Agent).unwrap(), "\"agent\"");

        let sc = BriefSectionContent {
            content: "x".into(),
            mtime_ms: Some(7),
            last_edited_by: Some(LastEditedBy::You),
            last_edited_at_ms: Some(9),
        };
        let json = serde_json::to_value(&sc).unwrap();
        assert_eq!(json["content"], "x");
        assert_eq!(json["mtimeMs"], 7);
        assert_eq!(json["lastEditedBy"], "you");
        assert_eq!(json["lastEditedAtMs"], 9);

        let saved = serde_json::to_value(WriteSectionResult::Saved { section: sc.clone() }).unwrap();
        assert_eq!(saved["kind"], "saved");
        assert!(saved["section"].is_object());
        let conflict = serde_json::to_value(WriteSectionResult::Conflict { on_disk: sc }).unwrap();
        assert_eq!(conflict["kind"], "conflict");
        assert!(conflict["onDisk"].is_object());
    }

    #[test]
    fn parse_and_compose_ticket_md_round_trip() {
        assert_eq!(parse_ticket_md("# T\n\nbody here"), (Some("T".into()), "body here".into()));
        assert_eq!(parse_ticket_md("no heading here"), (None, "no heading here".into()));
        assert_eq!(compose_ticket_md(Some("T"), "body"), "# T\n\nbody\n");
        assert_eq!(compose_ticket_md(Some("T"), ""), "# T\n");
        assert_eq!(compose_ticket_md(None, "just body"), "just body\n");
    }
}
