-- Run in Supabase → SQL Editor after migration 0010, and BEFORE releasing a
-- desktop build that ships local migration 0016: that build pushes this
-- column, and PostgREST rejects an upsert naming a column that doesn't
-- exist (which would stall workspace sync for that build).
--
-- Mirrors the synced half of the desktop app's 0016_agent_signals.sql.
-- `agent_session_id` and the `task_usage` table are deliberately NOT
-- mirrored: both are machine-local (a Claude session / transcript only
-- exists on the machine that ran it).

-- When the agent last finished a turn. NULL = never (or before M6).
alter table public.workspaces
    add column if not exists last_turn_ended_at timestamptz;
