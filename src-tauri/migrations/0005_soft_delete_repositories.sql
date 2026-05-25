-- Soft-delete for repositories.
--
-- `delete_repository` was a hard DELETE that cascade-removed every
-- child (workspaces, repository_config, run_commands). Two problems:
--   1. The orchestrator + legacy runtime held the deleted workspaces'
--      PTY handles in memory, so the agents kept running even though
--      the rows were gone.
--   2. Cloud sync's bootstrap pull re-inserted the row whenever the
--      cloud delete hadn't propagated before the app was closed.
--
-- The fix is a tombstone column on this same table. `delete_repository`
-- now hard-deletes the children (FK cascade doesn't fire on UPDATE),
-- soft-deletes the parent (sets `deleted_at`), and marks it dirty so
-- the next cloud-sync push completes the deletion remotely. Every
-- list/get query filters `deleted_at IS NULL`.

ALTER TABLE repositories ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_repositories_deleted_at
    ON repositories(deleted_at)
    WHERE deleted_at IS NOT NULL;
