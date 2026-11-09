-- Review: checks, diff comments, run commands in the task worktree (redesign M8).
--
-- Additive only (see 0015): 0.4.4+ opens a database this migration has
-- touched, and its INSERTs that don't name these columns take the defaults.

-- When a run command starts on its own: 'manual' | 'task_start' |
-- 'before_review'. No CHECK, so a later client can add a trigger without a
-- lockstep migration (this build reads an unknown value as 'manual').
-- Synced (cloud migration 0013).
ALTER TABLE run_commands ADD COLUMN run_when TEXT NOT NULL DEFAULT 'manual';
-- Watch the command's output for a dev-server port ("dev · :3000"). Synced.
ALTER TABLE run_commands ADD COLUMN detect_port INTEGER NOT NULL DEFAULT 0;
-- A passing run on the task's current state is required before "Approve &
-- create PR" (overridable). Synced.
ALTER TABLE run_commands ADD COLUMN required_for_approve INTEGER NOT NULL DEFAULT 0;

-- One execution of a run command as a check, in a task's worktree. LOCAL
-- ONLY: output and fingerprints describe this machine's worktree. The FK
-- cascade only fires on a hard DELETE (workspaces are soft-deleted).
-- `run_command_id` has no FK: run commands are hard-deleted and a check's
-- history (name + command are copied in) should outlive them.
CREATE TABLE check_runs (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_command_id TEXT,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    -- queued | running | passed | failed | cancelled | error | timeout
    status TEXT NOT NULL,
    exit_code INTEGER,
    -- sha256 of HEAD + status + diff when the run was queued; a required
    -- check counts only while this equals the worktree's current value.
    fingerprint TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    duration_ms INTEGER,
    -- Last 64 KiB of merged stdout/stderr; the full log is at `log_path`.
    output_tail TEXT NOT NULL DEFAULT '',
    log_path TEXT,
    user_id TEXT
);
CREATE INDEX idx_check_runs_workspace ON check_runs(workspace_id, created_at);

-- Review comments on a task's diff, sent to its agent as one message.
-- LOCAL ONLY (soft-deleted like everything else, but never pushed).
CREATE TABLE review_comments (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT,
    path TEXT NOT NULL,
    line INTEGER NOT NULL,
    -- 'new' | 'old': which side of the diff `line` numbers.
    side TEXT NOT NULL DEFAULT 'new',
    -- The commented line's text when it was written, quoted to the agent
    -- (line numbers drift as the agent edits).
    anchor_text TEXT,
    body TEXT NOT NULL,
    -- pending | sent | resolved
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT,
    resolved_at TEXT,
    deleted_at TEXT
);
CREATE INDEX idx_review_comments_workspace ON review_comments(workspace_id, created_at);
