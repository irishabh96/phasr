-- Agent signals: needs-you state, resume, token usage (redesign M6).
--
-- Additive only (see 0015): 0.4.4+ opens a database this migration has
-- touched, and its INSERTs that don't name these columns take the defaults.

-- The agent CLI's own session id (Claude `session_id` from its SessionStart
-- hook), so a stopped task resumes its conversation (`claude --resume <id>`)
-- instead of re-sending the prompt. LOCAL ONLY: a session lives in this
-- machine's ~/.claude, so it is never pushed — another machine can't resume it.
ALTER TABLE workspaces ADD COLUMN agent_session_id TEXT;

-- When the agent last finished a turn (Claude `Stop` hook / Codex
-- `agent-turn-complete`). Synced (cloud migration 0011): the board shows
-- "finished 18m ago" on every device.
ALTER TABLE workspaces ADD COLUMN last_turn_ended_at TEXT;

-- Latest token/cost snapshot per task, read from the agent's own transcript.
-- Local only: transcripts live on this machine, and the snapshot is
-- re-derivable from them. The FK cascade only fires on a hard DELETE
-- (workspaces are soft-deleted); the row is harmless until then.
CREATE TABLE task_usage (
    workspace_id TEXT PRIMARY KEY NOT NULL
        REFERENCES workspaces(id) ON DELETE CASCADE,
    -- 'claude' | 'codex': which transcript format it came from.
    source TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    -- Millionths of a USD; NULL when any model used has no known price.
    cost_usd_micros INTEGER,
    transcript_path TEXT,
    updated_at TEXT NOT NULL
);
