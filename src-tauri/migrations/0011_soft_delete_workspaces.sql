-- Workspaces are soft-deleted (deleted_at tombstone) like repositories,
-- so a delete propagates to the cloud instead of being re-inserted by the
-- next sync pull. UI reads filter `deleted_at IS NULL`.

ALTER TABLE workspaces ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_workspaces_deleted_at ON workspaces(deleted_at);
