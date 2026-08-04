# Spec: Repository Notes

**Status:** v1 implemented on `feat/keymap-and-repo-notes` · **Author:** BSA (agent) · **Date:** 2026-08-04

## Objective

Durable, repository-scoped notes. A user jots a note from anywhere inside a repository
(workspace, terminal tab, run-command pane, repo home) and it is visible from **every**
surface of that repository, forever, until they delete it. Each note remembers where and
when it was written.

Workspaces are disposable (archived, deleted, worktrees removed); anything learned while
driving an agent is currently lost with them. Attaching notes to the repository — the one
entity that outlives every workspace — makes phasr the place repo knowledge accumulates.

## User stories

- As a developer running multiple agents against one repository, I want notes that belong
  to the repository, so what I learn in one run is in front of me during the next.
- As a developer reading an old note, I want to see which workspace/terminal it came from
  and when, so I can judge whether it is still true.
- As a developer whose notes drift out of date, I want to edit and delete them.
- As a developer who removes a repository, I want its notes retained behind the scenes
  (soft-deleted), so accidental removal is recoverable and a future restore has data.

## Acceptance criteria (implemented; Given/When/Then in Rust tests)

- **Create + provenance**: a note records `origin_kind` (`workspace|terminal|runCommand|repository`),
  best-effort `origin_workspace_id`/`origin_terminal_id` (NO FK), a server-resolved
  `origin_workspace_name` snapshot, a server-composed `origin_label` (client may supply a
  sanitized display hint like "Terminal 2"), and RFC3339 timestamps. Empty/whitespace bodies
  rejected (`note cannot be empty`); bodies trimmed; cap 50,000 chars (`note is too long…`).
  `create_note` verifies the repository is **alive** via `get_for_user` — the FK alone would
  accept a tombstoned repo.
- **Repository-wide visibility**: one query (`list_notes_for_repository`), ordered
  `created_at DESC, id DESC` (stable tiebreak). Notes of other repositories never appear.
- **Edit**: body-only; `updated_at` advances; `created_at` and all provenance immutable.
  Optional `expected_updated_at` guard → `changed in another window — reload and retry`
  on a concurrent edit (no silent last-write-wins).
- **Delete**: soft only (`deleted_at`); double-delete → `not found`. No hard
  `DELETE FROM repository_notes` exists anywhere (grep-checkable).
- **No expiry**: no TTL, no cleanup job, no retention setting.
- **Repository removal — BOTH paths** (#EXPORT_CRITICAL):
  1. `RepositoryRepo::delete` soft-deletes notes (dirty=1) inside the same tx that
     hard-deletes `run_commands`/`repository_config`/`workspaces`.
  2. The cloud-tombstone mirror in `sync/mod.rs::upsert_repository_from_cloud` soft-deletes
     notes (dirty=0, synced_at=now — mirror semantics) inside the same tx.
  Notes never join the hard-delete child arrays. Idempotent (`deleted_at IS NULL` predicate).
- **Account scoping**: every read and mutating WHERE includes `user_id = ?` (`_for_user`),
  enforced in SQL. Another account gets empty lists and `not found`.

## #PATH_DECISION — provenance is a denormalized snapshot, not an FK

Ad-hoc terminals have no DB row (in-memory `TaskRuntime` map, ids die on quit) and
workspaces are HARD-deleted on repository removal. `SET NULL` would blank provenance,
`CASCADE` would delete the notes, `RESTRICT` would block removal — all wrong. The stored
ids power an optional "jump to origin" that resolves live and renders disabled when the
target is gone; the label/name snapshots render forever. A renamed workspace leaves the
old name on old notes — correct provenance semantics ("written from the workspace then
called X").

## #PLAN_UNCERTAINTY — repository re-add (POPM decision: option A, decided 2026-08-04)

Re-adding a removed repository mints a new uuid; old notes stay tombstoned and invisible.
**Decision: clean slate.** Tombstones stay intact so reattach-on-re-add or a restore
prompt remain possible later without a data migration.

## Out of scope (v1)

Search/filter/sort beyond the fixed order · markdown rendering (plain `pre-wrap` text; no
`dangerouslySetInnerHTML`) · **cloud sync** (notes may contain pasted secrets; `dirty`/
`synced_at` columns exist so wiring is additive, but no pull/push/upsert arms ship) ·
trash/restore UI · pinning/tags/colors · attachments · export/import · sharing ·
reminders/expiry · workspace-private notes · automatic capture · re-add reattachment.

## Implementation map

| Piece | Location |
|---|---|
| Migration | `src-tauri/migrations/0012_repository_notes.sql` |
| Domain | `src-tauri/src/domain/note.rs` (`Note`, `NoteOriginKind`, camelCase wire) |
| Store | `src-tauri/src/store/notes.rs` (`NoteRepo`, `NoteUpdate`, `soft_delete_by_repository(tx, id, mark_synced)`) |
| Commands | `src-tauri/src/commands/notes.rs` (`create_note`, `list_notes_for_repository`, `update_note`, `delete_note`) |
| Delete paths | `store/repositories.rs::delete`, `sync/mod.rs::upsert_repository_from_cloud` |
| IPC 3+1 | `lib.rs` `generate_handler!` + `.manage(NoteRepo)` · `src/lib/tauri.ts` · `src/lib/types.ts` · `e2e/harness.ts` |
| UI (design) | `docs/design/DDR-004-repository-notes.md` — Direction A "Notes Rail" |

Copy-source: the `run_commands` triple ("`RunCommand`, but soft-deleted and with
provenance"). Do NOT apply `patterns_library/` (unsubstituted Prisma/Next.js template).

## Security

`session.require()` first line in all four commands · ownership in SQL, not handlers ·
liveness check on create · bodies stored raw, rendered as text · no cloud transmission in
v1 · note bodies never reach a shell, git argument, or PTY write · errors are plain strings.
