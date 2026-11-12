-- Run in Supabase → SQL Editor after migration 0011, and BEFORE releasing a
-- desktop build that ships local migration 0017: that build pushes these
-- columns, and PostgREST rejects an upsert naming a column that doesn't
-- exist (which would stall workspace sync for that build).
--
-- Mirrors the desktop app's 0017_board.sql. Additive only; no CHECKs on
-- outcome / pr_state so a later client can add a value without a lockstep
-- cloud migration.

-- The branch the task's worktree was cut from (its diff base).
alter table public.workspaces add column if not exists base_branch text;
-- Set while a not-yet-launched task waits in the queue.
alter table public.workspaces add column if not exists queued_at timestamptz;
-- Start once this task reaches review. No foreign key on purpose: rows
-- are pushed in no particular order, so a dependent row can arrive before
-- the row it depends on.
alter table public.workspaces add column if not exists depends_on_workspace_id uuid;
-- 'merged' | 'closed' | NULL.
alter table public.workspaces add column if not exists outcome text;
alter table public.workspaces add column if not exists outcome_at timestamptz;
alter table public.workspaces add column if not exists merged_into text;
-- The task's pull request, if one was opened.
alter table public.workspaces add column if not exists pr_number integer;
alter table public.workspaces add column if not exists pr_url text;
alter table public.workspaces add column if not exists pr_state text;
