-- Multi-agent task board (P0 thin vertical slice, E1-T1). Additive + nullable,
-- mirroring 0012_workspace_interrupted_at.sql: every existing row is untouched
-- and defaults NULL, so a v0.2.4 DB migrates with zero data changes.
--
-- A `parent` workspace decomposes into `subtask` workspaces (both are just new
-- `workspace_kind` strings — no enum migration needed). `parent_id`/`role` tie
-- a subtask back to its parent and to its slot in the decomposition; both are
-- NULL for every existing standalone `agent`/`local` row.
--
-- NO `integration_branch` column: at integration the parent row REUSES its own
-- existing `branch`/`worktree_path` (spec B1 / §H-4), so the whole conflict +
-- combined-diff surface works against the parent workspace_id with zero new
-- columns.
--
-- Machine-local by construction: the sync push filter already hard-filters
-- `workspace_kind = 'agent'` (sync/mod.rs::dirty_workspace_rows), so `parent`/
-- `subtask` rows AND both new tables never appear in a sync SELECT/INSERT list
-- and require no sync change (spec claim #11). Logical FKs only (no REFERENCES),
-- matching the never-synced style of these board-only tables.

ALTER TABLE workspaces ADD COLUMN parent_id TEXT;
ALTER TABLE workspaces ADD COLUMN role TEXT;

CREATE INDEX idx_workspaces_parent ON workspaces(parent_id);

-- DAG edges: `from_subtask_id` (the producer) must publish a contract before
-- `to_subtask_id` (the dependent) is allowed to spawn. Whether an edge is
-- *satisfied* is DERIVED at read time by joining this table against
-- workspace_contracts (spec claim #10) — deliberately NOT a stored flag, so
-- board state never lives in a persisted column.
CREATE TABLE workspace_dependencies (
    id              TEXT PRIMARY KEY,
    parent_id       TEXT NOT NULL,
    from_subtask_id TEXT NOT NULL,
    to_subtask_id   TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE INDEX idx_workspace_dependencies_parent ON workspace_dependencies(parent_id);

-- Contract publications: the file→DB bridge. A row appears when a subtask's
-- contract file is published (`published_at` stamped). A dependent's incoming
-- edge counts as satisfied once its producer has a row here with `published_at`
-- set — the ONLY completion signal (process exit != task done, spec §0.1).
CREATE TABLE workspace_contracts (
    id            TEXT PRIMARY KEY,
    parent_id     TEXT NOT NULL,
    subtask_id    TEXT NOT NULL,
    role          TEXT NOT NULL,
    contract_path TEXT NOT NULL,
    published_at  TEXT,
    created_at    TEXT NOT NULL
);

CREATE INDEX idx_workspace_contracts_parent ON workspace_contracts(parent_id);
