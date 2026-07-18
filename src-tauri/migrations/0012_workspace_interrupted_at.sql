-- Honest status (Step 0 / E0): a persisted marker that a `running` agent
-- was orphaned by an app relaunch — its in-process PTY child died with the
-- old process, so the row is stale, not genuinely working.
--
-- `recover_startup_state` sets this alongside the existing Running→Stopped
-- boot sweep. Without it a relaunch-orphan is indistinguishable from a calm
-- user `stop_task`: both land `stopped` + `finished_at` and both leave
-- `exit_code = NULL`. This one nullable column is the discriminator the
-- frontend needs to render an honest "was interrupted" (Wedged) instead of
-- a silent Stopped or a red Failed.
--
-- Machine-local, exactly like `worktree_path`: an orphan on THIS machine is
-- not an orphan on another, so it is deliberately kept OUT of the sync
-- column lists (`sync/mod.rs`) and never round-trips through the cloud.
-- Additive + nullable, mirroring 0011_soft_delete_workspaces.sql: existing
-- rows default NULL and are untouched.

ALTER TABLE workspaces ADD COLUMN interrupted_at TEXT;
