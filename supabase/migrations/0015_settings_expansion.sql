-- Run in Supabase → SQL Editor after migration 0014, and BEFORE releasing a
-- desktop build that ships local migration 0020: that build pushes these
-- columns, and PostgREST rejects an upsert naming a column that doesn't
-- exist (which would stall settings sync for that build).
--
-- Mirrors the desktop app's 0020_settings_expansion.sql (the synced part
-- only — the repository_config columns are local to each machine).

-- '' = the account's login shell.
alter table public.user_settings
    add column if not exists terminal_shell text not null default '';
alter table public.user_settings
    add column if not exists copy_on_select boolean not null default false;
