-- Repository-scoped notes. Notes belong to the REPOSITORY, not to the
-- workspace/terminal they were typed in, so they survive workspace
-- deletion and are readable from every surface of the repo.
--
-- Provenance (origin_*) is a DENORMALIZED SNAPSHOT, not a foreign key:
-- ad-hoc terminals have no DB row at all (in-memory TaskRuntime map),
-- and workspaces are HARD-deleted when their repository is removed —
-- any FK flavor (SET NULL / CASCADE / RESTRICT) would destroy or block
-- exactly the provenance we want to preserve. origin_workspace_id /
-- origin_terminal_id are best-effort deep links only; the label and
-- name snapshots are what the UI renders forever.
--
-- Lifecycle: user delete AND repository removal both soft-delete
-- (deleted_at). Notes are the deliberate exception to the hard-delete
-- child policy in RepositoryRepo::delete. There is no expiry and no
-- cleanup job — "a note remains forever" is a requirement.
--
-- synced_at / dirty exist for schema parity with the other syncable
-- tables so wiring notes into sync/mod.rs later is purely additive;
-- notes are NOT cloud-synced in v1 (they may contain pasted secrets).

CREATE TABLE repository_notes (
    id                    TEXT PRIMARY KEY,
    user_id               TEXT REFERENCES users(id),
    repository_id         TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    body                  TEXT NOT NULL,
    origin_kind           TEXT NOT NULL DEFAULT 'repository',
    origin_workspace_id   TEXT,
    origin_workspace_name TEXT,
    origin_terminal_id    TEXT,
    origin_label          TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    deleted_at            TEXT,
    synced_at             TEXT,
    dirty                 INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_repository_notes_repo
    ON repository_notes(repository_id, created_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_repository_notes_user ON repository_notes(user_id);
CREATE INDEX idx_repository_notes_deleted_at
    ON repository_notes(deleted_at)
    WHERE deleted_at IS NOT NULL;
