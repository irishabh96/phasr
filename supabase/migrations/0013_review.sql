-- Run in Supabase → SQL Editor after migration 0012, and BEFORE releasing a
-- desktop build that ships local migration 0018: that build pushes these
-- columns, and PostgREST rejects an upsert naming a column that doesn't
-- exist (which would stall run-command sync for that build).
--
-- Mirrors the desktop app's 0018_review.sql (the synced part only — check
-- runs and review comments are local). Additive only; no CHECK on run_when
-- so a later client can add a trigger without a lockstep cloud migration.

-- 'manual' | 'task_start' | 'before_review'.
alter table public.run_commands
    add column if not exists run_when text not null default 'manual';
alter table public.run_commands
    add column if not exists detect_port boolean not null default false;
alter table public.run_commands
    add column if not exists required_for_approve boolean not null default false;
