-- Run in Supabase → SQL Editor after migration 0009, and BEFORE releasing a
-- desktop build that ships local migration 0015: that build pushes these
-- columns, and PostgREST rejects an upsert naming a column that doesn't
-- exist (which would stall workspace + settings sync for that build).
--
-- Mirrors the desktop app's migration 0015_permission_modes.sql. Additive
-- only; no CHECK on permission_mode so a later client can add a mode
-- without a lockstep cloud migration.

-- NULL = a workspace from before permission modes (launched skip-all).
alter table public.workspaces add column if not exists permission_mode text;
alter table public.workspaces
    add column if not exists notify_on_attention boolean not null default true;

-- User decision: new tasks default to "Ask for shell", existing users too.
alter table public.user_settings
    add column if not exists default_permission_mode text not null default 'ask-shell';
-- agent id -> launch command template override.
alter table public.user_settings
    add column if not exists agent_commands jsonb not null default '{}'::jsonb;
