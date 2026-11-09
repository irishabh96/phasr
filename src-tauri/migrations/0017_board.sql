-- Board, queue and outcomes (redesign M7).
--
-- Additive only (see 0015): 0.4.4+ opens a database this migration has
-- touched, and its INSERTs that don't name these columns take the defaults.
-- Every column is synced (cloud migration 0012) — the board looks the same
-- on every device. No new `status` values: lanes (draft / queued / needs
-- review / done …) are DERIVED from these columns, because an older client
-- would fail to parse an unknown status.

-- The branch the task's worktree was cut from, and what its diff is
-- measured against. NULL = a row from before M7 (the repository's default
-- branch is assumed) or an in-place task (runs on the checkout's branch).
ALTER TABLE workspaces ADD COLUMN base_branch TEXT;

-- Set while a not-yet-launched task waits in the queue. A `pending` row
-- with no branch and no `queued_at` is a draft.
ALTER TABLE workspaces ADD COLUMN queued_at TEXT;

-- Start this queued task once that one reaches review (or is done).
-- Deliberately no FOREIGN KEY: sync can pull a dependent row before the
-- row it depends on, and a deleted dependency must not block the queue.
ALTER TABLE workspaces ADD COLUMN depends_on_workspace_id TEXT;

-- How the task ended: 'merged' | 'closed' | NULL (still open). No CHECK, so
-- a later client can add an outcome without a lockstep migration.
ALTER TABLE workspaces ADD COLUMN outcome TEXT;
ALTER TABLE workspaces ADD COLUMN outcome_at TEXT;
-- The branch a 'merged' task went into ("merged into main").
ALTER TABLE workspaces ADD COLUMN merged_into TEXT;

-- The pull request opened for the task, if any (written from M8 on).
ALTER TABLE workspaces ADD COLUMN pr_number INTEGER;
ALTER TABLE workspaces ADD COLUMN pr_url TEXT;
-- 'open' | 'draft' | 'merged' | 'closed' as last seen.
ALTER TABLE workspaces ADD COLUMN pr_state TEXT;
